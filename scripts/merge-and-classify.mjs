// 合併 ADR / 匯率資料（呼叫端透過 WebFetch 交叉比對兩來源後取得，或於未提供參數時
// 自動改用 Yahoo Finance 單一來源抓取，供排程自動化使用）進 data.json，
// 並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價，
// 以及「全年預估EPS」(config.json) 換算的 Forward PE / PEG 分區。
// 同時用近1年 ADR/匯率/台股歷史資料訓練「ADR隔夜漲跌% + ADR溢價偏離% + ADR歷史相近價位
// 類比估計缺口%」三變數OLS迴歸，套用在今天的ADR變動/溢價狀態/類比估計上，機率性推估
// 台股開盤價（含68%/95%信賴區間、上漲機率、模型信心指數＝調整後R²）。
// 另外會把ADR溢價率逐日累積寫進 data/adr-premium-history.json（永久保留，不像
// data.json只留近6個月滾動視窗），供未來回測溢價率對開盤缺口是否有額外預測力。
// 同時把每天的開盤價預測、以及後續回填的實際開盤/收盤結果，永久累積寫進
// data/prediction-accuracy-history.json，供長期追蹤模型的方向命中率/誤差(偏誤)/
// 信賴區間覆蓋率是否符合預期，聚合摘要寫進 data.json 的 predictionAccuracySummary。
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
const PREDICTION_HISTORY_PATH = join(__dirname, "..", "data", "prediction-accuracy-history.json");
const TX_NIGHT_HISTORY_PATH = join(__dirname, "..", "data", "taifex-night-history.json");
const YF_UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";
// ADR/匯率序列固定抓1年：「套牢價(ADR近6個月最高)」「ADR歷史相近價位類比估計」這兩個
// 既有功能仍然只看近6個月(用filterSeriesToRecentMonths從這份1年資料裡篩出6個月子集，
// 維持原本的文案與行為不變)，只有「開盤價機率預估」的雙變數迴歸(ADR漲跌%+溢價偏離%)
// 改用完整1年資料訓練，樣本數更多、統計檢定力更足。
const REGRESSION_WINDOW = "1y";
const REGRESSION_WINDOW_MONTHS = 12;
const MIN_REGRESSION_SAMPLES = 20;
const MIN_REGRESSION_SAMPLES_V2 = 60;
const MIN_REGRESSION_SAMPLES_V3 = 80;
const MIN_REGRESSION_SAMPLES_V4 = 80;
// 溢價率「相對自身近期水準」的移動平均天數，用來算「溢價偏離」這個預測變數。
const PREMIUM_ROLL_WINDOW_DAYS = 60;
// 開盤價預測準確度追蹤：統計區間樣本數低於這個門檻就不顯示(避免早期少量樣本產生誤導性
// 統計)；前端折線圖只取最近這麼多筆已解析的紀錄(有界，不讓data.json隨資料庫無限增肥)；
// 資料庫是空檔案時，用「最近這麼多個」歷史訓練配對回溯種一批初始樣本，讓卡片一上線就有
// 資料可看，不用真的等一整週。
const MIN_ACCURACY_SAMPLES = 10;
const ACCURACY_RECENT_SERIES_LIMIT = 240;
const ACCURACY_SEED_COUNT = 15;

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

// 高斯-喬丹消去法求反矩陣，供 olsRegressionN 算 (X'X)⁻¹ 用。
function invertMatrix(M) {
  const p = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < p; col++) {
    let pivot = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const pv = A[col][col];
    for (let c = 0; c < 2 * p; c++) A[col][c] /= pv;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = 0; c < 2 * p; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row.slice(p));
}

// 通用矩陣版 OLS（任意變數數，含截距），用於三變數模型（開盤缺口% ~ ADR漲跌% + 溢價偏離%
// + ADR歷史相近價位類比估計缺口%）。olsRegression/olsRegression2 是手推的封閉解，只適用
// 剛好1或2個變數；再加第3個變數硬推封閉解會變得很繁瑣，改用矩陣運算(X為n×p設計矩陣，
// 第一欄全為1即截距)的話不管未來加幾個變數都是同一套邏輯，不用每次重新手推公式。
// X: [[1, x1, x2, ...], ...]；y: [...]。回傳係數/標準誤/t值/p值都是跟X欄位順序對齊的陣列。
function olsRegressionN(X, y) {
  const n = X.length, p = X[0].length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invertMatrix(XtX);
  const beta = new Array(p).fill(0);
  for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) beta[a] += inv[a][b] * Xty[b];

  const my = mean(y);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < p; a++) pred += beta[a] * X[i][a];
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const r2 = 1 - ssRes / ssTot;
  const dof = n - p;
  const sigma2 = ssRes / dof;
  const se = beta.map((_, a) => Math.sqrt(sigma2 * inv[a][a]));
  const t = beta.map((b, a) => b / se[a]);
  const p_ = t.map((tt) => 2 * (1 - normalCdf(Math.abs(tt))));
  const adjR2 = 1 - (1 - r2) * (n - 1) / dof;
  return { beta, se, t, p: p_, r2, adjR2, n, dof };
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

// 把 d.openPrediction（三/雙/單變數三種形狀之一）攤平成「開盤價預測準確度追蹤」歷史紀錄
// 的固定schema。basisPremiumDevPct/basisAnalogGapPct/confidenceIndexPct在單變數(甚至雙
// 變數)版本可能不存在，用 ?? null 讓欄位形狀固定，方便之後統一讀取，不用每次判斷是哪一層。
// analogMatches(即d.adrAnalogMatches，「ADR歷史相近價位類比估計」卡片本身的資料)是另一
// 個獨立追蹤對象——不是OLS模型的一部分，是同一張卡片上另一種估計方式，所以額外存一份
// analogEstimate，回填時會一併算出這個估計法自己的誤差/命中率，讓使用者能比較兩種方法
// 誰比較準，不是只看模型。
function buildPredictionHistoryEntry(openPrediction, modelTier, predictedDateStr, predictedAt, seeded = false, analogMatches = null) {
  const m = openPrediction.model;
  return {
    date: predictedDateStr,
    predictedAt,
    modelTier,
    predictedGapPct: openPrediction.predictedGapPct,
    predictedOpen: openPrediction.predictedOpen,
    ci68: { low: openPrediction.ci68.low, high: openPrediction.ci68.high },
    ci95: { low: openPrediction.ci95.low, high: openPrediction.ci95.high },
    probUpPct: openPrediction.probUpPct,
    basisAdrChangePct: openPrediction.basisAdrChangePct,
    basisPremiumDevPct: openPrediction.basisPremiumDevPct ?? null,
    basisAnalogGapPct: openPrediction.basisAnalogGapPct ?? null,
    basisTxNightChangePct: openPrediction.basisTxNightChangePct ?? null,
    basisPrevClose: openPrediction.basisPrevClose,
    residualStd: m.residualStd,
    confidenceIndexPct: m.confidenceIndexPct ?? null,
    seeded,
    analogEstimate: analogMatches
      ? { avgTwOpen: analogMatches.avgTwOpen, avgTwOpenAdjusted: analogMatches.avgTwOpenAdjusted ?? null, tolerancePct: analogMatches.tolerancePct, count: analogMatches.count, actual: null }
      : null,
    actual: null,
  };
}

