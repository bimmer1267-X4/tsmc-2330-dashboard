// 合併 ADR / 匯率資料（呼叫端透過 WebFetch 交叉比對兩來源後取得，或於未提供參數時
// 自動改用 Yahoo Finance 單一來源抓取，供排程自動化使用）進 data.json，
// 並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價，
// 以及「全年預估EPS」(config.json) 換算的 Forward PE / PEG 分區。
// 同時用近6個月 ADR/匯率/台股歷史資料訓練「ADR隔夜漲跌% → 台股開盤缺口%」OLS迴歸，
// 套用在今天的ADR變動上，機率性推估台股開盤價（含68%/95%信賴區間、上漲機率）。
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
const YF_UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";
const REGRESSION_WINDOW = "6mo";
const REGRESSION_WINDOW_MONTHS = 6;
const MIN_REGRESSION_SAMPLES = 20;

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
  // 不一定是「前一個交易日」，用它算漲跌%可能落差好幾天而算錯。改為直接從每日收盤價序列
  // 取倒數第二個有效值（= 真正的前一交易日收盤），確保漲跌%永遠是逐日比較。
  const closes = series.map((s) => s.close);
  const previousClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.previousClose ?? meta.chartPreviousClose);
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

// 用近6個月 ADR(TSM)/USD-TWD/台股日K，訓練「ADR單日漲跌% → 台股隔日開盤缺口%」OLS迴歸。
// adrSeries/fxSeries: [{date, close}]（date為美東交易日期字串）；twDaily: data.json 的 daily 陣列。
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

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

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

  // 近6個月 ADR/匯率歷史序列：無論今天的ADR/匯率是手動交叉比對還是自動抓取，都需要
  // 這份歷史資料來訓練「ADR vs 台股開盤缺口」迴歸模型，所以固定抓取。
  let adrDaily = null, fxDaily = null;
  try {
    [adrDaily, fxDaily] = await Promise.all([fetchYahooDaily("TSM"), fetchYahooDaily("TWD=X")]);
  } catch (e) {
    console.warn("抓取 ADR/匯率近6個月歷史序列失敗，將略過開盤價機率預估: " + e.message);
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

  // ADR近6個月最高收盤價(美元)，取自本次一併抓取的ADR歷史序列(供開盤價迴歸訓練用)。
  if (adrDaily) {
    d.adrSixMonthHighUsd = round(Math.max(...adrDaily.series.map((s) => s.close)), 2);
  }

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
  try {
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

  // ---- 台股開盤價機率預估（依近6個月「ADR漲跌% → 開盤缺口%」迴歸模型） ----
  if (adrDaily && fxDaily) {
    try {
      const model = buildOpenGapModel(adrDaily.series, fxDaily.series, d.daily);
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
            beta: round(model.beta, 4),
            alpha: round(model.alpha, 4),
            r2: round(model.r2, 4),
            residualStd: round(model.residualStd, 4),
            hitRatePct: round(model.hitRate * 100, 1),
            sampleSize: model.n,
            windowMonths: REGRESSION_WINDOW_MONTHS,
          },
        };
        console.log(`開盤價機率預估: 缺口${d.openPrediction.predictedGapPct}%  預估開盤價${d.openPrediction.predictedOpen}  上漲機率${probUpPct}%（R²=${model.r2.toFixed(2)}, n=${model.n}）`);
      } else {
        console.warn(`可用配對樣本數不足(<${MIN_REGRESSION_SAMPLES})，略過開盤價機率預估`);
      }
    } catch (e) {
      console.warn("開盤價機率預估計算失敗，略過: " + e.message);
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
