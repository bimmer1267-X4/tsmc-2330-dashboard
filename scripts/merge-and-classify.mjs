// 合併 ADR / 匯率資料（呼叫端透過 WebFetch 交叉比對兩來源後取得，或於未提供參數時
// 自動改用 Yahoo Finance 單一來源抓取，供排程自動化使用）進 data.json，
// 並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價，
// 以及「全年預估EPS」(config.json) 換算的 Forward PE / PEG 分區。
// 同時用近6個月 ADR/匯率/台股歷史資料訓練「ADR隔夜漲跌% → 台股開盤缺口%」OLS迴歸，
// 套用在今天的ADR變動上，機率性推估台股開盤價（含68%/95%信賴區間、上漲機率）。
// 另外會把ADR溢價率逐日累積寫進 data/adr-premium-history.json（永久保留，不像
// data.json只留近6個月滾動視窗），供未來回測溢價率對開盤缺口是否有額外預測力。
// 跨平台版本 (Node.js)，邏輯與 merge-and-classify.ps1 對等。
//
// 用法（手動交叉比對）：
//   node merge-and-classify.mjs --adr-price 424.61 --adr-change-pct 5.55 \
//     --adr-quote-time 2026-07-21T16:00:00-04:00 --usd-twd 32.325 \
//     --fx-quote-time 2026-07-22T08:02:00+08:00
//
// 用法（排程自動化，省略上述參數即自動從 Yahoo Finance 抓取 ADR/匯率）：
//   node merge-and-classify.mjs

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "data.json");
const CONFIG_PATH = join(__dirname, "..", "data", "config.json");
const PREMIUM_HISTORY_PATH = join(__dirname, "..", "data", "adr-premium-history.json");
const YF_UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";
// ADR/匯率序列固定抓1年：「套牢價(ADR近6個月最高)」「ADR歷史相近價位類比估計」這兩個
// 既有功能仍然只看近6個月(用filterSeriesToRecentMonths從這份1年資料裡篩出6個月子集，
// 維持原本的文案與行為不變)，只有「開盤價機率預估」的雙變數迴歸(ADR漲跌%+溢價偏離%)
// 改用完整1年資料訓練，樣本數更多、統計檢定力更足。
const REGRESSION_WINDOW = "1y";
const REGRESSION_WINDOW_MONTHS = 12;
const MIN_REGRESSION_SAMPLES = 20;
const MIN_REGRESSION_SAMPLES_V2 = 60;
// 溢價率「相對自身近期水準」的移動平均天數，用來算「溢價偏離」這個預測變數。
const PREMIUM_ROLL_WINDOW_DAYS = 60;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

// 抓取 Yahoo Finance 每日收盤序列。除了回傳最新報價(price/changePct/quoteTime)，也回傳
// 完整每日收盤序列(series/map)，供「ADR vs 開盤缺口」迴歸訓練使用，避免重複發送請求。
async function fetchYahooDaily(symbol, range = REGRESSION_WINDOW) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": YF_UA } });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`Yahoo Finance 無資料: ${symbol}`);
  const { meta, timestamp = [] } = result;
  const rawCloses = result.indicators?.quote?.[0]?.close ?? [];

  // 用美東時區(ADR/FX主要交易時區)把時間戳轉成交易日期字串，作為序列比對用的 key。
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const series = [];
  const map = new Map();
  for (let i = 0; i < timestamp.length; i++) {
    if (rawCloses[i] == null) continue;
    const dateStr = fmt.format(new Date(timestamp[i] * 1000));
    series.push({ date: dateStr, close: rawCloses[i] });
    map.set(dateStr, rawCloses[i]);
  }

  const price = meta.regularMarketPrice;
  // meta.previousClose 常缺失，meta.chartPreviousClose 則是查詢範圍(range)起點之前的收盤價，
  // 不一定是「前一個交易日」，用它算漲跌%可能落差好幾天而算錯。但也不能單純假設「序列裡
  // 倒數第二筆」就是前一交易日：如果跟regularMarketTime同一天的那筆因為null被排除在series
  // 之外，陣列會整體往前偏移一格，「倒數第二」實際上會變成大前天的收盤價（TAIEX/SOX共用
  // 的fetchYahooIndex就出現過這個問題）。改成明確比對日期：從最新往回找，跳過跟
  // regularMarketTime同一天的項目，取第一個「不同一天」的有效收盤價，確保漲跌%永遠是
  // 真正的逐日比較。
  const latestDateStr = fmt.format(new Date(meta.regularMarketTime * 1000));
  let previousClose = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].date !== latestDateStr) { previousClose = series[i].close; break; }
  }
  if (previousClose == null) previousClose = meta.previousClose ?? meta.chartPreviousClose;
  const changePct = previousClose ? Math.round((price / previousClose - 1) * 10000) / 100 : null;
  const quoteTime = new Date(meta.regularMarketTime * 1000).toISOString();
  return { price, changePct, quoteTime, series, map };
}

