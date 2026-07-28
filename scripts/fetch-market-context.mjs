// 抓取「股市經理人視角」的補充參考資訊，合併進 data/data.json：
//   - marginTrading：台積電(2330)融資融券餘額 (TWSE OpenAPI MI_MARGN)
//   - soxIndex / taiexIndex：費城半導體指數(SOX)、加權指數(TAIEX) (Yahoo Finance)
//   - institutionalNet：三大法人（外資/投信/合計）買賣超 (TWSE 舊版 rwd/zh/fund/T86)
//   - exDividend：近期除權息預告 (TWSE OpenAPI TWT48U_ALL)
//   - optionsMarket：台指選擇權(TXO)未平倉 Put/Call Ratio (TAIFEX OpenAPI)
//   - chipTrend：規則式（非AI）籌碼面趨勢判讀（偏多/中性/偏空 + 理由），根據以上欄位加權計分
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
  const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
  const price = meta.regularMarketPrice;
  // 不能單純假設「倒數第二個有效收盤價」就是前一交易日：如果當天(跟regularMarketTime
  // 同一天)那筆是null會被filter掉，導致陣列整體往前偏移一格，「倒數第二」實際上會變成
  // 大前天的收盤價，算出的漲跌%會是好幾天的累積變化，不是真正的單日變化（歷史上TAIEX
  // 就出現過這個問題，SOX因為當天那筆剛好不是null才沒事，兩者用同一份邏輯卻表現不一致）。
  // 改成明確比對日期：從最新往回找，跳過跟regularMarketTime同一天的項目，取第一個「不同
  // 一天」的有效收盤價，不依賴陣列位置，才能保證永遠是真正的前一交易日。
  const latestDateKey = meta.regularMarketTime != null ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
  let previousClose = null;
  for (let i = timestamp.length - 1; i >= 0; i--) {
    const c = rawCloses[i];
    if (c == null) continue;
    const dateKey = new Date(timestamp[i] * 1000).toISOString().slice(0, 10);
    if (latestDateKey && dateKey === latestDateKey) continue;
    previousClose = c;
    break;
  }
  if (previousClose == null) previousClose = meta.previousClose ?? meta.chartPreviousClose;
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

// 台指期(TX)近月合約盤後交易時段(夜盤)最新成交/收盤價。跟fetchOptionsMarket同一個
// TAIFEX OpenAPI，用DailyMarketReportFut這個「期貨」版本的對應端點(Opt是選擇權版本)。
// 盤後(夜盤，15:00~次日05:00)交易與結算是併入「次一般交易時段」處理，不是獨立公告，
// 所以每日排程06:00執行時，前一晚05:00收盤的夜盤最後成交價理論上已經可以查得到。
// 近月合約：依「交易月份」字串排序取最小的一筆，避免自己手動算合約代碼(每月換月)。
//
// 欄位名稱已用實際回傳資料驗證過(2026-07-28 GitHub Actions run)：收盤價欄位是"Last"
// (SettlementPrice在盤後時段是字串"NULL"，隔天併入一般交易時段結算才會有值)，合約
// 月份欄位是"ContractMonth(Week)"，不是原本猜的"Close"/"ContractMonth"。
//
// openapi.taifex.com.tw僅提供「最新一個交易日」，沒有歷史查詢功能，沒辦法直接跟API要
// 前一天的收盤價來算漲跌%。改成把上一次寫進data.json的taifexNightClose當作前一天的
// 基準，跟這次新抓到的比較。夜盤要整個交易日（日盤+夜盤）都結束才會公布，所以如果排程
// 執行的時間點太早（例如手動在傍晚觸發，當天自己的夜盤還沒收），API仍會回傳跟上次一樣
// 的舊資料——這種情況下"date"會跟上一筆存的相同，此時不能拿來算漲跌%(會變成拿同一天
// 跟自己比較)，直接把changePct留null，等到真的有新一天的資料進來才計算。
async function fetchTaifexNightClose(previous) {
  const rows = await fetchJson("https://openapi.taifex.com.tw/v1/DailyMarketReportFut");
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("DailyMarketReportFut 回傳空資料");
  const night = rows.filter((r) => r["Contract"] === "TX" && r["TradingSession"] === "盤後");
  if (night.length === 0) {
    throw new Error(`找不到TX盤後(夜盤)時段資料，回傳筆數=${rows.length}，範例欄位=${JSON.stringify(Object.keys(rows[0] || {}))}`);
  }
  // 除錯用：印出所有候選合約，人工核對「近月」該取哪一筆——TX代碼下可能同時混著月合約
  // 跟週合約，光靠ContractMonth(Week)字串排序不一定挑得對，需要實際比對回傳內容才能確定。
  console.log(`[台指期夜盤] 找到 ${night.length} 筆TX盤後候選資料: ${JSON.stringify(night.map((r) => ({
    contractMonth: r["ContractMonth(Week)"], last: r["Last"], low: r["Low"], high: r["High"], volume: r["Volume"],
  })))}`);
  night.sort((a, b) => String(a["ContractMonth(Week)"]).localeCompare(String(b["ContractMonth(Week)"])));
  const row = night[0];
  const close = toNum(row["Last"]) ?? toNum(row["SettlementPrice"]);
  if (close == null) throw new Error(`TX盤後資料找到但無法解析收盤價欄位，原始資料=${JSON.stringify(row)}`);
  const rawDate = row["Date"];
  const date = rawDate && String(rawDate).length === 8
    ? `${String(rawDate).slice(0, 4)}-${String(rawDate).slice(4, 6)}-${String(rawDate).slice(6, 8)}`
    : null;
  let changePct = null;
  if (previous && previous.close != null && previous.date && date && previous.date !== date) {
    changePct = Math.round((close / previous.close - 1) * 10000) / 100;
  }
  return {
    contractMonth: row["ContractMonth(Week)"] || null,
    close,
    changePct,
    date,
  };
}

