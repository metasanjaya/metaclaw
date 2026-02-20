#!/bin/bash
# restart-instance.sh — Restart MetaClaw instance with auto-confirmation
# Usage: ./restart-instance.sh [instance-name] [chat-id]
# Example: ./restart-instance.sh metaclaw-main 5020823483

INSTANCE="${1:-metaclaw-main}"
CHAT_ID="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
CONFIRM_FILE="$BASE_DIR/data/restart-pending.json"

# Write restart-pending marker with timestamp
cat > "$CONFIRM_FILE" << EOF
{
  "instance": "$INSTANCE",
  "chatId": "$CHAT_ID",
  "requestedAt": $(date +%s%3N),
  "requestedAtHuman": "$(TZ=Asia/Jakarta date '+%Y-%m-%d %H:%M:%S WIB')"
}
EOF

echo "📋 Restart marker written to $CONFIRM_FILE"
echo "🔄 Restarting $INSTANCE..."

# Restart via PM2
pm2 restart "$INSTANCE" --update-env 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ PM2 restart command failed (exit $EXIT_CODE)"
  rm -f "$CONFIRM_FILE"
  exit $EXIT_CODE
fi

echo "✅ PM2 restart command sent. Instance will auto-confirm in ~1 minute if successful."
