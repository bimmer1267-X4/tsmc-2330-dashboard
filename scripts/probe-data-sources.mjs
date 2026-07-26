// 診斷工具：測試新參考資訊功能的候選資料源在「伺服器端」是否可行。
// 純唯讀、不寫檔、不修改 data.json，只印出每個候選端點的 HTTP 狀態與回應內容片段，
// 用來確認 URL 是否正確、資料格式長什麼樣子。用完評估結果後這支腳本可以視情況保留或移除。
// 執行：node scripts/probe-data-sources.mjs

const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

const groups = [
  {
    title: "① 三大法人買賣超",
    sources: [
      { name: "TWSE OpenAPI - T86 (三大法人買賣金額統計表)", url: "https://openapi.twse.com.tw/v1/fund/T86" },
    ],
  },
  {
    title: "② 融資融券餘額",
    sources: [
      { name: "TWSE OpenAPI - MI_MARGN", url: "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN" },
      { name: "TWSE OpenAPI - TWTB4U", url: "https://openapi.twse.com.tw/v1/exchangeReport/TWTB4U" },
    ],
  },
  {
    title: "③ SOX / TAIEX 指數 (Yahoo Finance)",
    sources: [
      { name: "Yahoo Finance - ^SOX", url: "https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?range=5d&interval=1d" },
      { name: "Yahoo Finance - ^TWII", url: "https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?range=5d&interval=1d" },
    ],
  },
  {
    title: "④ TAIEX 官方來源 (備用)",
    sources: [
      { name: "TWSE OpenAPI - MI_INDEX", url: "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX" },
    ],
  },
  {
    title: "⑤ 除權息預告 / 法說會日期",
    sources: [
      { name: "TWSE OpenAPI - TWT48U_ALL (除權息預告)", url: "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL" },
      { name: "TWSE OpenAPI - 投資人說明會", url: "https://openapi.twse.com.tw/v1/opendata/t187ap46_L_11" },
    ],
  },
  {
    title: "⑥ 期貨/選擇權未平倉、Put/Call Ratio (TAIFEX)",
    sources: [
      { name: "TAIFEX OpenAPI - 選擇權每日行情", url: "https://openapi.taifex.com.tw/v1/DailyMarketReportOpt" },
      { name: "TAIFEX OpenAPI - 三大法人期貨未平倉", url: "https://openapi.taifex.com.tw/v1/OpenInterestOfTop10TradersFutures" },
    ],
  },
];

async function probeOne(source) {
  try {
    const res = await fetch(source.url, { headers: { "User-Agent": UA } });
    const text = await res.text();
    let shape = "(非 JSON 或空)";
    let sample = text.slice(0, 300);
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        shape = `JSON 陣列，共 ${json.length} 筆`;
        sample = JSON.stringify(json[0] ?? json.slice(0, 2), null, 2).slice(0, 500);
      } else if (json && typeof json === "object") {
        shape = `JSON 物件，keys: ${Object.keys(json).slice(0, 10).join(", ")}`;
        sample = JSON.stringify(json, null, 2).slice(0, 500);
      }
    } catch (e) {
      /* not JSON, keep raw sample */
    }
    console.log(`\n[${res.ok ? "OK " : "FAIL"}] ${source.name}`);
    console.log(`  URL: ${source.url}`);
    console.log(`  HTTP ${res.status}  ${shape}`);
    console.log(`  樣本: ${sample.replace(/\n/g, " ")}`);
  } catch (err) {
    console.log(`\n[ERR ] ${source.name}`);
    console.log(`  URL: ${source.url}`);
    console.log(`  錯誤: ${err.message}`);
  }
}

async function main() {
  for (const group of groups) {
    console.log(`\n${"=".repeat(60)}\n${group.title}\n${"=".repeat(60)}`);
    for (const source of group.sources) {
      await probeOne(source);
    }
  }
}

main();
