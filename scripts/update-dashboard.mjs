// 抓取台積電(2330)近6個月日K + 本益比/殖利率/股價淨值比 + 最新季度EPS，
// 並計算 MA5/20/60、RSI(14)、MACD(12,26,9)、布林通道(20,2)、KD(9,3,3) 等技術指標，
// 輸出 data/data.json，供 dashboard.template.html 樣板注入使用。
// 跨平台版本 (Node.js >= 18，需內建 fetch)，邏輯與 update-dashboard.ps1 對等。
//
// ADR / 匯率資料不在本腳本抓取範圍內，由呼叫端（Claude / merge-and-classify.mjs）另行提供。

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "data");
const STOCK_NO = "2330";
const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

function toNum(s) {
  if (s === null || s === undefined) return null;
  let t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "X" || t === "-") return null;
  t = t.replace(/^\+/, "");
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function rocToIso(rocDate) {
  // "115/07/21" -> "2026-07-21"
  const [y, m, d] = rocDate.split("/");
  const year = Number(y) + 1911;
  return `${year}-${m}-${d}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchDaily() {
  console.log("[1/4] 抓取 TWSE STOCK_DAY 近6個月日K...");
  const daily = [];
  const today = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const dateParam = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}01`;
    const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=${STOCK_NO}`;
    try {
      const resp = await fetchJson(url);
      if (resp.stat === "OK" && resp.data) {
        for (const row of resp.data) {
          daily.push({
            date: rocToIso(row[0]),
            volume: toNum(row[1]),
            open: toNum(row[3]),
            high: toNum(row[4]),
            low: toNum(row[5]),
            close: toNum(row[6]),
          });
        }
      }
    } catch (e) {
      console.warn(`  STOCK_DAY ${dateParam} 抓取失敗: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  const seen = new Set();
  const uniqSorted = daily
    .filter((d) => d.close !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .filter((d) => (seen.has(d.date) ? false : (seen.add(d.date), true)));
  console.log(`  取得 ${uniqSorted.length} 個交易日`);
  return uniqSorted;
}

async function fetchValuation(daily) {
  console.log("[2/4] 抓取本益比/殖利率/股價淨值比...");
  // BWIBBU_d 通常比STOCK_DAY慢一個交易日發布，從最新交易日往前找，最多回溯5個交易日
  for (let back = 0; back < 5; back++) {
    const idx = daily.length - 1 - back;
    if (idx < 0) break;
    const tryDate = daily[idx].date.replace(/-/g, "");
    const url = `https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date=${tryDate}&stockNo=${STOCK_NO}`;
    const resp = await fetchJson(url);
    if (resp.stat === "OK" && resp.data) {
      const row = resp.data.find((r) => r[0] === STOCK_NO);
      if (row) {
        console.log(`  採用 ${daily[idx].date} 的本益比資料（可能落後最新股價日期，因TWSE此報表發布較慢）`);
        return {
          date: daily[idx].date,
          closePrice: toNum(row[2]),
          dividendYield: toNum(row[3]),
          peRatio: toNum(row[5]),
          pbRatio: toNum(row[6]),
          epsPeriod: row[7],
        };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("BWIBBU_d 回溯5個交易日仍查無資料");
}

// 季度EPS只用來算「全年預估EPS估值」卡片，不是股價/K線/技術指標這些核心資料。
// t187ap14_L是「當季」彙總表，每季換新資料時會有幾天空窗期(例如新一季企業
// 還沒申報完，2330這一列可能暫時不在表裡)，這種情況不該讓整條pipeline失敗、
// 連帶把當天原本抓得到的股價資料也一起擋下來——所以抓不到就回傳null，讓
// merge-and-classify.mjs的官方預估區塊照既有邏輯(try/catch)優雅地略過即可。
async function fetchEpsInfo() {
  console.log("[3/4] 抓取最新季度EPS (t187ap14_L)...");
  try {
    const rows = await fetchJson("https://openapi.twse.com.tw/v1/opendata/t187ap14_L");
    const row = rows.find((r) => r["公司代號"] === STOCK_NO);
    if (!row) throw new Error("t187ap14_L 查無2330資料");
    return {
      year: row["年度"],
      season: row["季別"],
      eps: toNum(row["基本每股盈餘(元)"]),
      revenue: toNum(row["營業收入"]),
      netIncome: toNum(row["稅後淨利"]),
    };
  } catch (e) {
    console.warn(`  季度EPS抓取失敗，epsInfo維持null: ${e.message}`);
    return null;
  }
}

function sma(arr, idx, period) {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) sum += arr[i];
  return sum / period;
}

function stdDev(arr, idx, period) {
  if (idx < period - 1) return null;
  const mean = sma(arr, idx, period);
  let sumSq = 0;
  for (let i = idx - period + 1; i <= idx; i++) sumSq += (arr[i] - mean) ** 2;
  return Math.sqrt(sumSq / period);
}

function emaSeries(arr, period) {
  const n = arr.length;
  const out = new Array(n).fill(null);
  const k = 2 / (period + 1);
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += arr[j];
      out[i] = sum / (i + 1);
    } else {
      out[i] = (arr[i] - out[i - 1]) * k + out[i - 1];
    }
  }
  return out;
}

// KD隨機指標(9,3,3)：RSV = (收盤 - 近9日最低價) / (近9日最高價 - 近9日最低價) * 100，
// K/D 用 2/3 前值 + 1/3 新值 平滑，起始基準值採慣例的 50。
function computeKD(daily, period = 9) {
  const n = daily.length;
  const k = new Array(n).fill(null);
  const d = new Array(n).fill(null);
  let prevK = 50, prevD = 50;
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, daily[j].high);
      ll = Math.min(ll, daily[j].low);
    }
    const rsv = hh === ll ? 50 : ((daily[i].close - ll) / (hh - ll)) * 100;
    const kVal = (prevK * 2 + rsv) / 3;
    const dVal = (prevD * 2 + kVal) / 3;
    k[i] = kVal;
    d[i] = dVal;
    prevK = kVal;
    prevD = dVal;
  }
  return { k, d };
}

