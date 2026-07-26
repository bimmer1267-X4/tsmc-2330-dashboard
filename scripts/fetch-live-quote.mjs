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

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// 回傳 null 代表「今天大概不是交易日／目前沒有可用報價」，這是預期內會發生的情況
// （例如國定假日排程照樣每5分鐘觸發一次），呼叫端應該安靜跳過，不要當成錯誤讓
// workflow 失敗——不然遇到連續假期，Actions 頁面會整天被同一個原因的紅色 X 洗版。
// 真正的錯誤（HTTP 失敗、JSON 格式不對）還是照樣 throw，讓 workflow 顯示失敗，
// 因為那種才是真的需要留意的異常。
async function fetchLiveQuote() {
  const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
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

async function main() {
  const liveQuote = await fetchLiveQuote();
  if (!liveQuote) {
    console.log("目前沒有可用的即時報價（可能不是交易日，或尚未開盤），本次跳過。");
    return;
  }
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  raw.liveQuote = liveQuote;
  await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  console.log(`已更新 liveQuote: ${liveQuote.date} ${liveQuote.time} ${liveQuote.price}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
