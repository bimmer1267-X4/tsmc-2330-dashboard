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

// 台指期(TX)近月合約盤後(夜盤)收盤價的「校正」：fetch-market-context.mjs在06:00當天第一次
// 抓的時候，官方結算價(SettlementPrice)通常還沒算出來(要併入08:45後的一般交易時段才會有
// 值)，只能先用當時的最後成交價(Last)頂著，跟官方結算價可能有落差(曾實測差到197點)。這裡
// 趁交易時段每5分鐘都會執行一次的機會，重抓同一支API，一旦SettlementPrice出現就自動覆蓋掉
// 暫定的Last值；date沒變就代表還是同一個夜盤，changePct(相對前一天)維持原本算好的值不動，
// 只換掉close本身。
async function refreshTaifexNightClose(raw) {
  const url = "https://openapi.taifex.com.tw/v1/DailyMarketReportFut";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return;
  const night = rows.filter((r) => r["Contract"] === "TX" && r["TradingSession"] === "盤後");
  if (night.length === 0) return;
  night.sort((a, b) => String(a["ContractMonth(Week)"]).localeCompare(String(b["ContractMonth(Week)"])));
  const row = night[0];
  const close = toNum(row["SettlementPrice"]) ?? toNum(row["Last"]);
  if (close == null) return;
  const rawDate = row["Date"];
  const date = rawDate && String(rawDate).length === 8
    ? `${String(rawDate).slice(0, 4)}-${String(rawDate).slice(4, 6)}-${String(rawDate).slice(6, 8)}`
    : null;
  if (!date) return;

  const prev = raw.taifexNightClose;
  if (!prev || prev.date !== date) {
    const changePct = prev && prev.close != null ? Math.round((close / prev.close - 1) * 10000) / 100 : null;
    raw.taifexNightClose = { contractMonth: row["ContractMonth(Week)"] || null, close, changePct, date };
  } else if (prev.close !== close) {
    raw.taifexNightClose = { ...prev, close, contractMonth: row["ContractMonth(Week)"] || prev.contractMonth };
    console.log(`已校正 taifexNightClose 收盤價: ${prev.close} -> ${close}`);
  }
}

async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  let changed = false;

  const liveQuote = await fetchLiveQuote();
  if (liveQuote) {
    raw.liveQuote = liveQuote;
    changed = true;
    console.log(`已更新 liveQuote: ${liveQuote.date} ${liveQuote.time} ${liveQuote.price}`);
  } else {
    console.log("目前沒有可用的即時報價（可能不是交易日，或尚未開盤），本次跳過。");
  }

  const before = JSON.stringify(raw.taifexNightClose);
  await refreshTaifexNightClose(raw).catch((e) => {
    console.error("台指期夜盤收盤校正失敗（略過，不影響其他欄位）:", e.message);
  });
  if (JSON.stringify(raw.taifexNightClose) !== before) changed = true;

  if (changed) {
    await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
