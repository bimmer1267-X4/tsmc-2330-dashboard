#!/bin/bash
# 發送 Telegram 通知：$TELEGRAM_BOT_TOKEN / $TELEGRAM_CHAT_ID 這兩個環境變數要在
# Claude Code Remote environment設定裡先準備好（Environment variables欄位），任一個
# 沒設定就安靜跳過——通知本身失敗不該連帶讓呼叫方的排程任務被判定失敗。
# 用法：scripts/notify-telegram.sh "<標題行>" "<內文，可留空>"
set -uo pipefail

TITLE="${1:-}"
BODY="${2:-}"

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID 未設定，略過Telegram通知" >&2
  exit 0
fi

TEXT="$TITLE"
if [ -n "$BODY" ]; then
  TEXT="$TITLE
$BODY"
fi

curl -s -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${TEXT}" \
  -o /dev/null -w "Telegram通知已送出 (HTTP %{http_code})\n" \
  || echo "Telegram通知呼叫失敗（網路或API錯誤），不影響本次任務結果" >&2

exit 0