// 依模型層級把訓練配對(pair: {adrChangePct, premiumDev?, analogGapPct?})套進對應的迴歸公式，
// 算出「如果那天用這個(已經擬合好的)模型會預測出的開盤缺口%」——只給「種子回溯」使用，
// 邏輯跟main()裡即時預測套用係數的算法完全一致，只是輸入換成歷史配對而不是「今天」的值。
function predictGapPctForTier(pair, modelTier, model) {
  if (modelTier === 4) {
    const [b0, b1, b2, b3, b4] = model.beta;
    return b0 + b1 * pair.adrChangePct + b2 * pair.premiumDev + b3 * pair.analogGapPct + b4 * pair.txNightChangePct;
  }
  if (modelTier === 3) {
    const [b0, b1, b2, b3] = model.beta;
    return b0 + b1 * pair.adrChangePct + b2 * pair.premiumDev + b3 * pair.analogGapPct;
  }
  if (modelTier === 2) {
    return model.b0 + model.b1 * pair.adrChangePct + model.b2 * pair.premiumDev;
  }
  return model.beta * pair.adrChangePct + model.alpha;
}

// 開盤價預測準確度追蹤：資料庫是空檔案時，借用訓練配對(modelPairs，已經是「用當時已知
// 資訊算出的特徵 vs 實際缺口%」)裡最近ACCURACY_SEED_COUNT筆，套用這次擬合好的模型係數
// 反推出「如果那天這樣預測，結果會是多少」，直接連同已知的實際結果一起寫入，標記
// seeded:true。這樣卡片一上線就有資料可看，不用真的等一整週才有第一筆。
// ⚠️ 限制：這幾筆用的是「看過完整1年資料後」擬合出的係數回推，係數本身有看過這幾天
// (輕微樣本內偏差)，不是真正blind的即時預測——之後每天新增的才是真正的即時預測，
// 前端會分開標示，不能把種子樣本的準確度直接當作模型的真實線上表現。
// 「準確度」刻意拿收盤價(pair.actualClose)驗證，不是開盤價(pair.actualOpen)——雖然「盤前
// 股價預測」跟「ADR歷史相近價位類比估計」這兩個方法本身預測的目標是開盤價，但使用者要
// 用當日收盤價當作最終驗證基準，所以這裡的誤差/命中率包含了開盤後到收盤的盤中變動，
// 不是純粹的開盤價預測誤差。open/close兩個原始值都照樣存進actual裡供參考。
//
// analogEstimate(「ADR歷史相近價位類比估計」卡片本身的估計)：直接對每筆種子樣本的日期D，
// 套用跟那張卡片完全相同的findAnalogMatches()+近6個月窗口(filterSeriesToRecentMonths)，
// 不是從模型的3rd迴歸變數(pair.analogGapPct，那個用的是1年因果裁切窗口，是模型自己的
// 訓練特徵，跟卡片本身的6個月窗口不是同一份計算)去反推近似值——用同一套函式、同一套
// 窗口邏輯，才是「跟卡片當天會顯示的值完全一致」，而不只是模型內部特徵的替代品。這也
// 不依賴modelTier(V1/V2/V3都能算，跟走哪一層迴歸無關，因為類比估計本來就不是迴歸的
// 一部分)。adrSeries/fxSeries/twDaily沒有傳入時(理論上不會發生，main()呼叫時一定有)
// 就整批略過，analogEstimate維持null。
function seedPredictionHistoryIfEmpty(history, modelPairs, modelTier, model, adrSeries, fxSeries, twDaily) {
  if (history.length > 0 || !modelPairs || modelPairs.length === 0) return [];
  const seeds = modelPairs.slice(-ACCURACY_SEED_COUNT);
  const now = new Date().toISOString();
  return seeds.map((pair) => {
    const predictedGapPct = round(predictGapPctForTier(pair, modelTier, model), 2);
    const priceAt = (gapPct) => round(pair.prevClose * (1 + gapPct / 100), 2);
    const probUpPct = round(normalCdf(predictedGapPct / model.residualStd) * 100, 1);
    const actualGapPct = round((pair.actualClose / pair.prevClose - 1) * 100, 2);
    const errorPct = round(predictedGapPct - actualGapPct, 2);
    const ci68 = { low: priceAt(predictedGapPct - model.residualStd), high: priceAt(predictedGapPct + model.residualStd) };
    const ci95 = { low: priceAt(predictedGapPct - 1.96 * model.residualStd), high: priceAt(predictedGapPct + 1.96 * model.residualStd) };

    let analogEstimate = null;
    if (adrSeries && fxSeries && twDaily && pair.adrDate) {
      const adrTrunc = filterSeriesToRecentMonths(adrSeries.filter((s) => s.date <= pair.adrDate), 6);
      const fxTrunc = filterSeriesToRecentMonths(fxSeries.filter((s) => s.date <= pair.adrDate), 6);
      const twTrunc = twDaily.filter((t) => t.date < pair.twDate);
      const analog = findAnalogMatches(pair.adrClose, adrTrunc, fxTrunc, twTrunc);
      if (analog) {
        // 種子樣本當時的「目標匯率」＝那個歷史日期D當下已知的最新匯率(跟卡片即時運算時
        // 用「今天」的匯率是同一個概念，只是這裡的「今天」是歷史上的那一天)。fxTrunc已經
        // 篩到date<=pair.adrDate，用nearestOnOrBefore取D當時最近一筆匯率報價。
        const fxDatesTrunc = fxTrunc.map((s) => s.date).sort();
        const fxMapTrunc = new Map(fxTrunc.map((s) => [s.date, s.close]));
        const seedTodayFx = nearestOnOrBefore(fxMapTrunc, fxDatesTrunc, pair.adrDate);
        const avgTwOpenAdjusted = adjustAvgTwOpenToFx(analog.matches, seedTodayFx);
        const analogPrice = avgTwOpenAdjusted ?? analog.avgTwOpen;
        const analogGapPct = round((analogPrice / pair.prevClose - 1) * 100, 2);
        const analogErrorPct = round(analogGapPct - actualGapPct, 2);
        analogEstimate = {
          avgTwOpen: analog.avgTwOpen,
          avgTwOpenAdjusted,
          tolerancePct: analog.tolerancePct,
          count: analog.count,
          actual: {
            analogGapPct,
            errorPct: analogErrorPct,
            absErrorPct: round(Math.abs(analogErrorPct), 2),
            directionHit: Math.sign(analogGapPct) === Math.sign(actualGapPct),
            resolvedAt: now,
          },
        };
      }
    }

    return {
      date: pair.twDate,
      predictedAt: now,
      modelTier,
      predictedGapPct,
      predictedOpen: priceAt(predictedGapPct),
      ci68,
      ci95,
      probUpPct,
      basisAdrChangePct: round(pair.adrChangePct, 2),
      basisPremiumDevPct: modelTier >= 2 ? round(pair.premiumDev, 2) : null,
      basisAnalogGapPct: modelTier >= 3 ? round(pair.analogGapPct, 2) : null,
      basisTxNightChangePct: modelTier >= 4 ? round(pair.txNightChangePct, 2) : null,
      basisPrevClose: pair.prevClose,
      residualStd: round(model.residualStd, 4),
      confidenceIndexPct: modelTier >= 2 ? round(Math.max(0, model.adjR2) * 100, 1) : null,
      seeded: true,
      analogEstimate,
      actual: {
        open: pair.actualOpen,
        close: pair.actualClose,
        actualGapPct,
        errorPct,
        absErrorPct: round(Math.abs(errorPct), 2),
        directionHit: Math.sign(predictedGapPct) === Math.sign(actualGapPct),
        withinCi68: pair.actualClose >= ci68.low && pair.actualClose <= ci68.high,
        withinCi95: pair.actualClose >= ci95.low && pair.actualClose <= ci95.high,
        resolvedAt: now,
      },
    };
  });
}