function computeIndicators(daily) {
  console.log("[4/4] 計算技術指標...");
  const closes = daily.map((d) => d.close);
  const n = closes.length;
  const kd = computeKD(daily);

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => (ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null));

  const validMacdIdx = [];
  const validMacdVals = [];
  macdLine.forEach((v, i) => {
    if (v !== null) {
      validMacdIdx.push(i);
      validMacdVals.push(v);
    }
  });
  const signalPartial = emaSeries(validMacdVals, 9);
  const signalLine = new Array(n).fill(null);
  signalPartial.forEach((v, i) => {
    if (v !== null) signalLine[validMacdIdx[i]] = v;
  });

  // RSI(14) Wilder
  const rsi = new Array(n).fill(null);
  if (n > 14) {
    let gains = 0,
      losses = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      gains += Math.max(d, 0);
      losses += Math.max(-d, 0);
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    rsi[14] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = 15; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      const gain = Math.max(d, 0);
      const loss = Math.max(-d, 0);
      avgGain = (avgGain * 13 + gain) / 14;
      avgLoss = (avgLoss * 13 + loss) / 14;
      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  const indicators = daily.map((d, i) => {
    const ma20 = sma(closes, i, 20);
    const sd = stdDev(closes, i, 20);
    const bbUpper = ma20 !== null && sd !== null ? ma20 + 2 * sd : null;
    const bbLower = ma20 !== null && sd !== null ? ma20 - 2 * sd : null;
    const macd = macdLine[i];
    const signal = signalLine[i];
    return {
      date: d.date,
      ma5: sma(closes, i, 5),
      ma20,
      ma60: sma(closes, i, 60),
      bbUpper,
      bbMid: ma20,
      bbLower,
      rsi14: rsi[i],
      macd,
      signal,
      histogram: macd !== null && signal !== null ? macd - signal : null,
      k: kd.k[i],
      d: kd.d[i],
    };
  });

  const latestRsi = [...indicators].reverse().find((r) => r.rsi14 !== null)?.rsi14 ?? null;
  return { indicators, latestRsi };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const daily = await fetchDaily();
  const valuation = await fetchValuation(daily);
  const epsInfo = await fetchEpsInfo();
  const { indicators, latestRsi } = computeIndicators(daily);

  const result = {
    generatedAt: new Date().toISOString(),
    stockNo: STOCK_NO,
    daily,
    indicators,
    valuation,
    epsInfo,
    latestRsi,
    adr: null,
    fxRate: null,
  };

  const outFile = join(OUT_DIR, "data.json");
  await writeFile(outFile, JSON.stringify(result), "utf8");
  console.log(`已輸出: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
