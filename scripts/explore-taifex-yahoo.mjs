// 一次性診斷腳本：探勘 Yahoo奇摩股市台指期貨「技術分析」頁面，看看背後有沒有可用的
// 歷史資料來源。這個沙盒環境連不到tw.stock.yahoo.com，只能透過GitHub Actions(有網路)
// 執行、把結果存成artifact抓回來看。不進日常排程，純粹用來決定下一步怎麼做：
//   1. 最理想：攔截到頁面內部呼叫的JSON API，直接回傳一段歷史每日收盤價 → 之後可以
//      直接串接這個API，不用碰瀏覽器渲染的DOM，回到跟現有pipeline一致的風格。
//   2. 次理想：頁面上有<table>把歷史資料渲染出來，但沒有獨立API可攔截 → 只能考慮
//      DOM爬蟲，但比較脆弱。
//   3. 最差：頁面只顯示「今天」的數字，沒有歷史 → 放棄這個資料源。
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT_DIR = "./explore-output";
const TARGET_URL = "https://tw.stock.yahoo.com/future/WTX&/technical-analysis";

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const jsonResponses = [];
  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on("response", async (res) => {
    const url = res.url();
    const contentType = res.headers()["content-type"] || "";
    if (!contentType.includes("json")) return;
    try {
      const body = await res.text();
      jsonResponses.push({ url, status: res.status(), bodyPreview: body.slice(0, 5000) });
    } catch {
      // 有些回應可能因為頁面已經跳轉而讀不到body，忽略即可，不影響其他攔截結果。
    }
  });

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  let navError = null;
  try {
    await page.goto(TARGET_URL, { waitUntil: "networkidle", timeout: 30000 });
    // 技術分析頁面可能有額外的圖表載入動畫，多等一下讓非同步請求打完。
    await page.waitForTimeout(3000);
  } catch (e) {
    navError = String(e.message || e);
  }

  await page.screenshot({ path: `${OUT_DIR}/screenshot.png`, fullPage: true }).catch(() => {});

  const tables = await page.$$eval("table", (els) =>
    els.map((el) => el.innerText)
  ).catch(() => []);

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");

  const pageTitle = await page.title().catch(() => "");

  await browser.close();

  await writeFile(`${OUT_DIR}/json-responses.json`, JSON.stringify(jsonResponses, null, 2), "utf8");
  await writeFile(`${OUT_DIR}/tables.json`, JSON.stringify(tables, null, 2), "utf8");
  await writeFile(`${OUT_DIR}/body-text.txt`, bodyText, "utf8");
  await writeFile(
    `${OUT_DIR}/summary.json`,
    JSON.stringify({ pageTitle, navError, consoleErrors, jsonResponseCount: jsonResponses.length, tableCount: tables.length }, null, 2),
    "utf8"
  );

  console.log(`頁面標題: ${pageTitle}`);
  console.log(`導航錯誤: ${navError ?? "無"}`);
  console.log(`攔截到的JSON回應數: ${jsonResponses.length}`);
  jsonResponses.forEach((r) => console.log(`  - ${r.status} ${r.url}`));
  console.log(`偵測到的<table>數量: ${tables.length}`);
  console.log(`已將截圖/JSON dump/表格內容/頁面文字存到 ${OUT_DIR}/`);
}

main().catch((e) => {
  console.error("探勘腳本執行失敗: " + e.message);
  process.exit(1);
});
