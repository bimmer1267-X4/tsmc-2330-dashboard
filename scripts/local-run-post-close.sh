#!/usr/bin/env bash
# 在本機（非 GitHub Actions）手動跑一次收盤後更新，等同 post-close-update.yml：
# 更新即時報價(liveQuote)卡片、回填盤前預測準確度追蹤。
#
# 用途：GitHub Actions runner 的共用IP被上游(TWSE)暫時封鎖/限流、或想立刻確認收盤價卡片
# 沒問題時，改用你自己電腦的網路環境執行，跑完直接 git commit + push 到 main，完全繞開
# GitHub Actions。
#
# 使用方式：
#   cd /path/to/tsmc-2330-dashboard
#   bash scripts/local-run-post-close.sh
#
# 需求：Node.js >= 18（用到內建 fetch），已 clone 這個 repo 且能直接 push 到 main
# （個人PAT/SSH key已設定好）。不需要 npm install，這些腳本沒有外部套件依賴。
#
# 邏輯跟 .github/workflows/post-close-update.yml 對等，包含同一套push撞車重試機制
# （最多3次，撞車時reset到最新main重新產生資料再試）。

set -e
cd "$(dirname "$0")/.."

MAX_ATTEMPTS=3
for ATTEMPT in $(seq 1 $MAX_ATTEMPTS); do
  echo "[嘗試 ${ATTEMPT}/${MAX_ATTEMPTS}] 抓取即時報價..."
  node scripts/fetch-live-quote.mjs
  echo "[嘗試 ${ATTEMPT}/${MAX_ATTEMPTS}] 回填準確度追蹤..."
  node scripts/merge-and-classify.mjs --backfill-only
  echo "[嘗試 ${ATTEMPT}/${MAX_ATTEMPTS}] 重新產生dashboard.html/index.html..."
  node scripts/build.mjs

  git add data/data.json data/prediction-accuracy-history.json dashboard.html index.html
  if git diff --cached --quiet; then
    echo "資料沒有變更，跳過commit。"
    break
  fi
  git commit -m "chore: post-close update (live quote + accuracy backfill) (本地手動執行，繞開GitHub Actions)"
  if git push; then
    echo "Push成功(第${ATTEMPT}次嘗試)"
    break
  fi
  if [ "$ATTEMPT" -eq "$MAX_ATTEMPTS" ]; then
    echo "Push連續失敗${MAX_ATTEMPTS}次，放棄(可能是持續性衝突，非單純撞車)"
    exit 1
  fi
  echo "Push被拒絕(可能跟其他來源撞車)，重新同步main後重試..."
  git fetch origin main
  git reset --hard origin/main
  sleep $((RANDOM % 5 + 3))
done
