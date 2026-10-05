#!/usr/bin/env bash
# Stops the bot and removes the launchd service so it no longer starts on boot.
# Leaves the code, .env, config and logs on disk untouched.
#
# Usage: sudo ./deploy/uninstall.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo ./deploy/uninstall.sh" >&2
  exit 1
fi

LABEL="com.crashlyticsbot.slack"
PLIST_DEST="/Library/LaunchDaemons/${LABEL}.plist"

echo "==> Stopping service"
launchctl bootout "system/${LABEL}" 2>/dev/null || echo "Service was not loaded, skipping."

echo "==> Removing $PLIST_DEST"
rm -f "$PLIST_DEST"

echo "==> Done. The bot will no longer start on boot. Re-enable any time with: sudo ./deploy/install.sh"
