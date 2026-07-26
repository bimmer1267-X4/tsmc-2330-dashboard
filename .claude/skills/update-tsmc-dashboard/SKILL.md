---
name: update-tsmc-dashboard
description: Manually trigger and verify a one-off refresh of the TSMC (2330) dashboard's data pipeline (bimmer1267-X4/tsmc-2330-dashboard), instead of waiting for the scheduled GitHub Actions run. Use this whenever the user asks to manually update/refresh the TSMC or 2330 dashboard right now, wants to force the data pipeline to re-run, suspects the daily automated update didn't run or is showing stale data, or asks "手動更新" / "強制更新" / "現在就更新" the dashboard.
---

# 手動更新 TSMC (2330) 儀表板

`bimmer1267-X4/tsmc-2330-dashboard` 的資料本來是靠 `.github/workflows/update-dashboard.yml` 每個交易日自動抓取、計算、產出頁面並 commit。這個 skill 讓你能繞過排程，立刻強制跑一次同一套流程，並確認結果——用在使用者不想等排程、或懷疑今天自動更新沒跑成功的時候。

## 步驟

1. **觸發 workflow**：呼叫 `mcp__github__actions_run_trigger`，`method: "run_workflow"`、`owner: "bimmer1267-X4"`、`repo: "tsmc-2330-dashboard"`、`workflow_id: "update-dashboard.yml"`、`ref: "main"`。

2. **等待完成**：這個 workflow 過去的執行時間都在 30 秒內完成（抓 TWSE 資料 + 算指標 + merge + build + commit push），不需要頻繁輪詢。用 `mcp__github__actions_list`（`method: "list_workflow_runs"`，`resource_id: "update-dashboard.yml"`，`workflow_runs_filter: {event: "workflow_dispatch"}`）取得最新一筆 run 的 ID，然後每隔約 15-20 秒用 `mcp__github__actions_get`（`method: "get_workflow_run"`）檢查一次，直到 `status` 變成 `"completed"`。正常情況下 1-2 次檢查就夠了；如果超過 2 分鐘還沒完成，可能卡住了，直接回報異常狀況而不是無限等待。

3. **判斷結果**：
   - `conclusion` 是 `"success"`：這步就算成功了。接著執行 `git -C /home/user/tsmc-2330-dashboard fetch origin main -q && git -C /home/user/tsmc-2330-dashboard log origin/main -1` 看有沒有新的 `chore: automated daily data update` commit。**沒有新 commit 不代表失敗**——如果資料本來就已經是最新的（例如同一天內已經手動或自動跑過一次），workflow 會判斷「沒有變更」而跳過 commit，這是正常、預期的結果，不是錯誤。
   - `conclusion` 不是 `"success"`：向使用者說明失敗，並主動提議（不用等對方要求）用 `mcp__github__get_job_logs` 抓失敗那個 job 的 log 內容（`return_content: true`），從中找出實際錯誤原因（例如 TWSE API 逾時、Yahoo Finance 抓取失敗等），再回報。

4. **回報**：用繁體中文簡短總結——這次觸發是否成功、資料是否有更新（如果有，可以讀 `data/data.json` 的 `generatedAt`/`quoteTime` 告訴使用者現在資料是幾號的）、workflow run 的網址（方便使用者自己點進去看）。失敗的話說明原因和下一步建議。

## 注意事項

- 這個操作對 repo 是安全的、可以隨時重複執行——它做的事跟排程本來會做的事完全一樣，只是提前手動觸發，不會產生預期外的副作用。
- 這個 skill 只處理 tsmc-2330-dashboard 的資料更新，跟 Artifact 重新發布、或 shunshun.dev（MyWeb repo）都無關，不需要一併處理那些。