// 規則式（非AI）籌碼面趨勢判讀：把幾個方向性訊號依權重加總算分，避免單一指標誤判。
// 在資料抓取當下（而非瀏覽器端）就完成分類，做法比照 merge-and-classify.mjs 對
// Trailing/Forward PE 的估值分區判讀——分析結果是資料管線的一部分、可重現，不是
// 每次開頁面才臨時算的展示邏輯。
// 融資融券變化不計入方向分數（增減本身無明確多空意義，需搭配股價位置判斷），
// 只作為風險提示文字附加在摘要下方。
function classifyChipTrend(raw) {
  let score = 0, weightSum = 0;
  const reasons = [];
  const risk = [];

  if (raw.institutionalNet) {
    const inet = raw.institutionalNet;
    if (inet.foreignNetLots != null) {
      score += Math.sign(inet.foreignNetLots) * 1.5; weightSum += 1.5;
      reasons.push(`外資${inet.foreignNetLots >= 0 ? "買超" : "賣超"}${Math.abs(inet.foreignNetLots).toLocaleString("zh-TW")}張`);
    }
    if (inet.trustNetLots != null) {
      score += Math.sign(inet.trustNetLots) * 0.8; weightSum += 0.8;
      reasons.push(`投信${inet.trustNetLots >= 0 ? "買超" : "賣超"}${Math.abs(inet.trustNetLots).toLocaleString("zh-TW")}張`);
    }
  }
  if (raw.optionsMarket && raw.optionsMarket.putCallRatio != null) {
    const ratio = raw.optionsMarket.putCallRatio;
    const s = ratio > 1.05 ? -1 : ratio < 0.95 ? 1 : 0;
    score += s; weightSum += 1;
    reasons.push(`選擇權Put/Call Ratio ${ratio.toFixed(2)}${s > 0 ? "（看多氣氛較濃）" : s < 0 ? "（避險氣氛較濃）" : "（中性）"}`);
  }
  if (raw.soxIndex && raw.soxIndex.changePct != null) {
    score += Math.sign(raw.soxIndex.changePct) * 0.6; weightSum += 0.6;
    reasons.push(`SOX費半指數${raw.soxIndex.changePct >= 0 ? "上漲" : "下跌"}${Math.abs(raw.soxIndex.changePct).toFixed(2)}%`);
  }
  if (raw.taiexIndex && raw.taiexIndex.changePct != null) {
    score += Math.sign(raw.taiexIndex.changePct) * 0.4; weightSum += 0.4;
    reasons.push(`加權指數${raw.taiexIndex.changePct >= 0 ? "上漲" : "下跌"}${Math.abs(raw.taiexIndex.changePct).toFixed(2)}%`);
  }
  if (raw.marginTrading) {
    const mt = raw.marginTrading;
    if (mt.marginBalance != null && mt.marginBalancePrev != null) {
      const chg = mt.marginBalance - mt.marginBalancePrev;
      if (chg > 0) risk.push(`融資餘額增加${chg.toLocaleString("zh-TW")}張（槓桿部位上升，留意回檔時的斷頭賣壓）`);
      else if (chg < 0) risk.push(`融資餘額減少${Math.abs(chg).toLocaleString("zh-TW")}張（籌碼去化中）`);
    }
    if (mt.shortBalance != null && mt.shortBalancePrev != null) {
      const chg = mt.shortBalance - mt.shortBalancePrev;
      if (chg > 0) risk.push(`融券餘額增加${chg.toLocaleString("zh-TW")}張（空方力道增溫，亦可能成為軋空燃料）`);
    }
  }

  if (weightSum === 0) return null;
  const avg = score / weightSum;
  const verdict = avg >= 0.34 ? "偏多" : avg <= -0.34 ? "偏空" : "中性";
  const cls = avg >= 0.34 ? "up" : avg <= -0.34 ? "down" : "";
  return { verdict, cls, reasons, risk };
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
  const previousTaifexNightClose = raw.taifexNightClose;
  raw.taifexNightClose = await safe("台指期夜盤收盤", () => fetchTaifexNightClose(previousTaifexNightClose));
  raw.institutionalNet = await safe("三大法人買賣超", () => fetchInstitutionalNet(raw.daily));
  raw.exDividend = await safe("除權息預告", fetchExDividend);
  raw.optionsMarket = await safe("選擇權未平倉", fetchOptionsMarket);
  raw.chipTrend = await safe("籌碼面趨勢判讀", () => classifyChipTrend(raw));

  await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  console.log("已更新 marginTrading / soxIndex / taiexIndex / taifexNightClose / institutionalNet / exDividend / optionsMarket / chipTrend");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
