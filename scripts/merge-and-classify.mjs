// 合併 ADR / 匯率資料（呼叫端透過 WebFetch 交叉比對兩來源後取得）進 data.json，
// 並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價，
// 以及「全年預估EPS」(config.json) 換算的 Forward PE / PEG 分區。
// 跨平台版本 (Node.js)，邏輯與 merge-and-classify.ps1 對等。
//
// 用法：
//   node merge-and-classify.mjs --adr-price 424.61 --adr-change-pct 5.55 \
//     --adr-quote-time 2026-07-21T16:00:00-04:00 --usd-twd 32.325 \
//     --fx-quote-time 2026-07-22T08:02:00+08:00

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "data.json");
const CONFIG_PATH = join(__dirname, "..", "data", "config.json");

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
  const adrPrice = Number(args["adr-price"]);
  const adrChangePct = Number(args["adr-change-pct"]);
  const adrQuoteTime = args["adr-quote-time"];
  const usdTwd = Number(args["usd-twd"]);
  const fxQuoteTime = args["fx-quote-time"];
  const adrRatio = Number(args["adr-ratio"] ?? 5);

  if (!adrPrice || !adrQuoteTime || !usdTwd || !fxQuoteTime) {
    console.error("缺少必要參數：--adr-price --adr-change-pct --adr-quote-time --usd-twd --fx-quote-time");
    process.exit(1);
  }

  const d = JSON.parse(await readFile(DATA_PATH, "utf8"));

  d.adr = {
    price: adrPrice,
    changePct: adrChangePct,
    quoteTime: adrQuoteTime,
    sources: ["stockanalysis.com", "finance.yahoo.com"],
    ratio: adrRatio,
  };
  d.fxRate = { usdTwd, quoteTime: fxQuoteTime, source: "tw.stock.yahoo.com USDTWD=X" };

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
