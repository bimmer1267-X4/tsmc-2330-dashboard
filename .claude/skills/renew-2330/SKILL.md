---
name: renew-2330
description: Manually trigger and verify a one-off refresh of the TSMC (2330) dashboard's data pipeline (bimmer1267-X4/tsmc-2330-dashboard), instead of waiting for the scheduled GitHub Actions run. Use this whenever the user asks to manually update/refresh the TSMC or 2330 dashboard right now, wants to force the data pipeline to re-run, suspects the daily automated update didn't run or is showing stale data, or asks "手動更新" / "強制更新" / "現在就更新" the dashboard.
---

# 手動更新 TSMC (2330) 儀表板

`bimmer1267-X4/tsmc-2330-dashboard` 的資料靠兩個 GitHub Actions workflow 自動更新：`.github/workflows/update-dashboard.yml`（每個交易日06:00，負責日K/技術指標/ADR/匯率/預測模型/籌碼面等大部分欄位）和 `.github/workflows/post-close-update.yml`（每個交易日13:35台股收盤後，負責 `liveQuote` 即時報價欄位、以及準確度追蹤卡片的當日回填）。這個 skill 讓你能繞過排程，立刻強制把兩個 workflow 都跑一次，並確認結果——用在使用者不想等排程、或懷疑今天自動更新沒跑成功/收盤價卡片沒更新的時候。

## 步驟

1. **觸發兩個 workflow**：依序呼叫兩次 `mcp__github__actions_run_trigger`（`method: "run_workflow"`、`owner: "bimmer1267-X4"`、`repo: "tsmc-2330-dashboard"`、`ref: "main"`），`workflow_id` 分別是 `"update-dashboard.yml"` 和 `"post-close-update.yml"`。兩個都要觸發，不要只觸發其中一個——`update-dashboard.yml` 不會更新 `liveQuote`，只觸發它沒辦法修好「收盤價」卡片沒更新的問題。不用擔心兩者互相衝突：兩個 workflow 都設定了同一個 `concurrency: group: update-dashboard`，GitHub 會自動排隊序列化執行，不會有搶著 push main 的問題。`post-close-update.yml` 背後跑的 `scripts/fetch-live-quote.mjs` 在任何時間點觸發都是安全的（非交易時段會自動退回昨收價當備援，抓不到就安靜跳過，不會讓 workflow 失敗），不需要先判斷現在是不是交易時段才觸發。

2. **等待完成**：這兩個 workflow 過去的執行時間都在 30 秒內完成，不需要頻繁輪詢。對每一個都用 `mcp__github__actions_list`（`method: "list_workflow_runs"`，`resource_id` 對應各自的檔名，`workflow_runs_filter: {event: "workflow_dispatch"}`）取得最新一筆 run 的 ID，然後每隔約 15-20 秒用 `mcp__github__actions_get`（`method: "get_workflow_run"`）檢查一次，直到 `status` 變成 `"completed"`。正常情況下 1-2 次檢查就夠了；如果超過 2 分鐘還沒完成，可能卡住了，直接回報異常狀況而不是無限等待。

3. **判斷結果**（兩個 workflow 分別判斷，其中一個成功不能替另一個蓋過失敗）：
   - `conclusion` 是 `"success"`：這步就算成功了。接著執行 `git -C /home/user/tsmc-2330-dashboard fetch origin main -q && git -C /home/user/tsmc-2330-dashboard log origin/main -1` 看有沒有新的 commit（`update-dashboard.yml` 的訊息是 `chore: automated daily data update`，`post-close-update.yml` 的是 `chore: post-close update (live quote + accuracy backfill)`）。**沒有新 commit 不代表失敗**——如果資料本來就已經是最新的（例如同一天內已經手動或自動跑過一次），workflow 會判斷「沒有變更」而跳過 commit，這是正常、預期的結果，不是錯誤。
   - `conclusion` 不是 `"success"`：向使用者說明是哪一個 workflow 失敗，並主動提議（不用等對方要求）用 `mcp__github__get_job_logs` 抓失敗那個 job 的 log 內容（`return_content: true`），從中找出實際錯誤原因（例如 TWSE API 逾時、Yahoo Finance 抓取失敗等），再回報。另一個 workflow 若成功，還是照樣完成、照樣回報，不要因為一個失敗就連帶跳過另一個的結果確認。

4. **回報**：用繁體中文簡短總結——兩個 workflow 這次觸發是否都成功、資料是否有更新。可以讀 `data/data.json` 的 `generatedAt`（來自 `update-dashboard.yml`）告訴使用者日K/預測等大部分資料是幾號的，以及 `liveQuote.date`/`liveQuote.time`/`liveQuote.price`（來自 `post-close-update.yml`）告訴使用者「收盤價」卡片現在顯示的是哪個時間點的報價。附上兩個 workflow run 的網址（方便使用者自己點進去看）。任一個失敗的話說明原因和下一步建議。

## 注意事項

- 這個操作對 repo 是安全的、可以隨時重複執行——它做的事跟排程本來會做的事完全一樣，只是提前手動觸發，不會產生預期外的副作用。
- 這個 skill 現在同時管理兩個 workflow，兩者職責不重疊：`update-dashboard.yml` 負責日K/ADR/匯率/預測模型/籌碼面等大部分欄位；`post-close-update.yml` 負責 `liveQuote` 即時報價與準確度追蹤卡片的當日回填。只跑其中一個沒辦法讓整個儀表板都是最新狀態。
- 這個 skill 只處理 tsmc-2330-dashboard 的資料更新，跟 Artifact 重新發布、或 shunshun.dev（MyWeb repo）都無關，不需要一併處理那些。
