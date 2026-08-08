// 暫時性診斷腳本(第二輪)：查核「台指期夜盤收盤價」抓取異常，這次刻意把查詢區間延伸到
// 未來日期(2026/08/10)，驗證TAIFEX官方交易日期標籤是否採「下一個正式交易日」語意——
// 也就是查核「開盤8/7 15:00、收盤8/8 05:00」這場夜盤，是否真的要用交易日期=2026/08/10
// 才查得到(對應TAIFEX網頁版futDailyMarketReport使用者實測結果：輸入日期2026/08/10才能
// 查到2026/08/07 15:00~次日05:00這場的資料)。
// 完整複製fetch-market-context.mjs裡fetchTaifexFutDataDownCsv()的邏輯(不import，因為
// 那支檔案本身main()會被一起執行)，把完整原始CSV跟篩選出的所有TX盤後列都印出來。
// 診斷完成、確認根因後就會把這支腳本跟對應的debug-taifex.yml一起移除，不會留在repo裡。

const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "X" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
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

async function runQuery(label, startDate, endDate) {
  console.log(`\n########## 查詢區間: ${label} (${startDate} ~ ${endDate}) ##########`);
  let text;
  try {
    text = await fetchTaifexFutDataDownCsv(startDate, endDate);
  } catch (e) {
    console.log(`查詢失敗: ${e.message}`);
    return;
  }
  const rows = parseCsv(text);
  const txRows = rows.filter((r) => r.contract === "TX");
  console.log(`共${rows.length}列，其中contract===TX的有${txRows.length}列`);

  console.log("--- 8月份(2026/08)所有TX列 ---");
  for (const r of txRows.filter((r) => r.date.startsWith("2026/08"))) {
    console.log(JSON.stringify({
      date: r.date, contractMonth: r.contractMonth, session: r.session,
      open: r.open, high: r.high, low: r.low, close: r.close,
      changePrice: r.changePrice, changePct: r.changePct,
      volume: r.volume, settlement: r.settlement,
    }));
  }

  console.log("--- 特別找 交易日期===2026/08/10 的列(不論contract/session) ---");
  const aug10 = rows.filter((r) => r.date === "2026/08/10");
  if (aug10.length === 0) {
    console.log("(完全沒有交易日期=2026/08/10的列)");
  } else {
    for (const r of aug10) console.log(r.raw);
  }
}

async function main() {
  // 原本的查詢範圍(往回5天到「今天」8/8)，重現原本的bug，確認依然查不到08/10這筆
  await runQuery("原本邏輯：往回5天到今天(2026/08/08)", "2026/07/24", "2026/08/08");

  // 延伸到2026/08/10(含)，驗證這筆是否真的存在、只是原本查詢範圍沒涵蓋到
  await runQuery("延伸查詢：到2026/08/10", "2026/07/24", "2026/08/10");

  // 再延伸到2026/08/12，確認沒有因為查詢範圍抓太準剛好卡在邊界
  await runQuery("再延伸查詢：到2026/08/12", "2026/07/24", "2026/08/12");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
