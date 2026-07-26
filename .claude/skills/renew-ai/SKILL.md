---
name: renew-ai
description: Manually trigger and verify a one-off run of the AI chip-analysis Routine for the TSMC (2330) dashboard (bimmer1267-X4/tsmc-2330-dashboard), which writes a narrative analysis to chip-analysis.html, instead of waiting for its scheduled Tue-Sat 07:00 Taipei firing. Use this whenever the user asks to manually update/refresh the AI籌碼面分析 or chip-analysis page right now, wants to force the AI analysis Routine to re-run, suspects it didn't fire or is showing stale/placeholder content, or asks "手動更新AI分析" / "renew-ai" / "現在就跑AI分析".
---

# 手動更新 AI籌碼面分析（chip-analysis.html）

`bimmer1267-X4/tsmc-2330-dashboard` 的 `chip-analysis.html`（AI籌碼面敘事分析頁面）是靠一個 Claude Code Remote Routine（`trig_01Qcu2V4sK2cPQFLgBrZzbfM`，名稱「TSMC 2330 AI籌碼面分析（週二至週六07:00）」）在台北時間週二至週六早上07:00自動觸發：每次觸發都會開一個全新、獨立的 session，讀取當下 `data/data.json` 的籌碼面/大盤指數欄位，寫一段敘事分析覆寫 `chip-analysis.html`，直接 commit + push 到 `main`。這個 skill 讓你能繞過排程，立刻手動觸發一次，並確認結果。

**這個機制跟 `renew-2330` skill（GitHub Actions 的 `update-dashboard.yml`）完全不同**，不要混用：
- `renew-2330` 觸發的是 GitHub Actions workflow，有 workflow run ID、可以查 job logs，通常 30 秒內完成。
- `renew-ai` 觸發的是**另一個獨立的 Claude Code session**，沒有 workflow run 那種可查詢的執行紀錄或 job logs，只能透過「repo 有沒有出現新 commit」來間接判斷有沒有跑完、跑成功。冷啟動（需要重新 clone repo）可能要幾分鐘，比 GitHub Actions 慢很多。

## 步驟

1. **觸發 Routine**：呼叫 `mcp__Claude_Code_Remote__fire_trigger`，`trigger_id: "trig_01Qcu2V4sK2cPQFLgBrZzbfM"`。如果這個 trigger_id 失效（例如被重建過），先用 `mcp__Claude_Code_Remote__list_triggers` 找名稱包含「AI籌碼面分析」的 Routine，取得目前正確的 `trigger_id`。

2. **等待完成、輪詢確認**：這個沒有 workflow run 可以查，只能靠 `git -C /home/user/tsmc-2330-dashboard fetch origin main -q && git -C /home/user/tsmc-2330-dashboard log origin/main -1` 看有沒有出現新的 `chore: 更新AI籌碼面分析 <日期>` commit。
   - 用 Bash `run_in_background` 搭配短暫 `sleep`（例如 60-90 秒一次）分段等待，每次醒來就 fetch 一次，不要用單次超長 sleep，也不要無限迴圈狂 poll。
   - 根據實測經驗，第一次冷啟動（環境裡還沒有 repo clone）可能要好幾分鐘；如果 5 分鐘內都還沒出現新 commit，先回報使用者目前狀況（已觸發、還沒看到結果、可能還在跑或卡住了），不要自己悶著頭無限等下去。
   - 我方沒有工具可以直接看到那個被觸發 session 內部在做什麼、有沒有報錯——如果等超過合理時間都沒有新 commit，除了重新觸發一次之外，只能請使用者自己到 claude.ai 的 Routines/Sessions 頁面查看那個 session 的執行紀錄（那邊看得到我看不到的細節）。

3. **判斷結果**：
   - 出現新的 `chore: 更新AI籌碼面分析` commit：讀取 `chip-analysis.html`，確認 `<span id="updated-at">` 有更新成合理的台北時間、內容不再是「尚未生成」的預留文字、有寫上「今日開盤前觀察」或「下週一開盤前展望」的標籤（依觸發當下是星期幾判斷是否合理），並簡單檢查分析內容是否有實際引用當天的籌碼面數據（不是空泛套話）。
   - 遲遲沒有新 commit：不要假設一定是失敗，也可能只是還在跑；按步驟2的方式繼續等待或請使用者協助查看。

4. **回報**：用繁體中文簡短總結——這次手動觸發的結果、`chip-analysis.html` 現在的更新時間、分析標籤是「今日觀察」還是「下週一展望」、以及頁面連結（`chip-analysis.html`，透過 GitHub Pages 存取）。

## 注意事項

- 這個操作對 repo 是安全的、可以重複執行——每次都只是覆寫 `chip-analysis.html` 一個檔案並直接 push，不會影響其他檔案或觸發額外的 GitHub Actions。
- 這個 skill 只處理 AI籌碼面分析頁面，跟 `renew-2330`（數字資料管線）、Artifact 重新發布、或 shunshun.dev（MyWeb repo）都無關，不需要一併處理。
