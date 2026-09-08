// 抓取台積電(2330)盤中即時報價（TWSE MIS API），更新 data/data.json 的 liveQuote 欄位。
// 只更新這一個欄位，其餘資料（日K、ADR、匯率、技術指標...）維持不動，交給每日完整流程處理。
// 供交易日盤中排程（例如每5分鐘）使用，讓首頁股價不用等隔日重跑就能反映最新成交價。
// 跨平台版本 (Node.js >= 18，需內建 fetch)，邏輯與 fetch-live-quote.ps1 對等。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "data.json");
const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

// 實測發現 TWSE MIS API 三不五時會出現連線層級的暫時性錯誤（TLS連線被對方重置，
// Node fetch 直接拋出 `TypeError: fetch failed` + cause ECONNRESET），跟「非交易
// 時段沒有報價」是不同性質的問題——這種屬於偶發的網路抖動，通常隔幾秒重試就會
// 恢復，不該讓整個 workflow 直接失敗。加上簡單的重試+退避，多給幾次機會；如果
// 重試完還是失敗，才讓錯誤往外拋，交由呼叫端判定為真正的異常。
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// "115/07/21" -> "2026-07-21"（TWSE STOCK_DAY用民國年）
function rocToIso(rocDate) {
  const [y, m, d] = rocDate.split("/");
  return `${Number(y) + 1911}-${m}-${d}`;
}

// 用Intl取得目前台北時間對應的YYYY-MM-DD，不依賴runner本身系統時區設定
// （GitHub Actions runner預設是UTC）。
function taipeiTodayIso() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// 對 TWSE MIS API 發出請求並解析 JSON，遇到連線層級的暫時性錯誤（ECONNRESET等）
// 或 HTTP 非 2xx 時會重試最多 FETCH_MAX_ATTEMPTS 次（每次間隔遞增），全部重試
// 完仍失敗才把最後一次的錯誤往外拋。
async function fetchStockInfoJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_MAX_ATTEMPTS) {
        console.warn(
          `抓取即時報價第${attempt}次嘗試失敗（${err.message}），${FETCH_RETRY_DELAY_MS / 1000}秒後重試...`
        );
        await sleep(FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastErr;
}

// 主要來源：TWSE MIS 即時報價（mis.twse.com.tw）。回傳 null 代表「目前沒有可用報價」
// （例如根本不是交易日，或msgArray/z/y都是空的這種正常但沒資料的情況），不是錯誤。
// 連線本身若重試完仍失敗，讓例外往外拋，交給 fetchLiveQuote() 判斷要不要改走備援。
async function fetchLiveQuoteViaMis() {
  const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0";
  const json = await fetchStockInfoJson(url);
  const item = json.msgArray && json.msgArray[0];
  if (!item) return null;

  // z = 成交價；盤中尚無成交時 z 會是 "-"，退回昨收 y
  const price = toNum(item.z) ?? toNum(item.y);
  if (price == null) return null;

  // item.d 格式如 "20260727"
  const d = item.d;
  const date = d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
  if (!date) return null;

  return { date, time: item.t || null, price };
}

// 備援來源：即時查詢 TWSE STOCK_DAY 日K報表（www.twse.com.tw，跟MIS是完全不同的
// 網域/系統）取得今天的收盤價。這支報表跟「近6個月K線圖」卡片(update-dashboard.mjs
// 的fetchDaily())用的是同一個API，實測MIS連續多次連線失敗期間，這支報表持續正常
// 運作，資料本質上可共用——只是它是「官方日K收盤」，不是「盤中即時成交價」，時間
// 固定寫官方收盤時間13:30:00，只有在「今天」這筆已經公告時才有意義。
// 回傳 null 代表TWSE還沒把今天的資料結算公告完成（正常情況，非錯誤）；HTTP/連線
// 層級的錯誤照樣往外拋。
async function fetchLiveQuoteViaStockDayFallback(todayIso) {
  const today = new Date();
  const dateParam = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}01`;
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${dateParam}&stockNo=2330`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`備援來源HTTP ${res.status}`);
  const resp = await res.json();
  if (resp.stat !== "OK" || !resp.data) return null;

  const row = resp.data.find((r) => rocToIso(r[0]) === todayIso);
  if (!row) return null; // 今天的資料還沒公告，非錯誤

  const price = toNum(row[6]); // 收盤價
  if (price == null) return null;
  return { date: todayIso, time: "13:30:00", price };
}

// 三層取得順序：
//   1. TWSE MIS 即時報價（含自身的連線重試）——唯一能反映「盤中」成交價的來源。
//   2. 若MIS重試後仍徹底失敗：先看 data.json 裡「近6個月K線圖」卡片(raw.daily)
//      是不是已經有今天這筆收盤資料（例如今天稍早已經成功跑過一次完整流程）——
//      有的話直接沿用，不必再發任何網路請求。
//   3. 本地也沒有的話，才即時重新查詢同一支STOCK_DAY報表（不同網域，通常不受
//      MIS本身的連線問題牽連）。
// 只有「MIS失敗、且備援也是真的連線/HTTP錯誤」才會讓錯誤最終往外拋、使workflow
// 顯示失敗；MIS或備援回應正常但單純還沒有資料，一律視為「目前沒有可用報價」安靜跳過。
async function fetchLiveQuote(raw) {
  try {
    return await fetchLiveQuoteViaMis();
  } catch (misErr) {
    console.warn(`主要來源(TWSE MIS)重試後仍失敗（${misErr.message}），改嘗試備援來源...`);

    const todayIso = taipeiTodayIso();
    const localToday = Array.isArray(raw.daily) ? raw.daily.find((d) => d.date === todayIso) : null;
    if (localToday && localToday.close != null) {
      console.log(`備援：沿用 data.json 既有「近6個月K線圖」資料中今天(${todayIso})的收盤價，不需額外連線。`);
      return { date: todayIso, time: "13:30:00", price: localToday.close };
    }

    try {
      const viaFallback = await fetchLiveQuoteViaStockDayFallback(todayIso);
      if (viaFallback) {
        console.log(`備援：即時查詢TWSE STOCK_DAY取得今天收盤價: ${viaFallback.price}`);
        return viaFallback;
      }
      console.log("主要來源與備援來源目前都還沒有今天的收盤資料，本次先跳過。");
      return null;
    } catch (fallbackErr) {
      console.error(`備援來源(TWSE STOCK_DAY)也失敗: ${fallbackErr.message}`);
      throw misErr;
    }
  }
}

async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));

  const liveQuote = await fetchLiveQuote(raw);
  if (liveQuote) {
    raw.liveQuote = liveQuote;
    console.log(`已更新 liveQuote: ${liveQuote.date} ${liveQuote.time} ${liveQuote.price}`);
    await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  } else {
    console.log("目前沒有可用的即時報價（可能不是交易日，或尚未開盤），本次跳過。");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
