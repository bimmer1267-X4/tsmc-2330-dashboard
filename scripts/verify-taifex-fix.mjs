// 暫時性驗證腳本(2026-08-08)：驗證fetch-market-context.mjs修正1(queryEndDate往未來多推10
// 天)是否真的抓得到TAIFEX最新一場盤後資料。跟正式程式碼裡fetchTaifexNightClose完全一樣的
// 邏輯，複製出來單獨執行是為了避免連帶跑main()裡margin trading/institutional net等其他抓
// 取(那些不是這次要驗證的範圍，也不想意外寫壞data/data.json)。驗證完就會被刪除，不留在
// repo裡。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function toNum(s) {
  if (s == null) return null;
  const t = String(s).trim().replace(/,/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function fetchTaifexFutDataDownCsv(startDate, endDate) {
  const params = new URLSearchParams({
    down_type: "1",
    commodity_id: "TX",
    commodity_id2: "",
    queryStartDate: startDate,
    queryEndDate: endDate,
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
  if (lines.length < 2) throw new Error(`futDataDown回傳內容為空或格式不符：${text.slice(0, 200)}`);
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

function pickLatestNightRow(rows) {
  const night = rows.filter((r) => r.contract === "TX" && r.session === "盤後" && !r.contractMonth.includes("/"));
  if (night.length === 0) return null;
  const maxDate = night.reduce((m, r) => (r.date > m ? r.date : m), night[0].date);
  const candidates = night.filter((r) => r.date === maxDate);
  candidates.sort((a, b) => a.contractMonth.localeCompare(b.contractMonth));
  return candidates[0];
}

function taipeiDateStr(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")}`;
}

async function main() {
  const now = new Date();
  const nowTaipei = taipeiDateStr(now);

  // 舊邏輯(修正前)：queryEndDate只到今天。
  const oldEndStr = taipeiDateStr(now);
  // 新邏輯(修正後)：queryEndDate往未來多推10天。
  const newEndStr = taipeiDateStr(new Date(now.getTime() + 10 * 24 * 3600 * 1000));
  const startStr = taipeiDateStr(new Date(now.getTime() - 5 * 24 * 3600 * 1000));

  console.log(`現在台北時間日期：${nowTaipei}`);
  console.log(`舊查詢範圍：${startStr} ~ ${oldEndStr}`);
  console.log(`新查詢範圍：${startStr} ~ ${newEndStr}`);

  const rows = await fetchTaifexFutDataDownCsv(startStr, newEndStr);
  console.log(`\n本次抓到 ${rows.length} 列原始資料`);

  const night = rows.filter((r) => r.contract === "TX" && r.session === "盤後" && !r.contractMonth.includes("/"));
  console.log(`其中TX盤後(夜盤)、非價差合約列共 ${night.length} 筆，依交易日期排序：`);
  night
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .forEach((r) => {
      const inOldRange = r.date <= oldEndStr;
      console.log(
        `  ${r.date} 契約=${r.contractMonth} 開=${r.open} 高=${r.high} 低=${r.low} 收=${r.close} ` +
          `漲跌=${r.close != null ? "" : ""}量=${r.volume} 結算=${r.settlement} ` +
          `[${inOldRange ? "舊範圍內" : "只有新範圍能查到"}]`
      );
    });

  const withOldRange = pickLatestNightRow(rows.filter((r) => r.date <= oldEndStr));
  const withNewRange = pickLatestNightRow(rows);
  console.log(`\n舊邏輯(queryEndDate=今天)會挑到的最新一筆：${JSON.stringify(withOldRange)}`);
  console.log(`新邏輯(queryEndDate=+10天)會挑到的最新一筆：${JSON.stringify(withNewRange)}`);
  if (withOldRange?.date !== withNewRange?.date) {
    console.log(`\n=> 修正前後選到的"最新一筆"日期不同：舊=${withOldRange?.date} 新=${withNewRange?.date}，證實修正1確實改變了抓取結果。`);
  } else {
    console.log(`\n=> 修正前後選到的"最新一筆"日期相同(${withNewRange?.date})，目前這個執行時間點剛好沒有落在查詢範圍差異會影響結果的情況(例如非跨週末執行)。`);
  }
}

main().catch((e) => {
  console.error("驗證腳本執行失敗：", e);
  process.exit(1);
});