// 排程自動化用：單一來源（Yahoo Finance），非人工交叉比對，僅供無法互動時的 fallback。
async function autoFetchAdrAndFx(adrDaily, fxDaily) {
  console.log("未提供 --adr-price/--usd-twd 等參數，改用 Yahoo Finance 自動抓取 ADR(TSM) 與 USD/TWD...");
  return {
    adrPrice: adrDaily.price,
    adrChangePct: adrDaily.changePct,
    adrQuoteTime: adrDaily.quoteTime,
    usdTwd: fxDaily.price,
    fxQuoteTime: fxDaily.quoteTime,
    sources: ["query1.finance.yahoo.com (TSM)"],
    fxSource: "query1.finance.yahoo.com (TWD=X)",
  };
}

function rocToIso(rocDate) {
  // "115/07/21" -> "2026-07-21"
  const [y, m, d] = rocDate.split("/");
  const year = Number(y) + 1911;
  return `${year}-${m}-${d}`;
}

async function fetchTwseJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": YF_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// 抓近N個月的TWSE STOCK_DAY(月度報表)，只取「開盤價機率預估」雙變數迴歸需要的
// date/open/close，不算技術指標——跟update-dashboard.mjs的fetchDaily()是同一套TWSE
// API、同一種逐月請求方式，但那邊固定近6個月是給K線圖/估值分區這些「顯示用」欄位，
// 語意不能隨便改；這裡另外獨立抓一份較長區間，只給統計模型訓練用，兩邊互不影響。
async function fetchTwseDailyRange(months) {
  const daily = [];
  const today = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const dateParam = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`;
    const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=2330`;
    try {
      const resp = await fetchTwseJson(url);
      if (resp.stat === "OK" && resp.data) {
        for (const row of resp.data) {
          daily.push({ date: rocToIso(row[0]), open: Number(String(row[3]).replace(/,/g, "")), close: Number(String(row[6]).replace(/,/g, "")) });
        }
      }
    } catch (e) {
      console.warn(`  STOCK_DAY(${months}個月範圍) ${dateParam} 抓取失敗: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  const seen = new Set();
  return daily
    .filter((d) => Number.isFinite(d.open) && Number.isFinite(d.close))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .filter((d) => (seen.has(d.date) ? false : (seen.add(d.date), true)));
}

// 從一份日期已排序的{date, close, ...}序列裡，篩出「以序列最後一天為基準」往前推N個月
// 的子集——用來在已經抓了1年的ADR/匯率資料時，還原出原本「近6個月」語意的子集合，
// 讓套牢價、ADR歷史相近價位類比估計這兩個既有功能的行為/文案完全不受影響。
function filterSeriesToRecentMonths(series, months) {
  if (series.length === 0) return series;
  const latest = new Date(series[series.length - 1].date + "T00:00:00Z");
  const cutoff = new Date(latest);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return series.filter((s) => s.date >= cutoffStr);
}

// ---- 統計小工具 ----
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function stddev(a) { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); }

function olsRegression(xs, ys) {
  const n = xs.length;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  return { beta, alpha, r, r2: r * r, n };
}

// 二元線性迴歸 y = b0 + b1*x1 + b2*x2（最小平方法，附標準誤/t值/p值/調整後R²），
// 用於「開盤缺口% ~ ADR漲跌% + 溢價偏離%」雙變數模型。用中心化(離均差)平方和/交叉乘積
// 的封閉解算係數，標準誤用(X'X)⁻¹σ²的解析解(2變數情形有簡潔公式，不需要矩陣運算)。
// p值用常態分布近似t分布計算——樣本數在這個模型的最低門檻(MIN_REGRESSION_SAMPLES_V2=60)
// 以上時，自由度動輒50起跳，t分布已經非常接近常態，這個近似不會有實質誤差。
function olsRegression2(xs1, xs2, ys) {
  const n = xs1.length;
  const mx1 = mean(xs1), mx2 = mean(xs2), my = mean(ys);
  let Sx1x1 = 0, Sx2x2 = 0, Sx1x2 = 0, Sx1y = 0, Sx2y = 0, Syy = 0;
  for (let i = 0; i < n; i++) {
    const d1 = xs1[i] - mx1, d2 = xs2[i] - mx2, dy = ys[i] - my;
    Sx1x1 += d1 * d1; Sx2x2 += d2 * d2; Sx1x2 += d1 * d2;
    Sx1y += d1 * dy; Sx2y += d2 * dy; Syy += dy * dy;
  }
  const det = Sx1x1 * Sx2x2 - Sx1x2 * Sx1x2;
  const b1 = (Sx1y * Sx2x2 - Sx2y * Sx1x2) / det;
  const b2 = (Sx2y * Sx1x1 - Sx1y * Sx1x2) / det;
  const b0 = my - b1 * mx1 - b2 * mx2;

  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = b0 + b1 * xs1[i] + b2 * xs2[i];
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = 1 - ssRes / Syy;
  const k = 3; // 截距 + 2個變數
  const dof = n - k;
  const sigma2 = ssRes / dof;
  const seB1 = Math.sqrt((sigma2 * Sx2x2) / det);
  const seB2 = Math.sqrt((sigma2 * Sx1x1) / det);
  const tB1 = b1 / seB1, tB2 = b2 / seB2;
  const pB1 = 2 * (1 - normalCdf(Math.abs(tB1)));
  const pB2 = 2 * (1 - normalCdf(Math.abs(tB2)));
  const adjR2 = 1 - (1 - r2) * (n - 1) / dof;

  return { b0, b1, b2, r2, adjR2, n, dof, seB1, seB2, tB1, tB2, pB1, pB2 };
}

// 標準常態分布 CDF（Abramowitz & Stegun 7.1.26 近似），用來把「預估缺口% / 殘差標準差」
// 換算成「開盤上漲的機率」。
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function nearestOnOrBefore(map, sortedDates, date) {
  let lo = 0, hi = sortedDates.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] <= date) { ans = sortedDates[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans == null ? null : map.get(ans);
}

// ADR溢價率歷史序列，永久保留、逐日累積（不像data.json.daily只保留近6個月滾動視窗，
// 這份會一直長下去），供回測「溢價率相對自身歷史均值的偏離，對台股開盤缺口是否有額外
// 預測力」使用，也是「開盤價機率預估」雙變數模型的訓練資料來源之一。
//
// 時區對應：ADR(美股)的收盤時間換算成台北時間，落在台股「隔天凌晨」——例如美東夏令
// 9:30am-4:00pm(ET)收盤，台北時間是UTC+8、ET(EDT)是UTC-4，換算過去是台北時間晚上
// 9:30到隔天凌晨4:00收盤。所以「美股日期字串D」這根K棒，實際上是在台股「D的隔天」
// 開盤前就已經收盤、屬於已知資訊，正確的配對方式是「ADR日期D → 之後第一個台股交易日
// T」，跟下面buildOpenGapModel()的配對邏輯完全一致(這支function本來就是同一套時區
// 對應規則，這裡沿用而不是另外發明一套)。
//
// 之前的版本誤用「nearestOnOrBefore(adrMap, adrDates, 台股日期)」，也就是找「日期字串
// 小於等於台股日期」的ADR資料——這個方向反了：只要Yahoo後來把「美股日期字串剛好等於
// 台股日期」那根K棒也补進資料(這在回填較舊歷史時幾乎必然發生，因為那根K棒早就收盤、
// 資料已經齊全)，就會被誤判成「日期<=台股日期」而優先命中，實際上配到了時間上晚於台股
// T當天開盤、causally不可能已知的ADR收盤價，變成用未來資訊回推過去，因果順序顛倒。
// 現在改成跟buildOpenGapModel()一樣，用「ADR日期D找之後第一個台股交易日T」的方向，
// 兩邊時區對應邏輯保持一致，也修正了這個回測資料本身的正確性問題。
//
// 假日不對應空值：美股/台股假日行事曆不同步，兩邊都直接用「這個市場有開盤的那些
// 日期」比對(找不到就continue跳過，不會塞null或用0代替)，長假(例如台股連假)會自然
// 對應到假期結束後的下一個台股交易日，不會产生錯誤的1:1單日配對。
async function updateAdrPremiumHistory(twDaily, adrDaily, fxDaily, adrRatio) {
  if (!adrDaily || !fxDaily) {
    console.warn("ADR/匯率歷史序列缺失，略過ADR溢價率歷史紀錄更新");
    return [];
  }
  let history = [];
  try {
    history = JSON.parse(await readFile(PREMIUM_HISTORY_PATH, "utf8"));
  } catch {
    // 檔案不存在(第一次執行)或格式壞掉，視為空歷史，從頭建立
  }
  const byDate = new Map(history.map((h) => [h.date, h]));

  const adrMap = adrDaily.map;
  const adrDates = [...adrMap.keys()].sort();
  const fxMap = fxDaily.map;
  const fxDates = [...fxMap.keys()].sort();

  let touched = 0;
  for (const D of adrDates) {
    const adrClose = adrMap.get(D);
    const fx = nearestOnOrBefore(fxMap, fxDates, D);
    if (fx == null) continue;

    let tIdx = -1;
    for (let j = 0; j < twDaily.length; j++) {
      if (twDaily[j].date > D) { tIdx = j; break; }
    }
    if (tIdx < 0) continue;
    const day = twDaily[tIdx];

    const impliedTwd = round((adrClose / adrRatio) * fx, 2);
    const premiumPct = round(((impliedTwd - day.close) / day.close) * 100, 2);
    byDate.set(day.date, { date: day.date, twClose: day.close, adrClose, usdTwd: fx, adrRatio, impliedTwd, premiumPct, adrDate: D });
    touched++;
  }

  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await writeFile(PREMIUM_HISTORY_PATH, JSON.stringify(merged), "utf8");
  console.log(`已更新ADR溢價率歷史紀錄: ${PREMIUM_HISTORY_PATH}（累計 ${merged.length} 筆，本次範圍內更新 ${touched} 筆）`);
  return merged;
}

// 用近1年 ADR(TSM)/USD-TWD/台股日K，訓練「ADR單日漲跌% → 台股隔日開盤缺口%」OLS迴歸。
// adrSeries/fxSeries: [{date, close}]（date為美東交易日期字串）；twDaily: 近1年台股日K。
function buildOpenGapModel(adrSeries, fxSeries, twDaily) {
  const adrMap = new Map(adrSeries.map((s) => [s.date, s.close]));
  const adrDates = adrSeries.map((s) => s.date);
  const fxMap = new Map(fxSeries.map((s) => [s.date, s.close]));
  const fxDates = fxSeries.map((s) => s.date).sort();
  const adrRatio = 5;

  const pairs = [];
  for (let i = 1; i < adrDates.length; i++) {
    const D = adrDates[i], Dprev = adrDates[i - 1];
    const adrClose = adrMap.get(D), adrClosePrev = adrMap.get(Dprev);
    const adrChangePct = (adrClose / adrClosePrev - 1) * 100;

    const fx = nearestOnOrBefore(fxMap, fxDates, D);
    if (fx == null) continue;

    let tIdx = -1;
    for (let j = 0; j < twDaily.length; j++) {
      if (twDaily[j].date > D) { tIdx = j; break; }
    }
    if (tIdx <= 0) continue;
    const T = twDaily[tIdx], Tprev = twDaily[tIdx - 1];
    const twOpenGapPct = (T.open / Tprev.close - 1) * 100;

    pairs.push({ twDate: T.date, adrChangePct, twOpenGapPct });
  }

  // 同一台股交易日可能對應多個ADR日期（例如週一對應上週五+週末），只留每個台股交易日最後一筆。
  const byTwDate = new Map();
  for (const p of pairs) byTwDate.set(p.twDate, p);
  const uniq = [...byTwDate.values()];
  if (uniq.length < MIN_REGRESSION_SAMPLES) return null;

  const xs = uniq.map((p) => p.adrChangePct), ys = uniq.map((p) => p.twOpenGapPct);
  const reg = olsRegression(xs, ys);
  const residuals = uniq.map((p) => p.twOpenGapPct - (reg.beta * p.adrChangePct + reg.alpha));
  const residualStd = stddev(residuals);
  const hitRate = uniq.filter((p) => Math.sign(p.adrChangePct) === Math.sign(p.twOpenGapPct) && p.adrChangePct !== 0).length / uniq.length;

  return { ...reg, residualStd, hitRate };
}

// 雙變數版本：「ADR單日漲跌% + ADR溢價率偏離近期均值」→ 台股隔日開盤缺口%。
// 配對邏輯(ADR日期D找之後第一個台股交易日T)跟buildOpenGapModel()完全一致，只是多帶一個
// 「溢價偏離」特徵：用T的前一個台股交易日Tprev在premiumHistory裡的溢價率，相對Tprev
// 當時往前rollWindowDays天的移動平均，算出偏離值。刻意用Tprev(T的前一天)而不是T自己的
// 溢價率，是因為T自己的溢價率要等T收盤才算得出來，T開盤當下根本還不存在這個數字，用
// 它來"預測"T的開盤缺口會有look-ahead bias(拿還沒發生的資訊回推)；Tprev收盤時的溢價率
// 在T開盤前就已經是確定的已知資訊，這樣配對才站得住腳。
function buildOpenGapModelV2(adrSeries, fxSeries, twDaily, premiumHistory, rollWindowDays) {
  const adrMap = new Map(adrSeries.map((s) => [s.date, s.close]));
  const adrDates = adrSeries.map((s) => s.date);
  const fxMap = new Map(fxSeries.map((s) => [s.date, s.close]));
  const fxDates = fxSeries.map((s) => s.date).sort();
  const adrRatio = 5;

  const premiumSorted = [...premiumHistory].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const premiumIndexByDate = new Map(premiumSorted.map((h, i) => [h.date, i]));

  const pairs = [];
  for (let i = 1; i < adrDates.length; i++) {
    const D = adrDates[i], Dprev = adrDates[i - 1];
    const adrClose = adrMap.get(D), adrClosePrev = adrMap.get(Dprev);
    const adrChangePct = (adrClose / adrClosePrev - 1) * 100;

    const fx = nearestOnOrBefore(fxMap, fxDates, D);
    if (fx == null) continue;

    let tIdx = -1;
    for (let j = 0; j < twDaily.length; j++) {
      if (twDaily[j].date > D) { tIdx = j; break; }
    }
    if (tIdx <= 0) continue;
    const T = twDaily[tIdx], Tprev = twDaily[tIdx - 1];
    const twOpenGapPct = (T.open / Tprev.close - 1) * 100;

    const pIdx = premiumIndexByDate.get(Tprev.date);
    if (pIdx == null) continue;
    const windowStart = Math.max(0, pIdx - rollWindowDays + 1);
    const window = premiumSorted.slice(windowStart, pIdx + 1).map((h) => h.premiumPct);
    if (window.length < Math.min(rollWindowDays, 20)) continue; // 滾動均值暖機不足，跳過
    const rollMean = mean(window);
    const premiumDev = premiumSorted[pIdx].premiumPct - rollMean;

    pairs.push({ twDate: T.date, adrChangePct, premiumDev, twOpenGapPct });
  }

  const byTwDate = new Map();
  for (const p of pairs) byTwDate.set(p.twDate, p);
  const uniq = [...byTwDate.values()];
  if (uniq.length < MIN_REGRESSION_SAMPLES_V2) return null;

  const xs1 = uniq.map((p) => p.adrChangePct);
  const xs2 = uniq.map((p) => p.premiumDev);
  const ys = uniq.map((p) => p.twOpenGapPct);
  const reg = olsRegression2(xs1, xs2, ys);
  const residuals = uniq.map((p, i) => ys[i] - (reg.b0 + reg.b1 * p.adrChangePct + reg.b2 * p.premiumDev));
  const residualStd = stddev(residuals);
  const hitRate = uniq.filter((p) => Math.sign(p.adrChangePct) === Math.sign(p.twOpenGapPct) && p.adrChangePct !== 0).length / uniq.length;

  return { ...reg, residualStd, hitRate };
}

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

const ANALOG_TOLERANCE_TIERS = [1.5, 2.5, 4, 6];
const ANALOG_MIN_MATCHES = 3;

// 歷史相近ADR價位類比法：今天ADR收盤價為X，在近6個月歷史中找ADR收盤價與X相差在容忍度內的
// 交易日，取當時的匯率換算台股價、以及對應台股交易日的開盤價，最後取這些開盤價的平均值，
// 當作「開盤價機率預估」(OLS迴歸)之外的另一種類比估計。容忍度由窄到寬逐級嘗試，確保至少
// 抓到 ANALOG_MIN_MATCHES 筆比對，避免股價創新高/新低時完全找不到歷史相近值。
function matchAtTolerance(todayAdrPrice, adrSeries, fxSeries, twDaily, tolerancePct) {
  const adrDates = adrSeries.map((s) => s.date).sort();
  const adrMap = new Map(adrSeries.map((s) => [s.date, s.close]));
  const fxMap = new Map(fxSeries.map((s) => [s.date, s.close]));
  const fxDates = fxSeries.map((s) => s.date).sort();
  const todayDate = adrDates[adrDates.length - 1];

  const matches = [];
  for (const D of adrDates) {
    if (D === todayDate) continue; // 排除今天自己
    const adrClose = adrMap.get(D);
    const diffPct = (adrClose / todayAdrPrice - 1) * 100;
    if (Math.abs(diffPct) > tolerancePct) continue;

    const fx = nearestOnOrBefore(fxMap, fxDates, D);
    if (fx == null) continue;

    let tIdx = -1;
    for (let j = 0; j < twDaily.length; j++) {
      if (twDaily[j].date > D) { tIdx = j; break; }
    }
    if (tIdx < 0) continue;
    const T = twDaily[tIdx];

    matches.push({
      adrDate: D,
      adrPrice: round(adrClose, 2),
      diffPct: round(diffPct, 2),
      fxRate: round(fx, 3),
      impliedTwd: round((adrClose / 5) * fx, 2),
      twDate: T.date,
      twOpen: T.open,
    });
  }

  // 同一台股交易日可能對應多個ADR日期，只留每個台股交易日最後一筆。
  const byTwDate = new Map();
  for (const m of matches) byTwDate.set(m.twDate, m);
  return [...byTwDate.values()].sort((a, b) => (a.twDate < b.twDate ? -1 : 1));
}

function findAnalogMatches(todayAdrPrice, adrSeries, fxSeries, twDaily) {
  let best = [];
  let usedTolerance = ANALOG_TOLERANCE_TIERS[ANALOG_TOLERANCE_TIERS.length - 1];
  for (const tolerancePct of ANALOG_TOLERANCE_TIERS) {
    const uniq = matchAtTolerance(todayAdrPrice, adrSeries, fxSeries, twDaily, tolerancePct);
    best = uniq;
    usedTolerance = tolerancePct;
    if (uniq.length >= ANALOG_MIN_MATCHES) break;
  }
  if (best.length === 0) return null;
  const avgTwOpen = round(mean(best.map((m) => m.twOpen)), 2);
  return { tolerancePct: usedTolerance, todayAdrPrice: round(todayAdrPrice, 2), matches: best, avgTwOpen, count: best.length };
}

function classifyZone(pe, rsi, premiumPct, atSixMonthHigh, nearBbLower, nearMa60, peLabel) {
  const reasons = [];
  if (pe > 28) reasons.push(`${peLabel} ${pe.toFixed(1)} 倍 > 28倍上緣`);
  if (rsi !== null && rsi > 75) reasons.push(`RSI ${rsi.toFixed(1)} 超買(>75)`);
  if (premiumPct > 12) reasons.push(`ADR溢價 ${premiumPct}% > 12%`);
  if (atSixMonthHigh && pe > 24) reasons.push("股價貼近6個月高點且評價不便宜");

  let zone;
  if (reasons.length > 0) {
    zone = "超貴價";
  } else if (pe < 20 || (nearBbLower && pe < 22)) {
    zone = "便宜價";
    reasons.push(pe < 20 ? `${peLabel} ${pe.toFixed(1)} 倍 < 20倍` : `價格貼近布林下軌且${peLabel}<22`);
  } else if (pe >= 20 && pe <= 24 && nearMa60 && premiumPct < 8) {
    zone = "甜甜價";
    reasons.push(`${peLabel} 落在20~24倍，價格靠近MA60支撐，ADR溢價未過熱`);
  } else {
    zone = "正常";
    reasons.push(`${peLabel} ${pe.toFixed(1)} 倍落在24~28倍區間，未觸發便宜或超貴條件`);
  }
  return { zone, reasons };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let adrPrice = Number(args["adr-price"]);
  let adrChangePct = Number(args["adr-change-pct"]);
  let adrQuoteTime = args["adr-quote-time"];
  let usdTwd = Number(args["usd-twd"]);
  let fxQuoteTime = args["fx-quote-time"];
  const adrRatio = Number(args["adr-ratio"] ?? 5);
  let sources = ["stockanalysis.com", "finance.yahoo.com"];
  let fxSource = "tw.stock.yahoo.com USDTWD=X";

  // 近1年 ADR/匯率歷史序列：無論今天的ADR/匯率是手動交叉比對還是自動抓取，都需要
  // 這份歷史資料來訓練「ADR vs 台股開盤缺口」迴歸模型，所以固定抓取。套牢價、ADR歷史
  // 相近價位類比估計這兩個既有功能仍然只看近6個月，稍後會從這份1年資料篩出6個月子集
  // 給它們用，行為/文案完全不變。
  let adrDaily = null, fxDaily = null;
  try {
    [adrDaily, fxDaily] = await Promise.all([fetchYahooDaily("TSM"), fetchYahooDaily("TWD=X")]);
  } catch (e) {
    console.warn("抓取 ADR/匯率近1年歷史序列失敗，將略過開盤價機率預估: " + e.message);
  }

  if (!adrPrice || !adrQuoteTime || !usdTwd || !fxQuoteTime) {
    if (!adrDaily || !fxDaily) {
      console.error("缺少必要參數且自動抓取失敗：--adr-price --adr-change-pct --adr-quote-time --usd-twd --fx-quote-time");
      process.exit(1);
    }
    const auto = await autoFetchAdrAndFx(adrDaily, fxDaily);
    adrPrice = auto.adrPrice;
    adrChangePct = auto.adrChangePct;
    adrQuoteTime = auto.adrQuoteTime;
    usdTwd = auto.usdTwd;
    fxQuoteTime = auto.fxQuoteTime;
    sources = auto.sources;
    fxSource = auto.fxSource;
  }

  const d = JSON.parse(await readFile(DATA_PATH, "utf8"));

  d.adr = {
    price: adrPrice,
    changePct: adrChangePct,
    quoteTime: adrQuoteTime,
    sources,
    ratio: adrRatio,
  };
  d.fxRate = { usdTwd, quoteTime: fxQuoteTime, source: fxSource };

  // 從近1年的ADR/匯率序列篩出近6個月子集，維持「套牢價」「ADR歷史相近價位類比估計」
  // 這兩個既有功能原本的6個月語意不變。
  const adrDaily6mo = adrDaily ? { ...adrDaily, series: filterSeriesToRecentMonths(adrDaily.series, 6) } : null;
  const fxDaily6mo = fxDaily ? { ...fxDaily, series: filterSeriesToRecentMonths(fxDaily.series, 6) } : null;

  // ADR近6個月最高收盤價(美元)。
  if (adrDaily6mo) {
    d.adrSixMonthHighUsd = round(Math.max(...adrDaily6mo.series.map((s) => s.close)), 2);
  }

  // 近1年台股日K（只取date/open/close，供開盤價機率預估雙變數模型訓練用；跟data.json
  // 的daily欄位——那份固定近6個月、給K線圖/估值分區顯示用——是完全獨立的兩份資料，
  // 互不影響）。
  let twDaily1y = [];
  try {
    twDaily1y = await fetchTwseDailyRange(REGRESSION_WINDOW_MONTHS);
  } catch (e) {
    console.warn("抓取近1年台股日K(供開盤價機率預估用)失敗: " + e.message);
  }

  const premiumHistory = await updateAdrPremiumHistory(twDaily1y, adrDaily, fxDaily, adrRatio);

  const impliedTwd = Math.round(((adrPrice / adrRatio) * usdTwd) * 100) / 100;
  const premiumPct = Math.round((((impliedTwd - d.valuation.closePrice) / d.valuation.closePrice) * 100) * 100) / 100;

  const pe = d.valuation.peRatio;
  const rsi = d.latestRsi;
  const lastInd = d.indicators[d.indicators.length - 1];
  const lastClose = d.valuation.closePrice;
  const sixMonthHigh = Math.max(...d.daily.map((x) => x.close));
  const nearBbLower = lastInd.bbLower !== null && lastClose <= lastInd.bbLower * 1.01;
  const nearMa60 = lastInd.ma60 !== null && Math.abs(lastClose - lastInd.ma60) / lastInd.ma60 <= 0.03;
  const atSixMonthHigh = lastClose >= sixMonthHigh * 0.99;

  const trailing = classifyZone(pe, rsi, premiumPct, atSixMonthHigh, nearBbLower, nearMa60, "Trailing PE");

  const ttmEpsImplied = Math.round((lastClose / pe) * 10000) / 10000;
  const zoneThresholds = {
    ttmEpsImplied,
    cheapMax: Math.round(20 * ttmEpsImplied * 10) / 10,
    sweetMax: Math.round(24 * ttmEpsImplied * 10) / 10,
    normalMax: Math.round(28 * ttmEpsImplied * 10) / 10,
  };

  d.adrImpliedTwd = impliedTwd;
  d.adrPremiumPct = premiumPct;
  d.valuationZone = trailing.zone;
  d.valuationReasons = trailing.reasons;
  d.zoneThresholds = zoneThresholds;
  d.technicalFlags = { rsi14: rsi, premiumPct, atSixMonthHigh, nearBbLower, nearMa60 };

  // ---- 官方全年預估EPS（來自 config.json，可請Claude更新） ----
  // epsInfo可能因t187ap14_L換季空窗期抓不到而是null(見update-dashboard.mjs的
  // fetchEpsInfo)，這種情況下無法算上半年實際EPS，整個官方預估區塊直接略過。
  try {
    if (!d.epsInfo) throw new Error("epsInfo為null(季度EPS抓取失敗或換季空窗期)");
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    const epsFullYear = cfg.forecastEpsFullYear;

    let h1Actual = 0;
    if (String(d.epsInfo.season) === "1") h1Actual += Number(d.epsInfo.eps);
    for (const q of cfg.supplementalQuarterlyEps ?? []) {
      if (q.season === 2) h1Actual += Number(q.eps);
    }
    const impliedH2 = Math.round((epsFullYear - h1Actual) * 100) / 100;
    const impliedFullYearGrowthPct = Math.round((epsFullYear / cfg.priorYearFullEps - 1) * 1000) / 10;
    const impliedH2GrowthPct = Math.round((impliedH2 / cfg.priorYearH2Eps - 1) * 1000) / 10;
    const h1ActualGrowthPct = Math.round((h1Actual / cfg.priorYearH1Eps - 1) * 1000) / 10;

    const forwardPE = Math.round((lastClose / epsFullYear) * 100) / 100;
    const peg = impliedFullYearGrowthPct > 0 ? Math.round((forwardPE / impliedFullYearGrowthPct) * 100) / 100 : null;

    const forward = classifyZone(forwardPE, rsi, premiumPct, atSixMonthHigh, nearBbLower, nearMa60, "Forward PE");
    const forwardThresholds = {
      cheapMax: Math.round(20 * epsFullYear * 10) / 10,
      sweetMax: Math.round(24 * epsFullYear * 10) / 10,
      normalMax: Math.round(28 * epsFullYear * 10) / 10,
    };

    let growthGapWarning = null;
    if (Math.abs(impliedH2GrowthPct - h1ActualGrowthPct) > 25) {
      growthGapWarning = `您輸入的全年預估EPS ${epsFullYear} 元，隱含下半年年增率 ${impliedH2GrowthPct}%，與上半年實際年增率 ${h1ActualGrowthPct}% 落差達 ${Math.abs(impliedH2GrowthPct - h1ActualGrowthPct).toFixed(1)} 個百分點，請確認此預估是否合理`;
    }

    d.officialForecast = {
      epsFullYear,
      forecastSource: cfg.forecastSource,
      priorYearFullEps: cfg.priorYearFullEps,
      priorYearH1Eps: cfg.priorYearH1Eps,
      priorYearH2Eps: cfg.priorYearH2Eps,
      h1ActualEps: Math.round(h1Actual * 100) / 100,
      impliedH2Eps: impliedH2,
      impliedFullYearGrowthPct,
      h1ActualGrowthPct,
      impliedH2GrowthPct,
      forwardPE,
      peg,
      zone: forward.zone,
      reasons: forward.reasons,
      thresholds: forwardThresholds,
      growthGapWarning,
      updatedAt: cfg.updatedAt,
    };
  } catch (e) {
    console.warn("config.json 讀取或計算失敗，略過官方預估區塊: " + e.message);
  }

  // ---- 台股開盤價機率預估（依近1年「ADR漲跌% + ADR溢價偏離%」雙變數迴歸模型） ----
  // 優先用雙變數模型(多帶溢價偏離這個參數)；如果溢價歷史還不夠長(剛好卡在移動平均
  // 暖機期、樣本數不足MIN_REGRESSION_SAMPLES_V2)，退回只用ADR漲跌%的單變數模型，
  // 不要整張卡片直接消失——這個退回路徑理論上只有在資料還在累積的最初期間才會用到，
  // 這次1年回填後樣本數已經足夠，正常情況下應該都會走雙變數模型。
  if (adrDaily && fxDaily) {
    try {
      const model2 = twDaily1y.length > 0
        ? buildOpenGapModelV2(adrDaily.series, fxDaily.series, twDaily1y, premiumHistory, PREMIUM_ROLL_WINDOW_DAYS)
        : null;

      if (model2) {
        const premiumHistorySorted = [...premiumHistory].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const latestPremium = premiumHistorySorted[premiumHistorySorted.length - 1];
        const rollWindow = premiumHistorySorted.slice(Math.max(0, premiumHistorySorted.length - PREMIUM_ROLL_WINDOW_DAYS)).map((h) => h.premiumPct);
        const premiumDevNow = latestPremium.premiumPct - mean(rollWindow);

        const predictedGapPct = model2.b0 + model2.b1 * adrChangePct + model2.b2 * premiumDevNow;
        const base = d.valuation.closePrice;
        const priceAt = (gapPct) => round(base * (1 + gapPct / 100), 2);
        const probUpPct = round(normalCdf(predictedGapPct / model2.residualStd) * 100, 1);
        const confidenceIndexPct = round(Math.max(0, model2.adjR2) * 100, 1);

        d.openPrediction = {
          predictedGapPct: round(predictedGapPct, 2),
          predictedOpen: priceAt(predictedGapPct),
          ci68: { low: priceAt(predictedGapPct - model2.residualStd), high: priceAt(predictedGapPct + model2.residualStd) },
          ci95: { low: priceAt(predictedGapPct - 1.96 * model2.residualStd), high: priceAt(predictedGapPct + 1.96 * model2.residualStd) },
          probUpPct,
          basisAdrChangePct: adrChangePct,
          basisPremiumDevPct: round(premiumDevNow, 2),
          basisPrevClose: base,
          model: {
            method: "OLS雙變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離%）",
            interceptB0: round(model2.b0, 4),
            adrChangeCoefB1: round(model2.b1, 4),
            premiumDevCoefB2: round(model2.b2, 4),
            r2: round(model2.r2, 4),
            adjR2: round(model2.adjR2, 4),
            tAdrChange: round(model2.tB1, 2),
            tPremiumDev: round(model2.tB2, 2),
            pAdrChange: round(model2.pB1, 4),
            pPremiumDev: round(model2.pB2, 4),
            residualStd: round(model2.residualStd, 4),
            hitRatePct: round(model2.hitRate * 100, 1),
            sampleSize: model2.n,
            windowMonths: REGRESSION_WINDOW_MONTHS,
            premiumRollWindowDays: PREMIUM_ROLL_WINDOW_DAYS,
            confidenceIndexPct,
          },
        };
        console.log(`開盤價機率預估(雙變數): 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（調整後R²=${model2.adjR2.toFixed(3)}, n=${model2.n}, 溢價偏離t值=${model2.tB2.toFixed(2)}）`);
      } else {
        // 雙變數模型樣本數不足，退回單變數模型(僅ADR漲跌%)。
        const model = buildOpenGapModel(adrDaily.series, fxDaily.series, twDaily1y.length > 0 ? twDaily1y : d.daily);
        if (model) {
          const predictedGapPct = model.beta * adrChangePct + model.alpha;
          const base = d.valuation.closePrice;
          const priceAt = (gapPct) => round(base * (1 + gapPct / 100), 2);
          const probUpPct = round(normalCdf(predictedGapPct / model.residualStd) * 100, 1);

          d.openPrediction = {
            predictedGapPct: round(predictedGapPct, 2),
            predictedOpen: priceAt(predictedGapPct),
            ci68: { low: priceAt(predictedGapPct - model.residualStd), high: priceAt(predictedGapPct + model.residualStd) },
            ci95: { low: priceAt(predictedGapPct - 1.96 * model.residualStd), high: priceAt(predictedGapPct + 1.96 * model.residualStd) },
            probUpPct,
            basisAdrChangePct: adrChangePct,
            basisPrevClose: base,
            model: {
              method: "OLS單變數迴歸（開盤缺口% ~ ADR漲跌%，溢價率樣本數不足時的退回版本）",
              beta: round(model.beta, 4),
              alpha: round(model.alpha, 4),
              r2: round(model.r2, 4),
              residualStd: round(model.residualStd, 4),
              hitRatePct: round(model.hitRate * 100, 1),
              sampleSize: model.n,
              windowMonths: REGRESSION_WINDOW_MONTHS,
            },
          };
          console.log(`開盤價機率預估(單變數退回): 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（R²=${model.r2.toFixed(2)}, n=${model.n}）`);
        } else {
          console.warn(`雙變數與單變數模型可用樣本數都不足，略過開盤價機率預估`);
        }
      }
    } catch (e) {
      console.warn("開盤價機率預估計算失敗，略過: " + e.message);
    }
  }

  // ---- ADR歷史相近價位類比估計 ----
  if (adrDaily6mo && fxDaily6mo) {
    try {
      const analog = findAnalogMatches(adrPrice, adrDaily6mo.series, fxDaily6mo.series, d.daily);
      if (analog) {
        d.adrAnalogMatches = analog;
        console.log(`歷史相近ADR價位比對: ${analog.count}筆 (±${analog.tolerancePct}%)  平均對應台股開盤價: ${analog.avgTwOpen}`);
      } else {
        console.warn("近6個月無相近ADR價位可比對，略過類比估計");
      }
    } catch (e) {
      console.warn("歷史相近ADR價位比對計算失敗，略過: " + e.message);
    }
  }

  await writeFile(DATA_PATH, JSON.stringify(d), "utf8");
  console.log(`ADR換算價: ${impliedTwd}  溢價: ${premiumPct}%  Trailing分區: ${trailing.zone}`);
  console.log(trailing.reasons.join("; "));
  console.log(`Trailing分區價格門檻: 便宜<${zoneThresholds.cheapMax} 甜甜<${zoneThresholds.sweetMax} 正常<${zoneThresholds.normalMax} 超貴>=${zoneThresholds.normalMax}`);
  if (d.officialForecast) {
    console.log(`Forward PE: ${d.officialForecast.forwardPE}  PEG: ${d.officialForecast.peg}  Forward分區: ${d.officialForecast.zone}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
