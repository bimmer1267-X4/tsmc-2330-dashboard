// 一次性診斷腳本：探勘玩股網(wantgoo.com)台指期盤後(夜盤)頁面，看看能不能穩定/合法地
// 拿到比openapi.taifex.com.tw更新的夜盤資料——這個沙盒環境連不到wantgoo.com，只能透過
// GitHub Actions(有網路)執行、把結果存成artifact抓回來看。不進日常排程，純粹用來決定
// 下一步怎麼做：
//   0. 先查robots.txt，看這個路徑允不允許爬蟲存取——不允許的話直接放棄，不繼續往下。
//   1. 最理想：攔截到頁面內部呼叫的JSON API，直接回傳夜盤即時報價 → 之後可以直接串接
//      這個API，不用碰瀏覽器渲染的DOM，回到跟現有pipeline(openapi.taifex.com.tw)一致
//      的風格。
//   2. 次理想：頁面上有結構化的DOM可以穩定解析(例如固定的class名稱)，但沒有獨立API可
//      攔截 → 只能考慮DOM爬蟲，但比較脆弱，長期維護成本較高。
//   3. 最差：robots.txt不允許、或抓不到穩定的資料結構 → 放棄這個資料源，改用其他方式
//      (例如接受openapi.taifex.com.tw本身的延遲，或尋找其他來源)。
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT_DIR = "./explore-output";
const TARGET_URL = "https://www.wantgoo.com/futures/wtxp%26";
const ROBOTS_URL = "https://www.wantgoo.com/robots.txt";

async function checkRobots() {
  try {
    const res = await fetch(ROBOTS_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; tsmc-2330-dashboard-explore/1.0)" } });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    return { status: null, text: null, error: String(e.message || e) };
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`[0] 查詢 robots.txt: ${ROBOTS_URL}`);
  const robots = await checkRobots();
  await writeFile(`${OUT_DIR}/robots.txt`, robots.text ?? `(抓取失敗: ${robots.error})`, "utf8");
  console.log(`robots.txt 狀態碼: ${robots.status}`);
  if (robots.text) console.log(robots.text.slice(0, 2000));

  const jsonResponses = [];
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; tsmc-2330-dashboard-explore/1.0)" });

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
    // 即時報價頁面可能有輪詢(polling)更新，多等一下讓非同步請求打完。
    await page.waitForTimeout(5000);
  } catch (e) {
    navError = String(e.message || e);
  }

  await page.screenshot({ path: `${OUT_DIR}/screenshot.png`, fullPage: true }).catch(() => {});

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => "");
  const pageTitle = await page.title().catch(() => "");

  await browser.close();

  await writeFile(`${OUT_DIR}/json-responses.json`, JSON.stringify(jsonResponses, null, 2), "utf8");
  await writeFile(`${OUT_DIR}/body-text.txt`, bodyText, "utf8");
  await writeFile(
    `${OUT_DIR}/summary.json`,
    JSON.stringify({
      robotsStatus: robots.status,
      pageTitle,
      navError,
      consoleErrors,
      jsonResponseCount: jsonResponses.length,
    }, null, 2),
    "utf8"
  );

  console.log(`頁面標題: ${pageTitle}`);
  console.log(`導航錯誤: ${navError ?? "無"}`);
  console.log(`攔截到的JSON回應數: ${jsonResponses.length}`);
  jsonResponses.forEach((r) => console.log(`  - ${r.status} ${r.url}`));
  console.log(`已將robots.txt/截圖/JSON dump/頁面文字存到 ${OUT_DIR}/`);
}

main().catch((e) => {
  console.error("探勘腳本執行失敗: " + e.message);
  process.exit(1);
});
