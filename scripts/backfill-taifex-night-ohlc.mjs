// 一次性資料回填腳本(用完即刪)：把data/taifex-night-history.json裡舊有「只有收盤價」
// 的種子歷史列(使用者最早提供的384筆CSV，只有收盤價/漲跌幅，沒有開高低量)，用TAIFEX
// 官方futDataDown端點(見fetch-market-context.mjs的fetchTaifexFutDataDownCsv同一段
// 註解)補上真正的開高低收(OHLC)跟成交量，讓夜盤K線圖全部都能畫出真正的蠟燭，不用再
// 退化成實心圓點。
//
// 只補「目前缺少open欄位」的既有列，不覆蓋收盤價——收盤價已經是既有模型(V4迴歸、預測
// 準確度追蹤...)在用的既定值，這裡只新增原本沒有的欄位，把改動範圍縮到最小。如果官方
// 資料的收盤價跟既有紀錄對不上，印出警告但仍保留既有值，不自動覆蓋(避免不小心引入跟
// 既有模型口徑不一致的數字)。
//
// 分段查詢+自適應縮小區間：實測發現futDataDown這個表單對查詢區間長度有伺服器端限制，
// 超過門檻不會回傳CSV，而是安靜地回傳整個網站的HTML首頁/查無資料頁面(HTTP狀態碼還是
// 200，不會丟錯)。門檻沒有公開文件，實測5天內可以正常查到資料、36天就會被拒絕，確切
// 邊界不明。改用「先試大區間，拿到HTML就對半拆成兩段重試，縮到最小區間仍失敗才放棄」
// 的自適應做法，不用猜確切門檻也能自動找到可行的查詢粒度。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, "..", "data", "taifex-night-history.json");
const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";
const MIN_CHUNK_DAYS = 2; // 自適應縮小的下限，縮到這個天數還被拒絕就放棄該區間

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "X" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function fmtDate(d) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function looksLikeHtml(text) {
  return /<!DOCTYPE|<html/i.test(text.slice(0, 300));
}

async function fetchRaw(startDate, endDate) {
  const params = new URLSearchParams({
    down_type: "1",
    commodity_id: "TX",
    commodity_id2: "",
    queryStartDate: fmtDate(startDate),
    queryEndDate: fmtDate(endDate),
  });
  const res = await fetch("https://www.taifex.com.tw/cht/3/futDataDown", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`futDataDown HTTP ${res.status} (${fmtDate(startDate)}~${fmtDate(endDate)})`);
  const buf = await res.arrayBuffer();
  return new TextDecoder("big5").decode(buf);
}

function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
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
  });
}

async function fetchChunkAdaptive(startDate, endDate) {
  const text = await fetchRaw(startDate, endDate);
  if (looksLikeHtml(text)) {
    const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
    if (days <= MIN_CHUNK_DAYS) {
      console.warn(`  區間 ${fmtDate(startDate)}~${fmtDate(endDate)} 已縮到最小(${MIN_CHUNK_DAYS}天)仍被拒絕(回傳HTML)，放棄此區間`);
      return [];
    }
    const midOffset = Math.floor(days / 2);
    const mid = new Date(startDate.getTime() + midOffset * 86400000);
    console.log(`  區間 ${fmtDate(startDate)}~${fmtDate(endDate)}(${days}天) 太大被拒絕(回傳HTML)，拆成兩半重試...`);
    await sleep(300);
    const a = await fetchChunkAdaptive(startDate, mid);
    await sleep(300);
    const b = await fetchChunkAdaptive(new Date(mid.getTime() + 86400000), endDate);
    return [...a, ...b];
  }
  return parseCsvRows(text);
}

async function main() {
  const history = JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  console.log(`讀入現有歷史紀錄 ${history.length} 筆`);

  const needsFill = history.filter((h) => h.open == null);
  console.log(`其中 ${needsFill.length} 筆缺少開高低量，需要回填`);
  if (needsFill.length === 0) {
    console.log("沒有需要回填的資料，結束。");
    return;
  }

  const rangeStart = new Date("2025-01-01T00:00:00Z");
  const rangeEnd = new Date();
  const chunkDays = 30; // 起始嘗試的區間大小，太大會被自適應拆分機制自動處理

  const byDate = new Map(); // "yyyy-mm-dd" -> {open, high, low, close, volume}
  let cursor = rangeStart;
  let chunkIndex = 0;
  while (cursor < rangeEnd) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + chunkDays * 86400000, rangeEnd.getTime()));
    chunkIndex += 1;
    console.log(`[${chunkIndex}] 查詢區間 ${fmtDate(cursor)} ~ ${fmtDate(chunkEnd)}...`);
    let rows;
    try {
      rows = await fetchChunkAdaptive(cursor, chunkEnd);
    } catch (e) {
      console.error(`  查詢失敗，略過此區間: ${e.message}`);
      cursor = new Date(chunkEnd.getTime() + 86400000);
      await sleep(500);
      continue;
    }
    const night = rows.filter((r) => r.contract === "TX" && r.session === "盤後" && !r.contractMonth.includes("/"));
    // 依日期分組，同一天取近月合約(到期月份字串最小的一筆)
    const byDateInChunk = new Map();
    for (const r of night) {
      const iso = r.date.replace(/\//g, "-");
      const existing = byDateInChunk.get(iso);
      if (!existing || r.contractMonth.localeCompare(existing.contractMonth) < 0) {
        byDateInChunk.set(iso, r);
      }
    }
    for (const [iso, r] of byDateInChunk) {
      byDate.set(iso, { open: r.open, high: r.high, low: r.low, close: r.settlement ?? r.close, volume: r.volume });
    }
    console.log(`  這段查到 ${byDateInChunk.size} 個交易日的夜盤資料`);
    cursor = new Date(chunkEnd.getTime() + 86400000);
    await sleep(500);
  }

  console.log(`總共從官方查到 ${byDate.size} 個交易日的夜盤OHLC`);

  let filled = 0, missing = 0, mismatched = 0;
  for (const h of history) {
    if (h.open != null) continue;
    const official = byDate.get(h.date);
    if (!official) {
      missing += 1;
      continue;
    }
    if (h.close != null && official.close != null && Math.abs(h.close - official.close) > 0.5) {
      mismatched += 1;
      console.warn(`  ${h.date} 收盤價不一致：既有=${h.close}，官方=${official.close}，保留既有值，只補OHLC`);
    }
    h.open = official.open;
    h.high = official.high;
    h.low = official.low;
    h.volume = official.volume;
    filled += 1;
  }
  console.log(`已補上 ${filled} 筆的開高低量；${missing} 筆官方查無資料(維持原樣，前端會退化顯示)；發現 ${mismatched} 筆收盤價與既有紀錄不一致(保留既有值)`);

  history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await writeFile(HISTORY_PATH, JSON.stringify(history), "utf8");
  console.log(`已寫回 ${HISTORY_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
