#!/usr/bin/env bash
# Restarts the service without pulling or rebuilding. Use after editing .env
# or config/owners-map.json, which are only read at startup.
#
# Usage: sudo ./deploy/restart.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo ./deploy/restart.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.crashlyticsbot.slack"

echo "==> Restarting service"
launchctl kickstart -k "system/${LABEL}"

sleep 2
echo "==> Recent log output:"
tail -n 10 "$INSTALL_DIR/logs/bot.log" "$INSTALL_DIR/logs/bot.err.log" 2>/dev/null || true
