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

// 台指期(TX)近月合約盤後(夜盤)收盤價的「校正」。
//
// 原本用openapi.taifex.com.tw/v1/DailyMarketReportFut，2026-08-05實測發現這個「即時」API
// 其實是每日批次更新一次，夜盤交易時段內完全不會變(細節見fetch-market-context.mjs的
// fetchTaifexFutDataDownCsv同一段註解)。改用TAIFEX官方網站自己的「期貨每日交易行情下載」
// 表單端點(futDataDown)，同一段驗證已確認這個端點會即時反映夜盤交易中的最新成交，且
// 結算價(SettlementPrice)算出來之前是"-"、算出來後才有數字，天然就能拿來判斷「這場夜盤
// 到底收盤了沒」。
//
// fetch-market-context.mjs在06:00當天第一次抓的時候，官方結算價通常還沒算出來(要併入
// 08:45後的一般交易時段才會有值)，只能先用當時的最後成交價頂著。這裡趁交易時段每5分鐘
// 都會執行一次的機會，重抓同一個端點，一旦結算價出現就自動覆蓋掉暫定值；date沒變就代表
// 還是同一個夜盤，changePct/changePts(相對前一場夜盤)維持原本算好的值不動，只換掉
// close/open/high/low/volume這幾個「這場夜盤本身」的欄位。
async function refreshTaifexNightClose(raw) {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  const endStr = `${taipei.getUTCFullYear()}/${String(taipei.getUTCMonth() + 1).padStart(2, "0")}/${String(taipei.getUTCDate()).padStart(2, "0")}`;
  const startTaipei = new Date(taipei.getTime() - 5 * 24 * 3600 * 1000);
  const startStr = `${startTaipei.getUTCFullYear()}/${String(startTaipei.getUTCMonth() + 1).padStart(2, "0")}/${String(startTaipei.getUTCDate()).padStart(2, "0")}`;

  const params = new URLSearchParams({
    down_type: "1",
    commodity_id: "TX",
    commodity_id2: "",
    queryStartDate: startStr,
    queryEndDate: endStr,
  });
  const res = await fetch("https://www.taifex.com.tw/cht/3/futDataDown", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`futDataDown HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder("big5").decode(buf);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return;
  // 欄位順序驗證見fetch-market-context.mjs的fetchTaifexFutDataDownCsv同一段註解。
  const night = lines
    .slice(1)
    .map((line) => {
      const c = line.split(",");
      return {
        date: c[0],
        contract: c[1],
        contractMonth: (c[2] || "").trim(),
        open: toNum(c[3]),
        high: toNum(c[4]),
        low: toNum(c[5]),
        close: toNum(c[6]),
        volume: toNum(c[9]),
        settlement: toNum(c[10]),
        session: c[17],
      };
    })
    .filter((r) => r.contract === "TX" && r.session === "盤後" && !r.contractMonth.includes("/"));
  if (night.length === 0) return;
  const maxDate = night.reduce((m, r) => (r.date > m ? r.date : m), night[0].date);
  const candidates = night.filter((r) => r.date === maxDate).sort((a, b) => a.contractMonth.localeCompare(b.contractMonth));
  const row = candidates[0];
  const close = row.settlement ?? row.close;
  if (close == null) return;
  const { open, high, low, volume } = row;
  const date = row.date.replace(/\//g, "-");
  if (!date) return;

  const prev = raw.taifexNightClose;
  if (!prev || prev.date !== date) {
    const changePct = prev && prev.close != null ? Math.round((close / prev.close - 1) * 10000) / 100 : null;
    const changePts = prev && prev.close != null ? Math.round((close - prev.close) * 100) / 100 : null;
    raw.taifexNightClose = { contractMonth: row.contractMonth || null, close, changePct, changePts, open, high, low, volume, date };
  } else if (prev.close !== close || prev.open !== open || prev.high !== high || prev.low !== low || prev.volume !== volume) {
    raw.taifexNightClose = { ...prev, close, open, high, low, volume, contractMonth: row.contractMonth || prev.contractMonth };
    console.log(`已校正 taifexNightClose: 收盤 ${prev.close} -> ${close}`);
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