// 開盤價預測準確度歷史：永久保留、逐日累積(跟updateAdrPremiumHistory同一套read-try/catch
// →Map upsert-by-date→sort→write模式)。每次執行做兩件事：(1)回填先前已經記錄、但當時
// 台股還沒收盤所以actual還是null的舊項目——用這次新抓到的twDaily檢查那些日期現在是否
// 已經收盤，收了就補上實際開盤/收盤/誤差/是否落在信賴區間；(2)如果這次有算出新預測
// (newEntry非null)，以actual:null的狀態upsert進去，等未來的執行回填。
async function updatePredictionAccuracyHistory(twDaily, newEntry) {
  let history = [];
  try {
    history = JSON.parse(await readFile(PREDICTION_HISTORY_PATH, "utf8"));
  } catch {
    // 檔案不存在(第一次執行)或格式壞掉，視為空歷史，從頭建立
  }
  const byDate = new Map(history.map((h) => [h.date, h]));
  const twByDate = new Map(twDaily.map((t) => [t.date, t]));

  let backfilled = 0;
  for (const entry of byDate.values()) {
    if (entry.actual != null) continue;
    const day = twByDate.get(entry.date);
    if (!day) continue; // 該日還沒收盤(或不在目前抓到的範圍內)，之後執行再回填
    // 用當日收盤價驗證(不是開盤價)：「盤前股價預測」跟「ADR歷史相近價位類比估計」預測的
    // 目標都是開盤價，但這裡改用收盤價當最終驗證基準，所以誤差/命中率會包含開盤後到收盤
    // 的盤中變動，不是純粹的開盤價預測誤差；open/close兩個原始值都照樣存起來供參考。
    const actualGapPct = round((day.close / entry.basisPrevClose - 1) * 100, 2);
    const errorPct = round(entry.predictedGapPct - actualGapPct, 2);
    const resolvedAt = new Date().toISOString();
    entry.actual = {
      open: day.open,
      close: day.close,
      actualGapPct,
      errorPct,
      absErrorPct: round(Math.abs(errorPct), 2),
      directionHit: Math.sign(entry.predictedGapPct) === Math.sign(actualGapPct),
      withinCi68: day.close >= entry.ci68.low && day.close <= entry.ci68.high,
      withinCi95: day.close >= entry.ci95.low && day.close <= entry.ci95.high,
      resolvedAt,
    };
    // 「ADR歷史相近價位類比估計」是另一種獨立估計法(不是OLS模型)，同一天有記錄到的話
    // 也一併算出它自己的缺口%/誤差/方向命中，跟模型的準確度分開比較。
    if (entry.analogEstimate) {
      const analogPrice = entry.analogEstimate.avgTwOpenAdjusted ?? entry.analogEstimate.avgTwOpen;
      const analogGapPct = round((analogPrice / entry.basisPrevClose - 1) * 100, 2);
      const analogErrorPct = round(analogGapPct - actualGapPct, 2);
      entry.analogEstimate.actual = {
        analogGapPct,
        errorPct: analogErrorPct,
        absErrorPct: round(Math.abs(analogErrorPct), 2),
        directionHit: Math.sign(analogGapPct) === Math.sign(actualGapPct),
        resolvedAt,
      };
    }
    backfilled++;
  }

  if (newEntry) {
    const existing = byDate.get(newEntry.date);
    byDate.set(newEntry.date, { ...newEntry, actual: existing?.actual ?? null });
  }

  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await writeFile(PREDICTION_HISTORY_PATH, JSON.stringify(merged), "utf8");
  console.log(`已更新開盤價預測準確度歷史紀錄: ${PREDICTION_HISTORY_PATH}（累計 ${merged.length} 筆，本次回填 ${backfilled} 筆${newEntry ? "，新增今日1筆" : ""}）`);
  return merged;
}

