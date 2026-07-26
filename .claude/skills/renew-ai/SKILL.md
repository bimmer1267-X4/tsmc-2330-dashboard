---
name: renew-ai
description: Manually trigger and verify a one-off run of the AI chip-analysis Routine for the TSMC (2330) dashboard (bimmer1267-X4/tsmc-2330-dashboard), which writes a narrative analysis to chip-analysis.html, instead of waiting for its scheduled Tue-Sat 07:00 Taipei firing. Use this whenever the user asks to manually update/refresh the AI籌碼面分析 or chip-analysis page right now, wants to force the AI analysis Routine to re-run, suspects it didn't fire or is showing stale/placeholder content, or asks "手動更新AI分析" / "renew-ai" / "現在就跑AI分析".
---

# 手動更新 AI籌碼面分析（chip-analysis.html）

`bimmer1267-X4/tsmc-2330-dashboard` 的 `chip-analysis.html`（AI籌碼面敘事分析頁面）是靠一個 Claude Code Remote Routine（`trig_013QDSdoAx9ahHYWaZ47Qe5Z`，名稱「TSMC 2330 AI籌碼面分析（週二至週六07:00）」）在台北時間週二至週六早上07:00自動觸發，**綁定的是這個持續存在的工作 session（`session_01TLrC75jnXHSem36CKN59xE`）**，不是每次都開一個全新獨立的 session。觸發時會讀取當下 `data/data.json` 的籌碼面/大盤指數欄位，寫一段敘事分析覆寫 `chip-analysis.html`，直接 commit + push 到 `main`。這個 skill 讓你能繞過排程，立刻手動觸發一次，並確認結果。

**設計沿革（重要，避免重蹈覆轍）**：最初這個 Routine 是用 `create_new_session_on_fire: true`（每次開全新獨立 session）做的，實測兩次都完全沒有反應——等超過1小時都沒有任何 commit、branch 或錯誤痕跡。根本原因：全新 session 沒有掛載任何 MCP connector 工具（建立 trigger 時系統明確警告過這件事），所以沒有 `add_repo`／GitHub push 憑證可用，即使能唸公開 repo、寫好分析內容，最後一步 `git push` 也一定會卡死，而且沒有管道回報錯誤。後來改成綁定到「本來就有完整 git/GitHub 工具與憑證」的持續 session，問題才解決。**不要再改回 `create_new_session_on_fire` 模式。**

**這個機制跟 `renew-2330` skill（GitHub Actions 的 `update-dashboard.yml`）不同**，不要混用：
- `renew-2330` 觸發的是 GitHub Actions workflow，有 workflow run ID、可以查 job logs，通常 30 秒內完成。
- `renew-ai` 觸發的是一個持續存在的 Claude Code session，沒有 workflow run 那種可查詢的執行紀錄，但因為是已經設定好工具/憑證的正常 session，正常情況下應該在合理時間內（不到幾分鐘）就能完成並 push。

## 步驟

1. **判斷你現在是不是就在那個綁定的 session 裡**（`session_01TLrC75jnXHSem36CKN59xE`，也就是這整個 tsmc-2330-dashboard 專案在對話的這個 session）：
   - **如果是**：不用呼叫 `fire_trigger`，直接照下面「Routine 本體要做的事」的步驟做就好，效果完全一樣，而且你能親眼看到過程。
   - **如果是從別的 session 呼叫這個 skill**：呼叫 `mcp__Claude_Code_Remote__fire_trigger`，`trigger_id: "trig_013QDSdoAx9ahHYWaZ47Qe5Z"`。這會把任務送進**另一個 session**，你這邊看不到它執行過程，只能靠檢查 repo 有沒有新 commit 來間接確認（見步驟3）。如果這個 trigger_id 失效（例如被重建過），先用 `mcp__Claude_Code_Remote__list_triggers` 找名稱包含「AI籌碼面分析」的 Routine，取得目前正確的 `trigger_id`。

2. **Routine 本體要做的事**（自己執行、或等被 fire_trigger 觸發的那個 session 執行）：
   - `git -C /home/user/tsmc-2330-dashboard fetch origin main -q && git -C /home/user/tsmc-2330-dashboard checkout main -q && git -C /home/user/tsmc-2330-dashboard reset --hard origin/main -q`
   - 讀取 `data/data.json` 的 `chipTrend`、`institutionalNet`、`marginTrading`、`soxIndex`、`taiexIndex`、`optionsMarket`、`exDividend`（null的欄位略過，不要編造數字）
   - 判斷台北時間星期幾：週二~週五「今日開盤前觀察」；週六「下週一開盤前展望」
   - 寫一段300-500字繁體中文敘事分析（涵蓋外資/投信動向、融資融券槓桿氣氛、Put/Call Ratio情緒、SOX/TAIEX連動、風險提醒，不做明確買賣建議）
   - 更新 `chip-analysis.html` 的 `updated-at`、badge標籤、分析內容
   - `git add chip-analysis.html && git commit -m "chore: 更新AI籌碼面分析 <日期>" && git push origin main`（直接推main，不開PR）

3. **如果是從別的 session 觸發的，等待完成、輪詢確認**：靠 `git -C /home/user/tsmc-2330-dashboard fetch origin main -q && git -C /home/user/tsmc-2330-dashboard log origin/main -1` 看有沒有出現新的 `chore: 更新AI籌碼面分析 <日期>` commit。用 Bash `run_in_background` 搭配短暫 `sleep`（例如 30-60 秒一次）分段等待。這次改用有完整工具的 session 執行，正常應該幾分鐘內就會有結果；如果超過 5 分鐘還沒有，才需要回報使用者目前卡住的狀況。

4. **判斷結果**：出現新 commit 後，讀取 `chip-analysis.html`，確認 `<span id="updated-at">` 更新成合理的台北時間、內容不再是「尚未生成」的預留文字、badge標籤跟星期幾邏輯吻合，且分析內容有實際引用當天的籌碼面數據（不是空泛套話）。

5. **回報**：用繁體中文簡短總結——這次觸發的結果、`chip-analysis.html` 現在的更新時間、分析標籤是「今日觀察」還是「下週一展望」、頁面連結。

## 注意事項

- 這個操作對 repo 是安全的、可以重複執行——每次都只是覆寫 `chip-analysis.html` 一個檔案並直接 push，不會影響其他檔案或觸發額外的 GitHub Actions。
- 這個 skill 只處理 AI籌碼面分析頁面，跟 `renew-2330`（數字資料管線）、Artifact 重新發布、或 shunshun.dev（MyWeb repo）都無關，不需要一併處理。
