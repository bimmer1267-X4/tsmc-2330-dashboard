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

async function fetchLiveQuote() {
  const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const item = json.msgArray && json.msgArray[0];
  if (!item) throw new Error("回應中沒有 msgArray[0]（可能不是交易時段，或股票代碼錯誤）");

  // z = 成交價；盤中尚無成交時 z 會是 "-"，退回昨收 y
  const price = toNum(item.z) ?? toNum(item.y);
  if (price == null) throw new Error("無法解析報價（z/y 皆為空）");

  // item.d 格式如 "20260727"
  const d = item.d;
  const date = d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
  if (!date) throw new Error(`無法解析報價日期: ${d}`);

  return { date, time: item.t || null, price };
}

async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const liveQuote = await fetchLiveQuote();
  raw.liveQuote = liveQuote;
  await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  console.log(`已更新 liveQuote: ${liveQuote.date} ${liveQuote.time} ${liveQuote.price}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
