// 抓取「股市經理人視角」的補充參考資訊，合併進 data/data.json：
//   - marginTrading：台積電(2330)融資融券餘額 (TWSE OpenAPI MI_MARGN)
//   - soxIndex / taiexIndex：費城半導體指數(SOX)、加權指數(TAIEX) (Yahoo Finance)
//   - institutionalNet：三大法人（外資/投信/合計）買賣超 (TWSE 舊版 rwd/zh/fund/T86)
//   - exDividend：近期除權息預告 (TWSE OpenAPI TWT48U_ALL)
//   - optionsMarket：台指選擇權(TXO)未平倉 Put/Call Ratio (TAIFEX OpenAPI)
// 每一段資料來源獨立 try/catch，單一來源失敗不影響其他欄位（沿用 merge-and-classify.mjs
// 一貫的容錯風格），失敗時該欄位維持 null，前端會顯示「暫無資料」而不是整頁壞掉。
// 跨平台版本 (Node.js >= 18)，邏輯與 fetch-market-context.ps1 對等。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "data.json");
const STOCK_NO = "2330";
const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "X" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// "1150805" (ROC，無分隔) -> "2026-08-05"
function rocCompactToIso(s) {
  if (!s || s.length !== 7) return null;
  const year = Number(s.slice(0, 3)) + 1911;
  return `${year}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// 融資融券餘額（TWSE OpenAPI 每日全市場快照，篩選單一個股）
async function fetchMarginTrading() {
  const rows = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN");
  const row = Array.isArray(rows) ? rows.find((r) => r["股票代號"] === STOCK_NO) : null;
  if (!row) throw new Error(`MI_MARGN 找不到股票代號 ${STOCK_NO}`);
  return {
    marginBuy: toNum(row["融資買進"]),
    marginSell: toNum(row["融資賣出"]),
    marginBalance: toNum(row["融資今日餘額"]),
    marginBalancePrev: toNum(row["融資前日餘額"]),
    shortBuy: toNum(row["融券買進"]),
    shortSell: toNum(row["融券賣出"]),
    shortBalance: toNum(row["融券今日餘額"]),
    shortBalancePrev: toNum(row["融券前日餘額"]),
  };
}

// Yahoo Finance 指數報價（與 merge-and-classify.mjs 的 fetchYahooDaily 邏輯一致：
// 用每日收盤序列的倒數第二筆算前收，避免 chartPreviousClose 可能跨多天導致漲跌%算錯）
async function fetchYahooIndex(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`Yahoo Finance 無資料: ${symbol}`);
  const { meta, timestamp = [] } = result;
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((v) => v != null);
  const price = meta.regularMarketPrice;
  const previousClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.previousClose ?? meta.chartPreviousClose);
  const changePct = previousClose ? Math.round((price / previousClose - 1) * 10000) / 100 : null;
  const quoteTime = new Date(meta.regularMarketTime * 1000).toISOString();
  return { price, changePct, quoteTime };
}

// 三大法人買賣超（個股）。OpenAPI /v1/fund/T86 回傳的是 HTML 錯誤頁（路徑錯誤），
// 改用與 STOCK_DAY / BWIBBU_d 相同風格的舊版 rwd 端點，且比照 fetchValuation 的作法，
// 從最新交易日往前回溯最多 5 個交易日（避免當天報表尚未發布時整項掛空）。
async function fetchInstitutionalNet(daily) {
  for (let back = 0; back < 5; back++) {
    const idx = daily.length - 1 - back;
    if (idx < 0) break;
    const tryDate = daily[idx].date.replace(/-/g, "");
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${tryDate}&selectType=ALL&response=json`;
    const resp = await fetchJson(url);
    if (resp.stat === "OK" && Array.isArray(resp.data)) {
      const row = resp.data.find((r) => r[0] === STOCK_NO);
      if (row) {
        const foreignNet = (toNum(row[4]) ?? 0) + (toNum(row[7]) ?? 0);
        const trustNet = toNum(row[10]);
        const totalNet = toNum(row[18]);
        return {
          date: daily[idx].date,
          foreignNetLots: Math.round(foreignNet / 1000),
          trustNetLots: trustNet != null ? Math.round(trustNet / 1000) : null,
          totalNetLots: totalNet != null ? Math.round(totalNet / 1000) : null,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("T86 回溯5個交易日仍查無2330資料");
}

// 除權息預告（篩選單一個股，取最近一筆；通常一次只有 0-1 筆，多筆的話取最早的日期）
async function fetchExDividend() {
  const rows = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL");
  const matches = Array.isArray(rows) ? rows.filter((r) => r["Code"] === STOCK_NO) : [];
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(a["Date"]).localeCompare(String(b["Date"])));
  const row = matches[0];
  return {
    date: rocCompactToIso(row["Date"]),
    type: row["Exdividend"] || null, // "息"=除息, "權"=除權, "權息"=兩者皆有
    cashDividend: toNum(row["CashDividend"]),
    stockDividendRatio: toNum(row["StockDividendRatio"]),
  };
}

// 台指選擇權(TXO)全月份加總未平倉 Put/Call Ratio。只取「一般」交易時段，避免跟盤後
// 時段的未平倉重複計算（OpenInterest 是狀態值，不是成交量，兩個時段各自列一次）。
async function fetchOptionsMarket() {
  const rows = await fetchJson("https://openapi.taifex.com.tw/v1/DailyMarketReportOpt");
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("DailyMarketReportOpt 回傳空資料");
  const txo = rows.filter((r) => r["Contract"] === "TXO" && r["TradingSession"] === "一般");
  if (txo.length === 0) throw new Error("找不到 TXO 一般時段資料");
  let callOI = 0, putOI = 0, date = null;
  for (const r of txo) {
    const oi = toNum(r["OpenInterest"]) ?? 0;
    if (r["CallPut"] === "買權") callOI += oi;
    else if (r["CallPut"] === "賣權") putOI += oi;
    date = date || r["Date"];
  }
  return {
    date: date && date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
    callOI,
    putOI,
    putCallRatio: callOI > 0 ? Math.round((putOI / callOI) * 10000) / 10000 : null,
  };
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[market-context] ${label} 失敗，該欄位維持 null: ${e.message}`);
    return null;
  }
}

async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));

  raw.marginTrading = await safe("融資融券餘額", fetchMarginTrading);
  raw.soxIndex = await safe("SOX指數", () => fetchYahooIndex("^SOX"));
  raw.taiexIndex = await safe("TAIEX指數", () => fetchYahooIndex("^TWII"));
  raw.institutionalNet = await safe("三大法人買賣超", () => fetchInstitutionalNet(raw.daily));
  raw.exDividend = await safe("除權息預告", fetchExDividend);
  raw.optionsMarket = await safe("選擇權未平倉", fetchOptionsMarket);

  await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  console.log("已更新 marginTrading / soxIndex / taiexIndex / institutionalNet / exDividend / optionsMarket");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