// 把歷史紀錄彙總成前端要顯示的統計摘要：近30/近90個交易日、累計至今三個區間，各自算
// 方向命中率/平均誤差(偏誤方向)/平均絕對誤差/68%與95%信賴區間覆蓋率。樣本數低於
// MIN_ACCURACY_SAMPLES的區間回傳null，前端對應區塊要隱藏，避免樣本太少時的統計沒有代表性。
function computePredictionAccuracySummary(history) {
  const resolved = [...history]
    .filter((h) => h.actual != null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (resolved.length === 0) return null;

  const lookbacks = [
    { key: "last30", label: "近30個交易日", tradingDays: 30 },
    { key: "last90", label: "近90個交易日", tradingDays: 90 },
    { key: "sinceInception", label: "累計至今", tradingDays: Infinity },
  ];

  const windows = {};
  for (const w of lookbacks) {
    const slice = Number.isFinite(w.tradingDays) ? resolved.slice(-w.tradingDays) : resolved;
    if (slice.length < MIN_ACCURACY_SAMPLES) { windows[w.key] = null; continue; }

    // 「ADR歷史相近價位類比估計」是獨立於OLS模型之外的另一種估計法，同一區間內只有
    // 部分紀錄有這項資料(種子樣本沒有、抓取失敗的日子也可能沒有)，樣本數不足時analog
    // 欄位整個回傳null，不勉強算一個代表性不足的統計數字，也不影響模型本身的統計。
    const analogResolved = slice.filter((h) => h.analogEstimate && h.analogEstimate.actual);
    const analog = analogResolved.length < MIN_ACCURACY_SAMPLES ? null : {
      sampleSize: analogResolved.length,
      directionHitRatePct: round(mean(analogResolved.map((h) => (h.analogEstimate.actual.directionHit ? 100 : 0))), 1),
      meanErrorPct: round(mean(analogResolved.map((h) => h.analogEstimate.actual.errorPct)), 2),
      meanAbsErrorPct: round(mean(analogResolved.map((h) => h.analogEstimate.actual.absErrorPct)), 2),
    };

    windows[w.key] = {
      label: w.label,
      sampleSize: slice.length,
      directionHitRatePct: round(mean(slice.map((h) => (h.actual.directionHit ? 100 : 0))), 1),
      meanErrorPct: round(mean(slice.map((h) => h.actual.errorPct)), 2),
      meanAbsErrorPct: round(mean(slice.map((h) => h.actual.absErrorPct)), 2),
      ci68CoveragePct: round(mean(slice.map((h) => (h.actual.withinCi68 ? 100 : 0))), 1),
      ci95CoveragePct: round(mean(slice.map((h) => (h.actual.withinCi95 ? 100 : 0))), 1),
      // Brier score：機率預測的標準評分規則，用probUpPct(上漲機率)對比「有沒有真的漲」
      // (outcome=1/0)算均方誤差，0分最好(完美校準)、0.25分是「不管三七二十一都猜50%」
      // 這種無資訊基準策略的分數、1分最差。跟directionHitRatePct的差別在於這個指標會
      // 額外獎勵/懲罰信心程度——猜對且有信心 > 猜對但沒把握 > 猜錯但沒把握 > 猜錯還很有
      // 信心，不是只看方向對不對。只套用在模型本身(有probUpPct可用)，ADR類比估計法只有
      // 點估計、沒有機率輸出，不適用，所以analog物件不加這個欄位。
      brierScore: round(mean(slice.map((h) => (h.probUpPct / 100 - (h.actual.actualGapPct > 0 ? 1 : 0)) ** 2)), 3),
      analog,
    };
  }

  if (Object.values(windows).every((w) => w == null)) return null;

  // 走勢圖改用實際價位(元)而不是缺口%——「盤前股價預測」「ADR歷史相近價位類比估計」都已經
  // 有現成的價格欄位(predictedOpen/analogEstimate.avgTwOpen)，「收盤價」也已經存在
  // actual.close，直接三條線都用價位表示，比缺口%更直觀。缺口%欄位還是保留(gapPct結尾)，
  // 供tooltip需要時參考用，不強制只能二選一。
  const recentSeries = resolved.slice(-ACCURACY_RECENT_SERIES_LIMIT).map((h) => ({
    date: h.date,
    ci68Low: h.ci68.low,
    ci68High: h.ci68.high,
    predictedGapPct: h.predictedGapPct,
    analogPrice: h.analogEstimate ? (h.analogEstimate.avgTwOpenAdjusted ?? h.analogEstimate.avgTwOpen) : null,
    analogGapPct: h.analogEstimate && h.analogEstimate.actual ? h.analogEstimate.actual.analogGapPct : null,
    actualPrice: h.actual.close,
    actualGapPct: h.actual.actualGapPct,
    directionHit: h.actual.directionHit,
    seeded: h.seeded === true,
  }));

  return { resolvedSampleSize: resolved.length, windows, recentSeries };
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

    pairs.push({ twDate: T.date, adrDate: D, adrClose, adrChangePct, twOpenGapPct, prevClose: Tprev.close, actualOpen: T.open, actualClose: T.close });
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

  // pairs依twDate排序後回傳，供「開盤價預測準確度追蹤」的種子回溯邏輯取「最近幾筆」用
  // （種子回溯只是借用訓練配對已經算好的特徵值，不是重新發明一套邏輯）。
  const pairsSorted = [...uniq].sort((a, b) => (a.twDate < b.twDate ? -1 : a.twDate > b.twDate ? 1 : 0));
  return { ...reg, residualStd, hitRate, pairs: pairsSorted };
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

    pairs.push({ twDate: T.date, adrDate: D, adrClose, adrChangePct, premiumDev, twOpenGapPct, prevClose: Tprev.close, actualOpen: T.open, actualClose: T.close });
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

  const pairsSorted = [...uniq].sort((a, b) => (a.twDate < b.twDate ? -1 : a.twDate > b.twDate ? 1 : 0));
  return { ...reg, residualStd, hitRate, pairs: pairsSorted };
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

// 把類比比對到的每一筆歷史開盤價，先用「當時的匯率」換算回等值ADR美元，再用「目標匯率」
// (通常是查詢當下的最新匯率)換回台幣後取平均——排除掉匯率波動本身的干擾，讓平均值只反映
// ADR股價位階的類比，不是avgTwOpen那個「原始歷史開盤價直接平均、完全不管匯率」的版本。
// 「ADR歷史相近價位類比估計」卡片上顯示給使用者看的數字，用的就是這個調整後版本，所以
// 準確度追蹤/近30日走勢圖也要統一用這個版本，才會跟卡片上實際看到的數字完全一致。
function adjustAvgTwOpenToFx(matches, targetFxUsdTwd) {
  if (!matches || matches.length === 0 || targetFxUsdTwd == null) return null;
  const adjusted = matches.map((m) => (m.twOpen / m.fxRate) * targetFxUsdTwd);
  return round(mean(adjusted), 2);
}

// 三變數版本：「ADR單日漲跌% + ADR溢價率偏離近期均值 + ADR歷史相近價位類比估計缺口%」
// → 台股隔日開盤缺口%。前兩個變數的配對邏輯跟buildOpenGapModelV2完全一致；第三個變數
// 直接重用findAnalogMatches()——正式上線時這個函式也是拿同一套邏輯算「今天」的類比
// 估計，這裡只是把它套用在每一個歷史配對(D, T)上，差別只在於：傳進去的adrSeries/
// fxSeries要裁到只剩「D當時或更早」的資料，twDaily要裁到只剩「早於T」的資料，確保
// 每個歷史訓練樣本都只用到「當時已經知道」的資訊，不會用T自己的開盤價回頭去比對自己
// （look-ahead bias）。
function buildOpenGapModelV3(adrSeries, fxSeries, twDaily, premiumHistory, rollWindowDays) {
  const adrMap = new Map(adrSeries.map((s) => [s.date, s.close]));
  const adrDates = adrSeries.map((s) => s.date);
  const fxMap = new Map(fxSeries.map((s) => [s.date, s.close]));
  const fxDates = fxSeries.map((s) => s.date).sort();

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
    if (window.length < Math.min(rollWindowDays, 20)) continue;
    const premiumDev = premiumSorted[pIdx].premiumPct - mean(window);

    const adrTrunc = adrSeries.filter((s) => s.date <= D);
    const fxTrunc = fxSeries.filter((s) => s.date <= D);
    const twTrunc = twDaily.filter((t) => t.date < T.date);
    const analog = findAnalogMatches(adrClose, adrTrunc, fxTrunc, twTrunc);
    if (!analog) continue;
    const analogGapPct = (analog.avgTwOpen / Tprev.close - 1) * 100;

    pairs.push({ twDate: T.date, adrDate: D, adrClose, adrChangePct, premiumDev, analogGapPct, twOpenGapPct, prevClose: Tprev.close, actualOpen: T.open, actualClose: T.close });
  }

  const byTwDate = new Map();
  for (const p of pairs) byTwDate.set(p.twDate, p);
  const uniq = [...byTwDate.values()];
  if (uniq.length < MIN_REGRESSION_SAMPLES_V3) return null;

  const X = uniq.map((p) => [1, p.adrChangePct, p.premiumDev, p.analogGapPct]);
  const y = uniq.map((p) => p.twOpenGapPct);
  const reg = olsRegressionN(X, y);
  const residuals = uniq.map((p, i) => y[i] - (reg.beta[0] + reg.beta[1] * p.adrChangePct + reg.beta[2] * p.premiumDev + reg.beta[3] * p.analogGapPct));
  const residualStd = stddev(residuals);
  const hitRate = uniq.filter((p) => Math.sign(p.adrChangePct) === Math.sign(p.twOpenGapPct) && p.adrChangePct !== 0).length / uniq.length;

  const pairsSorted = [...uniq].sort((a, b) => (a.twDate < b.twDate ? -1 : a.twDate > b.twDate ? 1 : 0));
  return { ...reg, residualStd, hitRate, pairs: pairsSorted };
}

// 四變數版本：V3再加一項「台指期(TX)夜盤收盤變動%」。TX夜盤(15:00~次日05:00)結算併入
// 次一般交易時段(見fetch-market-context.mjs的fetchTaifexNightClose註解)，所以「夜盤日期
// D」代表的是D當天15:00開始、D+1 05:00收盤的那一場，跟ADR一樣屬於「隔夜到隔天開盤前
// 才知道結果」的輸入，用同一套「找第一個date>D的twDaily」對齊法（不是同一天，是D+1）。
// txNightHistory: [{date, close, changePct}]（date=TAIFEX官方夜盤標示的起始日D，
// changePct=這場夜盤收盤 vs 前一個交易日夜盤收盤的漲跌%，來源見fetchTaifexNightClose，
// 可以直接沿用不用重算）。
function buildOpenGapModelV4(adrSeries, fxSeries, twDaily, premiumHistory, txNightHistory, rollWindowDays) {
  const adrMap = new Map(adrSeries.map((s) => [s.date, s.close]));
  const adrDates = adrSeries.map((s) => s.date);
  const fxMap = new Map(fxSeries.map((s) => [s.date, s.close]));
  const fxDates = fxSeries.map((s) => s.date).sort();

  const premiumSorted = [...premiumHistory].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const premiumIndexByDate = new Map(premiumSorted.map((h, i) => [h.date, i]));
  const txNightMap = new Map((txNightHistory || []).map((h) => [h.date, h.changePct]));

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
    if (window.length < Math.min(rollWindowDays, 20)) continue;
    const premiumDev = premiumSorted[pIdx].premiumPct - mean(window);

    const adrTrunc = adrSeries.filter((s) => s.date <= D);
    const fxTrunc = fxSeries.filter((s) => s.date <= D);
    const twTrunc = twDaily.filter((t) => t.date < T.date);
    const analog = findAnalogMatches(adrClose, adrTrunc, fxTrunc, twTrunc);
    if (!analog) continue;
    const analogGapPct = (analog.avgTwOpen / Tprev.close - 1) * 100;

    // TX夜盤配對用同一個ADR日期D去找對應的夜盤日期D這一場(同一個「隔夜」概念)——D這天
    // 15:00開始的夜盤，跟D這天美股ADR是同一個交易日晚上發生的兩件事，理論上都在T(D+1)
    // 開盤前就已知，配對邏輯上跟ADR共用同一個D。
    const txNightChangePct = txNightMap.get(D);
    if (txNightChangePct == null) continue;

    pairs.push({ twDate: T.date, adrDate: D, adrClose, adrChangePct, premiumDev, analogGapPct, txNightChangePct, twOpenGapPct, prevClose: Tprev.close, actualOpen: T.open, actualClose: T.close });
  }

  const byTwDate = new Map();
  for (const p of pairs) byTwDate.set(p.twDate, p);
  const uniq = [...byTwDate.values()];
  if (uniq.length < MIN_REGRESSION_SAMPLES_V4) return null;

  const X = uniq.map((p) => [1, p.adrChangePct, p.premiumDev, p.analogGapPct, p.txNightChangePct]);
  const y = uniq.map((p) => p.twOpenGapPct);
  const reg = olsRegressionN(X, y);
  const residuals = uniq.map((p, i) => y[i] - (reg.beta[0] + reg.beta[1] * p.adrChangePct + reg.beta[2] * p.premiumDev + reg.beta[3] * p.analogGapPct + reg.beta[4] * p.txNightChangePct));
  const residualStd = stddev(residuals);
  const hitRate = uniq.filter((p) => Math.sign(p.adrChangePct) === Math.sign(p.twOpenGapPct) && p.adrChangePct !== 0).length / uniq.length;

  const pairsSorted = [...uniq].sort((a, b) => (a.twDate < b.twDate ? -1 : a.twDate > b.twDate ? 1 : 0));
  return { ...reg, residualStd, hitRate, pairs: pairsSorted };
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

// 技術面買賣訊號（估值面PE/ADR溢價不參與計分，跟classifyZone刻意分開兩套獨立判讀）：
// 均線排列/MACD柱狀體/RSI相對50中軸/KD交叉方向四個因子加權計分，公式與門檻比照
// fetch-market-context.mjs裡的classifyChipTrend（籌碼面綜合研判）——
// avg=Σ(score×weight)/Σweight，avg≥0.34偏多、avg≤-0.34偏空、其餘中性。另外附帶
// 一組不計分的風險/提醒清單，以及支撐/壓力/停損/停利參考價位。
function classifyTechnicalSignal(daily, lastInd, lastClose, sixMonthHigh) {
  let score = 0, weightSum = 0;
  const reasons = [];
  const risk = [];

  // 均線排列
  if (lastInd.ma5 != null && lastInd.ma20 != null && lastInd.ma60 != null) {
    let s = 0;
    if (lastInd.ma5 > lastInd.ma20 && lastInd.ma20 > lastInd.ma60) s = 1;
    else if (lastInd.ma5 < lastInd.ma20 && lastInd.ma20 < lastInd.ma60) s = -1;
    score += s * 1.2; weightSum += 1.2;
    reasons.push(s > 0 ? "均線呈多頭排列(MA5>MA20>MA60)" : s < 0 ? "均線呈空頭排列(MA5<MA20<MA60)" : "均線糾結，未成排列");
  }

  // MACD柱狀體方向
  if (lastInd.histogram != null) {
    const s = Math.sign(lastInd.histogram);
    score += s * 1.0; weightSum += 1.0;
    const note = lastInd.macd != null && lastInd.macd < 0 && s > 0 ? "（柱狀體翻正但仍在0軸下，屬初升段訊號）" : "";
    reasons.push(`MACD柱狀體${s >= 0 ? "翻正" : "翻負"}${note}`);
  }

  // RSI相對50中軸
  if (lastInd.rsi14 != null) {
    const s = Math.sign(lastInd.rsi14 - 50);
    score += s * 0.8; weightSum += 0.8;
    reasons.push(`RSI(14) ${lastInd.rsi14.toFixed(1)} ${s >= 0 ? "站上" : "跌破"}50中軸`);
  }

  // KD交叉方向
  if (lastInd.k != null && lastInd.d != null) {
    const s = Math.sign(lastInd.k - lastInd.d);
    score += s * 0.6; weightSum += 0.6;
    reasons.push(`KD ${s > 0 ? "黃金交叉(K>D)" : s < 0 ? "死亡交叉(K<D)" : "K=D"}`);
  }

  // 獨立風險/提醒（不計分）
  if (lastInd.rsi14 != null) {
    if (lastInd.rsi14 > 70) risk.push("RSI超買，留意短線拉回風險");
    else if (lastInd.rsi14 < 30) risk.push("RSI超賣，留意反彈契機");
  }
  if (lastInd.k != null) {
    if (lastInd.k > 80) risk.push("KD高檔鈍化，留意過熱拉回風險");
    else if (lastInd.k < 20) risk.push("KD低檔鈍化，留意超跌反彈契機");
  }
  if (lastInd.bbUpper != null && lastInd.bbLower != null && lastInd.bbUpper > lastInd.bbLower) {
    const pos = (lastClose - lastInd.bbLower) / (lastInd.bbUpper - lastInd.bbLower);
    if (pos >= 0.9) risk.push("股價貼近布林上軌，短線過熱疑慮");
    else if (pos <= 0.1) risk.push("股價貼近布林下軌，具超跌支撐性質");
  }
  // 量價背離：近5日新高/新低 + 量能跟前5日均量比較
  if (daily.length >= 10) {
    const recent5 = daily.slice(-5);
    const prev5 = daily.slice(-10, -5);
    const prevAvgVol = prev5.reduce((a, b) => a + b.volume, 0) / prev5.length;
    const todayClose = daily[daily.length - 1].close;
    const todayVol = daily[daily.length - 1].volume;
    const recent5HighClose = Math.max(...recent5.map((d) => d.close));
    const recent5LowClose = Math.min(...recent5.map((d) => d.close));
    if (todayClose >= recent5HighClose && todayVol < prevAvgVol) risk.push("價漲量縮，動能背離值得留意");
    else if (todayClose <= recent5LowClose && todayVol > prevAvgVol) risk.push("價跌量增，賣壓沉重");
  }

  if (weightSum === 0) return null;
  const avg = score / weightSum;
  const verdict = avg >= 0.34 ? "偏多" : avg <= -0.34 ? "偏空" : "中性";
  const cls = avg >= 0.34 ? "up" : avg <= -0.34 ? "down" : "";

  const support = lastInd.ma60 != null && lastInd.bbLower != null ? Math.max(lastInd.ma60, lastInd.bbLower) : (lastInd.ma60 ?? lastInd.bbLower ?? null);
  const resistance = lastInd.bbUpper != null ? Math.min(sixMonthHigh, lastInd.bbUpper) : sixMonthHigh;

  return {
    verdict, cls, reasons, risk,
    levels: { support: round(support, 0), resistance: round(resistance, 0), stopLoss: round(support, 0), takeProfit: round(resistance, 0) },
  };
}

// 收盤後回填模式（--backfill-only）：台股收盤後(13:35)立刻用當天剛收盤的台股日K，回填
// 「盤前股價預測準確度歷史追蹤」卡片裡今天早上那筆還沒解析的預測(actual補上開盤/收盤/
// 誤差/走勢命中/CI覆蓋率/Brier分數)，讓卡片不用等到隔天06:00的完整排程才更新。刻意不
// 呼叫updatePredictionAccuracyHistory的newEntry參數(傳null)——「明天」的新預測需要ADR/
// 匯率隔夜資料，13:35美股根本還沒開盤，這部分本來就做不到，維持給隔天06:00那個完整排程
// 處理。同理不重新計算ADR換算價/估值分區/技術旗標/官方預估這些欄位，只更新
// predictionAccuracySummary這一個欄位，其餘完全維持這次讀到的原樣，不會被覆蓋。
async function runBackfillOnly() {
  const d = JSON.parse(await readFile(DATA_PATH, "utf8"));

  // 夜盤K線圖：底層檔案本身不受鎖定時間窗影響(見fetch-market-context.mjs的
  // fetchTaifexNightClose/appendTaifexNightHistory，兩者都是無條件呼叫)，這裡
  // 只是把它重新切6個月子集塞回data.json，讓卡片跟得上已經是最新的底層資料。
  // 跟下面近1年台股日K(twDaily1y)的抓取完全無關，刻意獨立處理，不被那邊的
  // 失敗連累。
  try {
    const txNightHistory = JSON.parse(await readFile(TX_NIGHT_HISTORY_PATH, "utf8"));
    d.taifexNightHistory = filterSeriesToRecentMonths(txNightHistory, 6);
  } catch {
    // 檔案不存在或格式壞掉，維持data.json裡原本的taifexNightHistory不變
  }

  // 技術面買賣訊號：純規則式計算，不需要額外抓取，d.daily/d.indicators在鎖定
  // 時間窗內其實已經是update-dashboard.mjs那步剛更新好的新資料，直接拿來算。
  // 同樣跟twDaily1y無關，獨立處理。
  if (d.daily?.length > 0 && d.indicators?.length > 0 && d.valuation) {
    const lastInd = d.indicators[d.indicators.length - 1];
    const lastClose = d.valuation.closePrice;
    const sixMonthHigh = Math.max(...d.daily.map((x) => x.close));
    d.technicalSignal = classifyTechnicalSignal(d.daily, lastInd, lastClose, sixMonthHigh);
  }

  // predictionAccuracySummary才需要近1年台股日K，這裡失敗只略過這一項，不影響
  // 上面兩項已經算好、準備寫入的欄位。
  let twDaily1y = [];
  try {
    twDaily1y = await fetchTwseDailyRange(REGRESSION_WINDOW_MONTHS);
  } catch (e) {
    console.warn("抓取近1年台股日K失敗，略過準確度回填(其餘欄位仍照常更新): " + e.message);
  }
  if (twDaily1y.length > 0) {
    const predictionHistory = await updatePredictionAccuracyHistory(twDaily1y, null);
    const summary = computePredictionAccuracySummary(predictionHistory);
    if (summary) d.predictionAccuracySummary = summary;
  } else {
    console.warn("近1年台股日K為空，略過準確度回填(其餘欄位仍照常更新)");
  }

  await writeFile(DATA_PATH, JSON.stringify(d), "utf8");
  console.log("已完成收盤後回填(--backfill-only模式)：predictionAccuracySummary/taifexNightHistory/technicalSignal已更新，其餘欄位不變。");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("backfill-only" in args) {
    return await runBackfillOnly();
  }
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

  // d.generatedAt(update-dashboard.mjs寫入，這次pipeline開始執行的UTC時間)換算成台北
  // 日曆日期字串，供openPrediction/adrAnalogMatches標記「這是哪一天算出來的」(forDate)。
  // 提早在這裡算好，這樣四層退回模型跟類比估計兩處都能直接用同一個值，不用各自重算。
  const todayDateStr = new Date(new Date(d.generatedAt).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

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

  // 台指期(TX)夜盤歷史序列：純讀取，累積寫入交給fetch-market-context.mjs的
  // fetchTaifexNightClose（偵測到換日、前一筆確定不會再被校正時才append），這裡不寫檔。
  let txNightHistory = [];
  try {
    txNightHistory = JSON.parse(await readFile(TX_NIGHT_HISTORY_PATH, "utf8"));
  } catch {
    // 檔案不存在或格式壞掉，視為空歷史——四變數模型樣本數不足時會自動退回三變數版本
  }

  // 夜盤K線圖只需要近6個月子集，跟既有K線圖／ADR歷史相近價位類比估計的6個月語意一致
  // (filterSeriesToRecentMonths跟那兩個功能共用同一支函式)。完整歷史留在
  // data/taifex-night-history.json裡供V4模型訓練用，不整包灌進data.json。
  d.taifexNightHistory = filterSeriesToRecentMonths(txNightHistory, 6);

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
  d.technicalSignal = classifyTechnicalSignal(d.daily, lastInd, lastClose, sixMonthHigh);

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

  // ---- 台股開盤價機率預估 ----
  // 四層退回：優先用四變數模型(ADR漲跌% + 溢價偏離% + ADR歷史相近價位類比估計缺口% +
  // TX夜盤變動%)；TX夜盤歷史樣本數不足(MIN_REGRESSION_SAMPLES_V4)、或今天的
  // d.taifexNightClose剛好還沒有值時，退回三變數模型；樣本數不足(MIN_REGRESSION_
  // SAMPLES_V3)或今天剛好找不到任何類比比對時，再退回只帶溢價偏離的雙變數模型；溢價
  // 歷史也不夠長的話最後退回僅ADR漲跌%的單變數模型。不管哪一層都不讓卡片直接消失——
  // 這些退回路徑理論上只有在資料還在累積的最初期間才會用到，1年回填後樣本數已經足夠，
  // 正常情況下應該都會走四變數模型。
  let predicted = false;
  let predictionTier = null;
  let predictionModel = null;
  if (adrDaily && fxDaily) {
    try {
      const model4 = twDaily1y.length > 0
        ? buildOpenGapModelV4(adrDaily.series, fxDaily.series, twDaily1y, premiumHistory, txNightHistory, PREMIUM_ROLL_WINDOW_DAYS)
        : null;
      const txNightChangePctNow = d.taifexNightClose?.changePct ?? null;
      // 「今天」的類比估計缺口%要用跟訓練時同一套函式(findAnalogMatches)、同一份完整
      // 1年序列現算，這樣訓練特徵跟預測當下用的特徵才是同一種算法，不會兩邊邏輯不一致。
      const analogNow4 = model4 ? findAnalogMatches(adrPrice, adrDaily.series, fxDaily.series, twDaily1y) : null;

      if (model4 && analogNow4 && txNightChangePctNow != null) {
        const premiumHistorySorted4 = [...premiumHistory].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const latestPremium4 = premiumHistorySorted4[premiumHistorySorted4.length - 1];
        const rollWindow4 = premiumHistorySorted4.slice(Math.max(0, premiumHistorySorted4.length - PREMIUM_ROLL_WINDOW_DAYS)).map((h) => h.premiumPct);
        const premiumDevNow4 = latestPremium4.premiumPct - mean(rollWindow4);
        const base4 = d.valuation.closePrice;
        const analogGapNowPct4 = (analogNow4.avgTwOpen / base4 - 1) * 100;

        const [b0, b1, b2, b3, b4] = model4.beta;
        const predictedGapPct = b0 + b1 * adrChangePct + b2 * premiumDevNow4 + b3 * analogGapNowPct4 + b4 * txNightChangePctNow;
        const priceAt = (gapPct) => round(base4 * (1 + gapPct / 100), 2);
        const probUpPct = round(normalCdf(predictedGapPct / model4.residualStd) * 100, 1);
        const confidenceIndexPct = round(Math.max(0, model4.adjR2) * 100, 1);

        d.openPrediction = {
          forDate: todayDateStr,
          predictedGapPct: round(predictedGapPct, 2),
          predictedOpen: priceAt(predictedGapPct),
          ci68: { low: priceAt(predictedGapPct - model4.residualStd), high: priceAt(predictedGapPct + model4.residualStd) },
          ci95: { low: priceAt(predictedGapPct - 1.96 * model4.residualStd), high: priceAt(predictedGapPct + 1.96 * model4.residualStd) },
          probUpPct,
          basisAdrChangePct: adrChangePct,
          basisPremiumDevPct: round(premiumDevNow4, 2),
          basisAnalogGapPct: round(analogGapNowPct4, 2),
          basisTxNightChangePct: txNightChangePctNow,
          basisPrevClose: base4,
          model: {
            method: "OLS四變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離% + ADR歷史相近價位類比估計缺口% + TX夜盤變動%）",
            interceptB0: round(b0, 4),
            adrChangeCoefB1: round(b1, 4),
            premiumDevCoefB2: round(b2, 4),
            analogGapCoefB3: round(b3, 4),
            txNightChangeCoefB4: round(b4, 4),
            r2: round(model4.r2, 4),
            adjR2: round(model4.adjR2, 4),
            tAdrChange: round(model4.t[1], 2),
            tPremiumDev: round(model4.t[2], 2),
            tAnalogGap: round(model4.t[3], 2),
            tTxNightChange: round(model4.t[4], 2),
            pAdrChange: round(model4.p[1], 4),
            pPremiumDev: round(model4.p[2], 4),
            pAnalogGap: round(model4.p[3], 4),
            pTxNightChange: round(model4.p[4], 4),
            residualStd: round(model4.residualStd, 4),
            hitRatePct: round(model4.hitRate * 100, 1),
            sampleSize: model4.n,
            windowMonths: REGRESSION_WINDOW_MONTHS,
            premiumRollWindowDays: PREMIUM_ROLL_WINDOW_DAYS,
            analogTolerancePct: analogNow4.tolerancePct,
            confidenceIndexPct,
          },
        };
        predicted = true;
        predictionTier = 4;
        predictionModel = model4;
        console.log(`開盤價機率預估(四變數): 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（調整後R²=${model4.adjR2.toFixed(3)}, n=${model4.n}, TX夜盤變動t值=${model4.t[4].toFixed(2)}）`);
      }
    } catch (e) {
      console.warn("四變數開盤價機率預估計算失敗，將嘗試三變數版本: " + e.message);
    }
  }

  if (!predicted && adrDaily && fxDaily) {
    try {
      const model3 = twDaily1y.length > 0
        ? buildOpenGapModelV3(adrDaily.series, fxDaily.series, twDaily1y, premiumHistory, PREMIUM_ROLL_WINDOW_DAYS)
        : null;
      // 「今天」的類比估計缺口%要用跟訓練時同一套函式(findAnalogMatches)、同一份完整
      // 1年序列現算，這樣訓練特徵跟預測當下用的特徵才是同一種算法，不會兩邊邏輯不一致。
      const analogNow = model3 ? findAnalogMatches(adrPrice, adrDaily.series, fxDaily.series, twDaily1y) : null;

      if (model3 && analogNow) {
        const premiumHistorySorted = [...premiumHistory].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const latestPremium = premiumHistorySorted[premiumHistorySorted.length - 1];
        const rollWindow = premiumHistorySorted.slice(Math.max(0, premiumHistorySorted.length - PREMIUM_ROLL_WINDOW_DAYS)).map((h) => h.premiumPct);
        const premiumDevNow = latestPremium.premiumPct - mean(rollWindow);
        const base = d.valuation.closePrice;
        const analogGapNowPct = (analogNow.avgTwOpen / base - 1) * 100;

        const [b0, b1, b2, b3] = model3.beta;
        const predictedGapPct = b0 + b1 * adrChangePct + b2 * premiumDevNow + b3 * analogGapNowPct;
        const priceAt = (gapPct) => round(base * (1 + gapPct / 100), 2);
        const probUpPct = round(normalCdf(predictedGapPct / model3.residualStd) * 100, 1);
        const confidenceIndexPct = round(Math.max(0, model3.adjR2) * 100, 1);

        d.openPrediction = {
          forDate: todayDateStr,
          predictedGapPct: round(predictedGapPct, 2),
          predictedOpen: priceAt(predictedGapPct),
          ci68: { low: priceAt(predictedGapPct - model3.residualStd), high: priceAt(predictedGapPct + model3.residualStd) },
          ci95: { low: priceAt(predictedGapPct - 1.96 * model3.residualStd), high: priceAt(predictedGapPct + 1.96 * model3.residualStd) },
          probUpPct,
          basisAdrChangePct: adrChangePct,
          basisPremiumDevPct: round(premiumDevNow, 2),
          basisAnalogGapPct: round(analogGapNowPct, 2),
          basisPrevClose: base,
          model: {
            method: "OLS三變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離% + ADR歷史相近價位類比估計缺口%）",
            interceptB0: round(b0, 4),
            adrChangeCoefB1: round(b1, 4),
            premiumDevCoefB2: round(b2, 4),
            analogGapCoefB3: round(b3, 4),
            r2: round(model3.r2, 4),
            adjR2: round(model3.adjR2, 4),
            tAdrChange: round(model3.t[1], 2),
            tPremiumDev: round(model3.t[2], 2),
            tAnalogGap: round(model3.t[3], 2),
            pAdrChange: round(model3.p[1], 4),
            pPremiumDev: round(model3.p[2], 4),
            pAnalogGap: round(model3.p[3], 4),
            residualStd: round(model3.residualStd, 4),
            hitRatePct: round(model3.hitRate * 100, 1),
            sampleSize: model3.n,
            windowMonths: REGRESSION_WINDOW_MONTHS,
            premiumRollWindowDays: PREMIUM_ROLL_WINDOW_DAYS,
            analogTolerancePct: analogNow.tolerancePct,
            confidenceIndexPct,
          },
        };
        predicted = true;
        predictionTier = 3;
        predictionModel = model3;
        console.log(`開盤價機率預估(三變數): 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（調整後R²=${model3.adjR2.toFixed(3)}, n=${model3.n}, 類比缺口t值=${model3.t[3].toFixed(2)}）`);
      }
    } catch (e) {
      console.warn("三變數開盤價機率預估計算失敗，將嘗試雙變數版本: " + e.message);
    }

    if (!predicted) {
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
            forDate: todayDateStr,
            predictedGapPct: round(predictedGapPct, 2),
            predictedOpen: priceAt(predictedGapPct),
            ci68: { low: priceAt(predictedGapPct - model2.residualStd), high: priceAt(predictedGapPct + model2.residualStd) },
            ci95: { low: priceAt(predictedGapPct - 1.96 * model2.residualStd), high: priceAt(predictedGapPct + 1.96 * model2.residualStd) },
            probUpPct,
            basisAdrChangePct: adrChangePct,
            basisPremiumDevPct: round(premiumDevNow, 2),
            basisPrevClose: base,
            model: {
              method: "OLS雙變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離%，類比估計樣本數不足時的退回版本）",
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
          predicted = true;
          predictionTier = 2;
          predictionModel = model2;
          console.log(`開盤價機率預估(雙變數退回): 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（調整後R²=${model2.adjR2.toFixed(3)}, n=${model2.n}）`);
        }
      } catch (e) {
        console.warn("雙變數開盤價機率預估計算失敗，將嘗試單變數版本: " + e.message);
      }
    }

    if (!predicted) {
      try {
        const model = buildOpenGapModel(adrDaily.series, fxDaily.series, twDaily1y.length > 0 ? twDaily1y : d.daily);
        if (model) {
          const predictedGapPct = model.beta * adrChangePct + model.alpha;
          const base = d.valuation.closePrice;
          const priceAt = (gapPct) => round(base * (1 + gapPct / 100), 2);
          const probUpPct = round(normalCdf(predictedGapPct / model.residualStd) * 100, 1);

          d.openPrediction = {
            forDate: todayDateStr,
            predictedGapPct: round(predictedGapPct, 2),
            predictedOpen: priceAt(predictedGapPct),
            ci68: { low: priceAt(predictedGapPct - model.residualStd), high: priceAt(predictedGapPct + model.residualStd) },
            ci95: { low: priceAt(predictedGapPct - 1.96 * model.residualStd), high: priceAt(predictedGapPct + 1.96 * model.residualStd) },
            probUpPct,
            basisAdrChangePct: adrChangePct,
            basisPrevClose: base,
            model: {
              method: "OLS單變數迴歸（開盤缺口% ~ ADR漲跌%，溢價率/類比估計樣本數不足時的退回版本）",
              beta: round(model.beta, 4),
              alpha: round(model.alpha, 4),
              r2: round(model.r2, 4),
              residualStd: round(model.residualStd, 4),
              hitRatePct: round(model.hitRate * 100, 1),
              sampleSize: model.n,
              windowMonths: REGRESSION_WINDOW_MONTHS,
            },
          };
          predicted = true;
          predictionTier = 1;
          predictionModel = model;
          console.log(`開盤價機率預估(單變數退回): 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（R²=${model.r2.toFixed(2)}, n=${model.n}）`);
        }
      } catch (e) {
        console.warn("開盤價機率預估計算失敗，略過: " + e.message);
      }
    }

    if (!predicted) {
      console.warn("三/雙/單變數模型可用樣本數皆不足，略過開盤價機率預估");
    }
  }

  // ---- ADR歷史相近價位類比估計 ----
  // 這個區塊要放在「開盤價預測準確度追蹤」之前執行：準確度追蹤要把今天的d.adrAnalogMatches
  // 一併存進歷史紀錄(供之後也追蹤類比估計本身的準不準)，必須先算出來才能用。
  if (adrDaily6mo && fxDaily6mo) {
    try {
      const analog = findAnalogMatches(adrPrice, adrDaily6mo.series, fxDaily6mo.series, d.daily);
      if (analog) {
        analog.avgTwOpenAdjusted = adjustAvgTwOpenToFx(analog.matches, d.fxRate.usdTwd);
        analog.forDate = todayDateStr;
        d.adrAnalogMatches = analog;
        console.log(`歷史相近ADR價位比對: ${analog.count}筆 (±${analog.tolerancePct}%)  平均對應台股開盤價: ${analog.avgTwOpen}（匯率調整後: ${analog.avgTwOpenAdjusted}）`);
      } else {
        console.warn("近6個月無相近ADR價位可比對，略過類比估計");
      }
    } catch (e) {
      console.warn("歷史相近ADR價位比對計算失敗，略過: " + e.message);
    }
  }

  // ---- 開盤價預測準確度追蹤 ----
  // 不論這次是否成功算出新預測，只要有抓到近1年台股日K，就先回填先前未解析的舊紀錄
  // （所以特意放在if (adrDaily && fxDaily)區塊外面，即使ADR/匯率當次抓取失敗，仍然可以
  // 用這次的台股日K把之前累積的未解析紀錄回填掉，不用等到下次ADR恢復正常才回填）；
  // 今天的新預測（若有算出來）另外併入同一次寫檔。資料庫還是空檔案時，先用最近幾筆訓練
  // 配對種一批初始樣本，讓卡片一上線就有資料可看。同時把d.adrAnalogMatches(若有)一併存
  // 進紀錄，讓「ADR歷史相近價位類比估計」這個既有功能本身的準確度也能被長期追蹤，不是
  // 只追蹤OLS迴歸模型。
  if (twDaily1y.length > 0) {
    try {
      let history = [];
      try {
        history = JSON.parse(await readFile(PREDICTION_HISTORY_PATH, "utf8"));
      } catch {
        // 檔案不存在，視為空歷史
      }
      const seeds = predictionModel
        ? seedPredictionHistoryIfEmpty(history, predictionModel.pairs, predictionTier, predictionModel, adrDaily.series, fxDaily.series, twDaily1y)
        : [];

      const newEntry = predicted
        ? buildPredictionHistoryEntry(d.openPrediction, predictionTier, todayDateStr, d.generatedAt, false, d.adrAnalogMatches)
        : null;

      // 種子樣本直接寫進同一份歷史（在updatePredictionAccuracyHistory做回填/upsert之前），
      // 這樣今天這次執行內，種子樣本也會一併被回填邏輯掃過（雖然種子樣本本來就已經有
      // actual了，掃過也不會被覆蓋，因為回填邏輯只處理actual===null的項目）。種子樣本本身
      // 沒有對應的「當時6個月類比估計」可回溯(訓練配對用的是完整1年資料算類比，跟這張卡片
      // 展示用的6個月版本不是同一份計算)，所以種子樣本的analogEstimate固定是null，之後
      // 每天新增的才會有。
      if (seeds.length > 0) {
        for (const s of seeds) history.push(s);
        await writeFile(PREDICTION_HISTORY_PATH, JSON.stringify(history), "utf8");
        console.log(`開盤價預測準確度歷史紀錄為空，已用最近${seeds.length}筆訓練配對回溯種子樣本（標記seeded:true）`);
      }

      const predictionHistory = await updatePredictionAccuracyHistory(twDaily1y, newEntry);
      const summary = computePredictionAccuracySummary(predictionHistory);
      if (summary) d.predictionAccuracySummary = summary;
    } catch (e) {
      console.warn("開盤價預測準確度歷史紀錄更新失敗，略過: " + e.message);
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
