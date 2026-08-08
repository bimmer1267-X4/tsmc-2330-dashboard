// 暫時性診斷腳本：查核「台指期夜盤收盤價」抓取異常(44543 vs TAIFEX官網查詢頁面看到的45033)。
// 完整複製fetch-market-context.mjs裡fetchTaifexFutDataDownCsv()的邏輯(不import，因為
// 那支檔案本身main()會被一起執行，這裡只想單純呼叫抓取函式)，改用更寬的日期範圍，把
// 完整原始CSV跟篩選出的所有TX盤後列都印出來，方便跟TAIFEX網頁版查詢結果逐欄比對。
// 診斷完成、確認根因後就會把這支腳本跟對應的debug-taifex.yml一起移除，不會留在repo裡。

const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "X" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function taipeiDateStr(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")}`;
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
  return text;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
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
      changePrice: toNum(c[7]),
      changePct: toNum(c[8]),
      volume: toNum(c[9]),
      settlement: toNum(c[10]),
      openInterest: toNum(c[11]),
      session: c[17],
      raw: line,
    };
  });
}

async function main() {
  const now = new Date();
  const endStr = taipeiDateStr(now);
  const startStr5 = taipeiDateStr(new Date(now.getTime() - 5 * 24 * 3600 * 1000));
  const startStr15 = taipeiDateStr(new Date(now.getTime() - 15 * 24 * 3600 * 1000));

  console.log("=== 執行時間資訊 ===");
  console.log("now (UTC):", now.toISOString());
  console.log("台北日期 (taipeiDateStr(now)):", endStr);
  console.log("正式程式碼fetchTaifexNightClose()目前會送出的查詢範圍(往回5天):", startStr5, "~", endStr);
  console.log("這支診斷腳本改用的查詢範圍(往回15天，確保涵蓋範圍更寬):", startStr15, "~", endStr);
  console.log("");

  const text = await fetchTaifexFutDataDownCsv(startStr15, endStr);
  console.log("=== futDataDown 完整原始CSV(Big5解碼後) ===");
  console.log(text);
  console.log("");

  const rows = parseCsv(text);
  console.log(`=== 解析出 ${rows.length} 列，篩選 contract===TX 的所有列 ===`);
  const txRows = rows.filter((r) => r.contract === "TX");
  for (const r of txRows) {
    console.log(JSON.stringify({
      date: r.date, contractMonth: r.contractMonth, session: r.session,
      open: r.open, high: r.high, low: r.low, close: r.close,
      changePrice: r.changePrice, changePct: r.changePct,
      volume: r.volume, settlement: r.settlement, openInterest: r.openInterest,
    }));
  }
  console.log("");

  console.log("=== 其中 session==='盤後'(夜盤)、非價差合約 的列 ===");
  const nightRows = txRows.filter((r) => r.session === "盤後" && !r.contractMonth.includes("/"));
  for (const r of nightRows) {
    console.log(JSON.stringify({
      date: r.date, contractMonth: r.contractMonth,
      open: r.open, high: r.high, low: r.low, close: r.close,
      changePrice: r.changePrice, changePct: r.changePct,
      volume: r.volume, settlement: r.settlement,
    }));
  }
  console.log("");

  console.log("=== 正式程式碼pickLatestNightRow()目前會選出的那一列(日期最大者，同日取到期月份字串最小) ===");
  if (nightRows.length === 0) {
    console.log("(沒有符合條件的列)");
  } else {
    const maxDate = nightRows.reduce((m, r) => (r.date > m ? r.date : m), nightRows[0].date);
    const candidates = nightRows.filter((r) => r.date === maxDate);
    candidates.sort((a, b) => a.contractMonth.localeCompare(b.contractMonth));
    console.log(JSON.stringify(candidates[0]));
  }

  console.log("");
  console.log("=== 跟目前data.json裡taifexNightClose(44543)、使用者TAIFEX網頁版查到的(45033)比對用 ===");
  console.log("目前data.json: open=44129 high=44873 low=43800 close=44543 volume=48375 date=2026-08-07");
  console.log("使用者網頁版(查詢日期輸入2026/08/10): open=44362 high=45246 low=44362 收盤(最後成交價)=45033 結算價=- 量=41042 (標題顯示2026/08/07 15:00~次日05:00盤後)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
