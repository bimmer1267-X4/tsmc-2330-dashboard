#!/usr/bin/env bash
# 在本機（非 GitHub Actions）手動跑一次完整的每日資料更新，等同 update-dashboard.yml。
#
# 用途：GitHub Actions runner 的共用IP被上游(TWSE/Yahoo等)暫時封鎖/限流時，改用你自己
# 電腦的網路環境執行同一套流程，跑完直接 git commit + push 到 main，繞開 GitHub Actions
# 完全不經過它的runner。
#
# 使用方式：
#   cd /path/to/tsmc-2330-dashboard
#   bash scripts/local-run-full-update.sh
#
# 需求：Node.js >= 18（用到內建 fetch），已 clone 這個 repo 且能直接 push 到 main
# （個人PAT/SSH key已設定好）。不需要 npm install，這些腳本沒有外部套件依賴。
#
# 邏輯跟 .github/workflows/update-dashboard.yml 完全對等，包含同一套「手動觸發時間鎖定
# 窗」判斷（13:30~隔日05:50台北時間內執行，籌碼面/大盤指數與盤前預測/ADR類比估計會維持
# 上次的值，只回填收盤價相關資料，避免用「已經發生過的當天開盤」之後才抓到的即時報價
# 反過來污染早上06:00算出的正式預測結果）——本地執行時一律視為手動觸發，永遠套用這套
# 判斷，不會有「schedule事件」這種例外。

set -e
cd "$(dirname "$0")/.."

echo "[1/4] 抓取TWSE近6個月日K + 本益比/殖利率/股價淨值比 + 技術指標..."
node scripts/update-dashboard.mjs

HOURMIN=$((10#$(TZ=Asia/Taipei date +%H%M)))
if [ "$HOURMIN" -ge 1330 ] || [ "$HOURMIN" -lt 550 ]; then
  echo "[2/4] 目前台北時間 ${HOURMIN} 落在鎖定時間窗(13:30~隔日05:50)內，籌碼面/大盤指數維持上次的值，只更新夜盤資料..."
  node scripts/fetch-market-context.mjs --skip-market-context
  echo "[3/4] 同一鎖定時間窗內，只回填收盤價相關資料，不重算盤前預測/ADR類比估計..."
  node scripts/merge-and-classify.mjs --backfill-only
else
  echo "[2/4] 抓取融資融券/SOX+TAIEX/除權息/選擇權未平倉..."
  node scripts/fetch-market-context.mjs
  echo "[3/4] 合併ADR/匯率、計算估值分區、訓練開盤價預測模型..."
  node scripts/merge-and-classify.mjs
fi

echo "[4/4] 重新產生dashboard.html/index.html..."
node scripts/build.mjs

git add data/data.json data/adr-premium-history.json data/prediction-accuracy-history.json data/taifex-night-history.json dashboard.html index.html
if git diff --cached --quiet; then
  echo "資料沒有變更，跳過commit。"
else
  git commit -m "chore: automated daily data update (本地手動執行，繞開GitHub Actions)"
  git push
  echo "已commit並push。"
fi
