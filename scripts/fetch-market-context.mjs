// 抓取「股市經理人視角」的補充參考資訊，合併進 data/data.json：
//   - marginTrading：台積電(2330)融資融券餘額 (TWSE OpenAPI MI_MARGN)
//   - soxIndex / taiexIndex：費城半導體指數(SOX)、加權指數(TAIEX) (Yahoo Finance)
//   - institutionalNet：三大法人（外資/投信/合計）買賣超 (TWSE 舊版 rwd/zh/fund/T86)
//   - exDividend：近期除權息預告 (TWSE OpenAPI TWT48U_ALL)
//   - optionsMarket：台指選擇權(TXO)未平倉 Put/Call Ratio (TAIFEX OpenAPI)
//   - chipTrend：規則式（非AI）籌碼面趨勢判讀（偏多/中性/偏空 + 理由），根據以上欄位加權計分
// 每一段資料來源獨立 try/catch，單一來源失敗不影響其他欄位（沿用 merge-and-classify.mjs
// 一貫的容錯風格），失敗時該欄位維持 null，前端會顯示「暫無資料」而不是整頁壞掉。
// 跨平台版本 (Node.js >= 18)，邏輯與 fetch-market-context.ps1 對等。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "data", "data.json");
const TX_NIGHT_HISTORY_PATH = join(__dirname, "..", "data", "taifex-night-history.json");
const STOCK_NO = "2330";
const UA = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)";

