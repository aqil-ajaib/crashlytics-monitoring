#!/usr/bin/env bash
# Redeploy: pulls the latest code, rebuilds, and restarts the launchd service.
# Run this on the Mac mini from inside the deployed git checkout.
#
# Usage: sudo ./deploy/update.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo ./deploy/update.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LABEL="com.crashlyticsbot.slack"
RUN_USER="$(stat -f%Su "$INSTALL_DIR")"

echo "==> Pulling latest code"
sudo -u "$RUN_USER" bash -lc "cd '$INSTALL_DIR' && git pull --ff-only"

echo "==> Installing dependencies and building"
sudo -u "$RUN_USER" bash -lc "cd '$INSTALL_DIR' && npm ci && npm run build"

echo "==> Restarting service"
launchctl kickstart -k "system/${LABEL}"

echo "==> Done."
