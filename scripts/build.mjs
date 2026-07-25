// 將 data/data.json 的內容注入 dashboard.template.html 的 __DASHBOARD_DATA__ 佔位符，
// 產出可直接發布為 Artifact 的 dashboard.html，同時複製一份 index.html 供 GitHub Pages
// (serve from main branch root) 自動抓取，兩者內容永遠一致。
// 跨平台版本 (Node.js)，邏輯與 build.ps1 對等。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_PATH = join(ROOT, "data", "data.json");
const TEMPLATE_PATH = join(ROOT, "dashboard.template.html");
const OUT_PATH = join(ROOT, "dashboard.html");
const PAGES_OUT_PATH = join(ROOT, "index.html");

async function main() {
  const dataJson = await readFile(DATA_PATH, "utf8");
  const template = await readFile(TEMPLATE_PATH, "utf8");
  const final = template.replace("__DASHBOARD_DATA__", () => dataJson);
  await writeFile(OUT_PATH, final, "utf8");
  await writeFile(PAGES_OUT_PATH, final, "utf8");
  console.log(`已產出: ${OUT_PATH}`);
  console.log(`已產出: ${PAGES_OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