function toNum(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (t === "" || t === "--" || t === "X" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

// "1150805" (ROC，無分隔) -> "2026-08-05"
function rocCompactToIso(s) {
  if (!s || s.length !== 7) return null;
  const year = Number(s.slice(0, 3)) + 1911;
  return `${year}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// 融資融券餘額（TWSE OpenAPI 每日全市場快照，篩選單一個股）
async function fetchMarginTrading() {
  const rows = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN");
  const row = Array.isArray(rows) ? rows.find((r) => r["股票代號"] === STOCK_NO) : null;
  if (!row) throw new Error(`MI_MARGN 找不到股票代號 ${STOCK_NO}`);
  return {
    marginBuy: toNum(row["融資買進"]),
    marginSell: toNum(row["融資賣出"]),
    marginBalance: toNum(row["融資今日餘額"]),
    marginBalancePrev: toNum(row["融資前日餘額"]),
    shortBuy: toNum(row["融券買進"]),
    shortSell: toNum(row["融券賣出"]),
    shortBalance: toNum(row["融券今日餘額"]),
    shortBalancePrev: toNum(row["融券前日餘額"]),
  };
}

// Yahoo Finance 指數報價（與 merge-and-classify.mjs 的 fetchYahooDaily 邏輯一致：
// 用每日收盤序列的倒數第二筆算前收，避免 chartPreviousClose 可能跨多天導致漲跌%算錯）
async function fetchYahooIndex(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const json = await fetchJson(url);
  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`Yahoo Finance 無資料: ${symbol}`);
  const { meta, timestamp = [] } = result;
  const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
  const price = meta.regularMarketPrice;
  // 不能單純假設「倒數第二個有效收盤價」就是前一交易日：如果當天(跟regularMarketTime
  // 同一天)那筆是null會被filter掉，導致陣列整體往前偏移一格，「倒數第二」實際上會變成
  // 大前天的收盤價，算出的漲跌%會是好幾天的累積變化，不是真正的單日變化（歷史上TAIEX
  // 就出現過這個問題，SOX因為當天那筆剛好不是null才沒事，兩者用同一份邏輯卻表現不一致）。
  // 改成明確比對日期：從最新往回找，跳過跟regularMarketTime同一天的項目，取第一個「不同
  // 一天」的有效收盤價，不依賴陣列位置，才能保證永遠是真正的前一交易日。
  const latestDateKey = meta.regularMarketTime != null ? new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
  let previousClose = null;
  for (let i = timestamp.length - 1; i >= 0; i--) {
    const c = rawCloses[i];
    if (c == null) continue;
    const dateKey = new Date(timestamp[i] * 1000).toISOString().slice(0, 10);
    if (latestDateKey && dateKey === latestDateKey) continue;
    previousClose = c;
    break;
  }
  if (previousClose == null) previousClose = meta.previousClose ?? meta.chartPreviousClose;
  const changePct = previousClose ? Math.round((price / previousClose - 1) * 10000) / 100 : null;
  const quoteTime = new Date(meta.regularMarketTime * 1000).toISOString();
  return { price, changePct, quoteTime };
}

// 三大法人買賣超（個股）。OpenAPI /v1/fund/T86 回傳的是 HTML 錯誤頁（路徑錯誤），
// 改用與 STOCK_DAY / BWIBBU_d 相同風格的舊版 rwd 端點，且比照 fetchValuation 的作法，
// 從最新交易日往前回溯最多 5 個交易日（避免當天報表尚未發布時整項掛空）。
async function fetchInstitutionalNet(daily) {
  for (let back = 0; back < 5; back++) {
    const idx = daily.length - 1 - back;
    if (idx < 0) break;
    const tryDate = daily[idx].date.replace(/-/g, "");
    const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${tryDate}&selectType=ALL&response=json`;
    const resp = await fetchJson(url);
    if (resp.stat === "OK" && Array.isArray(resp.data)) {
      const row = resp.data.find((r) => r[0] === STOCK_NO);
      if (row) {
        const foreignNet = (toNum(row[4]) ?? 0) + (toNum(row[7]) ?? 0);
        const trustNet = toNum(row[10]);
        const totalNet = toNum(row[18]);
        return {
          date: daily[idx].date,
          foreignNetLots: Math.round(foreignNet / 1000),
          trustNetLots: trustNet != null ? Math.round(trustNet / 1000) : null,
          totalNetLots: totalNet != null ? Math.round(totalNet / 1000) : null,
        };
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("T86 回溯5個交易日仍查無2330資料");
}

// 除權息預告（篩選單一個股，取最近一筆；通常一次只有 0-1 筆，多筆的話取最早的日期）
async function fetchExDividend() {
  const rows = await fetchJson("https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL");
  const matches = Array.isArray(rows) ? rows.filter((r) => r["Code"] === STOCK_NO) : [];
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(a["Date"]).localeCompare(String(b["Date"])));
  const row = matches[0];
  return {
    date: rocCompactToIso(row["Date"]),
    type: row["Exdividend"] || null, // "息"=除息, "權"=除權, "權息"=兩者皆有
    cashDividend: toNum(row["CashDividend"]),
    stockDividendRatio: toNum(row["StockDividendRatio"]),
  };
}

// 台指選擇權(TXO)全月份加總未平倉 Put/Call Ratio。只取「一般」交易時段，避免跟盤後
// 時段的未平倉重複計算（OpenInterest 是狀態值，不是成交量，兩個時段各自列一次）。
async function fetchOptionsMarket() {
  const rows = await fetchJson("https://openapi.taifex.com.tw/v1/DailyMarketReportOpt");
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("DailyMarketReportOpt 回傳空資料");
  const txo = rows.filter((r) => r["Contract"] === "TXO" && r["TradingSession"] === "一般");
  if (txo.length === 0) throw new Error("找不到 TXO 一般時段資料");
  let callOI = 0, putOI = 0, date = null;
  for (const r of txo) {
    const oi = toNum(r["OpenInterest"]) ?? 0;
    if (r["CallPut"] === "買權") callOI += oi;
    else if (r["CallPut"] === "賣權") putOI += oi;
    date = date || r["Date"];
  }
  return {
    date: date && date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
    callOI,
    putOI,
    putCallRatio: callOI > 0 ? Math.round((putOI / callOI) * 10000) / 10000 : null,
  };
}

// 台指期(TX)近月合約盤後交易時段(夜盤)最新成交/收盤價。
//
// 原本用openapi.taifex.com.tw/v1/DailyMarketReportFut，2026-08-05實測發現這個「即時」
// API其實是「每日批次更新一次」，不是真即時：同一天19:40(距離當晚夜盤05:00收盤還有
// 9小時多、夜盤才剛開盤4.5小時)重複查詢，回傳的還是前一場已經收盤超過13小時的舊資料，
// 一個位元都沒變過。這就是「抓到的是前一日夜盤收盤價」問題的根本原因——不是抓取邏輯的
// bug，是這個特定API端點本身沒有在夜盤交易時段內更新。
//
// 改用TAIFEX官方網站自己在用的「期貨每日交易行情下載」表單背後的端點
// (https://www.taifex.com.tw/cht/3/futDataDown，POST表單，回傳Big5編碼CSV)。同一個
// 19:40時間點實測：這個端點查得到的TX近月合約盤後列，"交易日期"已經是當天、"收盤價"
// (實際上是最後成交價，結算價欄位還是"-"表示尚未結算)持續反映當晚夜盤最新成交，證實
// 是真正跟得上進度的資料源。表頭欄位、資料格式都已用實際回傳驗證過(2026-08-05
// GitHub Actions run)：
//   交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,
//   結算價,未沖銷契約數,最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,
//   是否因訊息面暫停交易,交易時段,價差對單式委託成交量
// "交易時段"欄位是"一般"(日盤)或"盤後"(夜盤)，同一天同一合約各一列。
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

// 從futDataDown回傳的多天多合約資料裡，挑出「範圍內最新交易日」的TX近月合約盤後列。
// 用日期字串直接比較(yyyy/mm/dd格式，字典序等同時間序)；近月合約用到期月份字串排序取
// 最小的一筆，跳過含"/"的價差合約列(例如"202608/202609"這種跨月價差)。
function pickLatestNightRow(rows) {
  const night = rows.filter((r) => r.contract === "TX" && r.session === "盤後" && !r.contractMonth.includes("/"));
  if (night.length === 0) return null;
  const maxDate = night.reduce((m, r) => (r.date > m ? r.date : m), night[0].date);
  const candidates = night.filter((r) => r.date === maxDate);
  candidates.sort((a, b) => a.contractMonth.localeCompare(b.contractMonth));
  return candidates[0];
}

// 把UTC時間轉成台北時間(UTC+8)的"yyyy/mm/dd"字串，供futDataDown的查詢日期參數使用。
function taipeiDateStr(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}/${String(t.getUTCMonth() + 1).padStart(2, "0")}/${String(t.getUTCDate()).padStart(2, "0")}`;
}

// openapi.taifex.com.tw僅提供「最新一個交易日」、futDataDown則是依日期範圍查詢，沒辦法
// 直接跟API要前一天的收盤價來算漲跌%。改成把上一次寫進data.json的taifexNightClose當作
// 前一天的基準，跟這次新抓到的比較；date有變才代表換到新一場夜盤，重新計算漲跌%。
//
// date沒變(還是同一場夜盤，例如同一天內這個workflow被手動重複觸發、或/renew-2330這種
// 補跑)的情況，不能拿「這場」跟「自己」比出漲跌%——但也不能就此把changePct/changePts
// 重置成null：這個函式理論上只在每天06:00跑一次，但實務上會被手動repeat(renew-2330
// skill本來就設計成「可以隨時重複觸發、安全無副作用」)，如果date沒變就重置成null，
// 會把稍早已經正確算出來的漲跌%洗掉，等於每次手動補跑都會讓「收盤價旁邊的漲跌點數」
// 消失，卡片看起來像壞掉一樣。所以date沒變時要保留previous裡原本算好的值，這裡的行為
// 才會跟fetch-live-quote.mjs的refreshTaifexNightClose(校正同一場夜盤時保留changePct
// 不變)一致。
async function fetchTaifexNightClose(previous) {
  // 查近5個日曆天(涵蓋連假造成的交易日空隙)到今天，確保一定抓得到「範圍內最新一筆」。
  const now = new Date();
  const endStr = taipeiDateStr(now);
  const startStr = taipeiDateStr(new Date(now.getTime() - 5 * 24 * 3600 * 1000));
  const rows = await fetchTaifexFutDataDownCsv(startStr, endStr);
  const row = pickLatestNightRow(rows);
  if (!row) throw new Error(`futDataDown找不到TX盤後(夜盤)資料，查詢範圍=${startStr}~${endStr}`);
  const close = row.settlement ?? row.close;
  if (close == null) throw new Error(`TX盤後資料找到但無法解析收盤價欄位，原始資料=${JSON.stringify(row)}`);
  const date = row.date.replace(/\//g, "-");
  let changePct = null, changePts = null;
  if (previous && previous.close != null && previous.date && date) {
    if (previous.date !== date) {
      changePct = Math.round((close / previous.close - 1) * 10000) / 100;
      changePts = Math.round((close - previous.close) * 100) / 100;
    } else {
      changePct = previous.changePct ?? null;
      changePts = previous.changePts ?? null;
    }
  }
  return {
    contractMonth: row.contractMonth || null,
    close,
    changePct,
    changePts,
    open: row.open,
    high: row.high,
    low: row.low,
    volume: row.volume,
    date,
  };
}

// 規則式（非AI）籌碼面趨勢判讀：把幾個方向性訊號依權重加總算分，避免單一指標誤判。
// 在資料抓取當下（而非瀏覽器端）就完成分類，做法比照 merge-and-classify.mjs 對
// Trailing/Forward PE 的估值分區判讀——分析結果是資料管線的一部分、可重現，不是
// 每次開頁面才臨時算的展示邏輯。
// 融資融券變化不計入方向分數（增減本身無明確多空意義，需搭配股價位置判斷），
// 只作為風險提示文字附加在摘要下方。
function classifyChipTrend(raw) {
  let score = 0, weightSum = 0;
  const reasons = [];
  const risk = [];

  if (raw.institutionalNet) {
    const inet = raw.institutionalNet;
    if (inet.foreignNetLots != null) {
      score += Math.sign(inet.foreignNetLots) * 1.5; weightSum += 1.5;
      reasons.push(`外資${inet.foreignNetLots >= 0 ? "買超" : "賣超"}${Math.abs(inet.foreignNetLots).toLocaleString("zh-TW")}張`);
    }
    if (inet.trustNetLots != null) {
      score += Math.sign(inet.trustNetLots) * 0.8; weightSum += 0.8;
      reasons.push(`投信${inet.trustNetLots >= 0 ? "買超" : "賣超"}${Math.abs(inet.trustNetLots).toLocaleString("zh-TW")}張`);
    }
  }
  if (raw.optionsMarket && raw.optionsMarket.putCallRatio != null) {
    const ratio = raw.optionsMarket.putCallRatio;
    const s = ratio > 1.05 ? -1 : ratio < 0.95 ? 1 : 0;
    score += s; weightSum += 1;
    reasons.push(`選擇權Put/Call Ratio ${ratio.toFixed(2)}${s > 0 ? "（看多氣氛較濃）" : s < 0 ? "（避險氣氛較濃）" : "（中性）"}`);
  }
  if (raw.soxIndex && raw.soxIndex.changePct != null) {
    score += Math.sign(raw.soxIndex.changePct) * 0.6; weightSum += 0.6;
    reasons.push(`SOX費半指數${raw.soxIndex.changePct >= 0 ? "上漲" : "下跌"}${Math.abs(raw.soxIndex.changePct).toFixed(2)}%`);
  }
  if (raw.taiexIndex && raw.taiexIndex.changePct != null) {
    score += Math.sign(raw.taiexIndex.changePct) * 0.4; weightSum += 0.4;
    reasons.push(`加權指數${raw.taiexIndex.changePct >= 0 ? "上漲" : "下跌"}${Math.abs(raw.taiexIndex.changePct).toFixed(2)}%`);
  }
  if (raw.marginTrading) {
    const mt = raw.marginTrading;
    if (mt.marginBalance != null && mt.marginBalancePrev != null) {
      const chg = mt.marginBalance - mt.marginBalancePrev;
      if (chg > 0) risk.push(`融資餘額增加${chg.toLocaleString("zh-TW")}張（槓桿部位上升，留意回檔時的斷頭賣壓）`);
      else if (chg < 0) risk.push(`融資餘額減少${Math.abs(chg).toLocaleString("zh-TW")}張（籌碼去化中）`);
    }
    if (mt.shortBalance != null && mt.shortBalancePrev != null) {
      const chg = mt.shortBalance - mt.shortBalancePrev;
      if (chg > 0) risk.push(`融券餘額增加${chg.toLocaleString("zh-TW")}張（空方力道增溫，亦可能成為軋空燃料）`);
    }
  }

  if (weightSum === 0) return null;
  const avg = score / weightSum;
  const verdict = avg >= 0.34 ? "偏多" : avg <= -0.34 ? "偏空" : "中性";
  const cls = avg >= 0.34 ? "up" : avg <= -0.34 ? "down" : "";
  return { verdict, cls, reasons, risk };
}

// 台指期(TX)夜盤歷史序列：永久保留、逐日累積（跟merge-and-classify.mjs的
// updateAdrPremiumHistory同一套read-try/catch→Map upsert-by-date→sort→write模式），
// 供「開盤價機率預估」四變數模型(buildOpenGapModelV4)訓練用。這裡只在「換日」那一刻
// (previous.date !== raw.taifexNightClose.date)才把previous這筆append進去——因為
// previous換日後就確定不會再被fetchTaifexNightClose的校正邏輯改動了(校正只發生在
// 「同一個date」的情況)，此時才是它真正定案、可以永久寫入的時間點；raw.taifexNightClose
// 目前這筆(還在今天)則留給明天換日時才寫入，不提前寫，避免把還可能被SettlementPrice
// 校正的暫定值寫死進歷史。
async function appendTaifexNightHistory(previous, current) {
  if (!previous || previous.close == null || previous.date == null) return;
  if (!current || current.date == null || current.date === previous.date) return;
  let history = [];
  try {
    history = JSON.parse(await readFile(TX_NIGHT_HISTORY_PATH, "utf8"));
  } catch {
    // 檔案不存在或格式壞掉，視為空歷史，從頭建立
  }
  const byDate = new Map(history.map((h) => [h.date, h]));
  // open/high/low/volume是後來才加的欄位，種子歷史(使用者提供的CSV回填那384筆)沒有這幾
  // 個值，統一用??null讓欄位形狀固定，前端渲染K線圖時再自行判斷要不要退化處理，不在這裡
  // 硬塞假資料。
  byDate.set(previous.date, {
    date: previous.date,
    close: previous.close,
    changePct: previous.changePct ?? null,
    changePts: previous.changePts ?? null,
    open: previous.open ?? null,
    high: previous.high ?? null,
    low: previous.low ?? null,
    volume: previous.volume ?? null,
  });
  const merged = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  await writeFile(TX_NIGHT_HISTORY_PATH, JSON.stringify(merged), "utf8");
  console.log(`已更新台指期夜盤歷史紀錄: ${TX_NIGHT_HISTORY_PATH}（累計 ${merged.length} 筆，新增/更新 ${previous.date}）`);
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.warn(`[market-context] ${label} 失敗，該欄位維持 null: ${e.message}`);
    return null;
  }
}

// --skip-market-context：跟merge-and-classify.mjs的--backfill-only同一套鎖定時間窗
// 邏輯(見update-dashboard.yml)，手動觸發且落在鎖定時間窗內時使用。籌碼面/大盤指數這幾
// 個欄位其實都是TWSE/TAIFEX單日公告一次的EOD資料、或即時跳動的市場指數，本身不像
// 「盤前股價預測」有「用今天自己的收盤價預測今天」那種邏輯矛盾，重複抓取不會有正確性
// 問題——這裡鎖定純粹是為了讓使用者在鎖定時間窗內看到的三張卡片(盤前預測/ADR類比估計/
// 籌碼面與大盤指數)行為一致，不是為了修正資料本身的錯誤。
// 台指期夜盤(taifexNightClose)不受這個旗標影響，鎖定期間依然照常更新——那張卡片本來就
// 已經調整成「盡可能即時」，不在這次鎖定範圍內。
async function main() {
  const raw = JSON.parse(await readFile(DATA_PATH, "utf8"));
  const skipMarketContext = process.argv.slice(2).includes("--skip-market-context");

  if (!skipMarketContext) {
    raw.marginTrading = await safe("融資融券餘額", fetchMarginTrading);
    raw.soxIndex = await safe("SOX指數", () => fetchYahooIndex("^SOX"));
    raw.taiexIndex = await safe("TAIEX指數", () => fetchYahooIndex("^TWII"));
  } else {
    console.log("手動觸發且落在鎖定時間窗內，籌碼面/大盤指數維持上一次的值，只更新夜盤資料");
  }

  const previousTaifexNightClose = raw.taifexNightClose;
  raw.taifexNightClose = await safe("台指期夜盤收盤", () => fetchTaifexNightClose(previousTaifexNightClose));
  await safe("台指期夜盤歷史紀錄累積", () => appendTaifexNightHistory(previousTaifexNightClose, raw.taifexNightClose));

  if (!skipMarketContext) {
    raw.institutionalNet = await safe("三大法人買賣超", () => fetchInstitutionalNet(raw.daily));
    raw.exDividend = await safe("除權息預告", fetchExDividend);
    raw.optionsMarket = await safe("選擇權未平倉", fetchOptionsMarket);
    raw.chipTrend = await safe("籌碼面趨勢判讀", () => classifyChipTrend(raw));
  }

  await writeFile(DATA_PATH, JSON.stringify(raw), "utf8");
  console.log(skipMarketContext
    ? "已更新 taifexNightClose（籌碼面/大盤指數本次略過）"
    : "已更新 marginTrading / soxIndex / taiexIndex / taifexNightClose / institutionalNet / exDividend / optionsMarket / chipTrend");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
