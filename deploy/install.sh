#!/usr/bin/env bash
# One-time setup: installs the bot as a macOS launchd service (LaunchDaemon)
# so it starts on boot and restarts itself if it ever crashes.
#
# Usage: sudo ./deploy/install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo ./deploy/install.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_USER="${SUDO_USER:-$(stat -f%Su /dev/console)}"
LABEL="com.crashlyticsbot.slack"
PLIST_DEST="/Library/LaunchDaemons/${LABEL}.plist"

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  echo "Missing $INSTALL_DIR/.env — copy .env.example to .env and fill in tokens first." >&2
  exit 1
fi

# Resolve node the same way an interactive shell for RUN_USER would (so this
# picks up nvm/Homebrew installs, not just the sudo default PATH).
NODE_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v node' || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find 'node' on \$PATH for user $RUN_USER. Install Node 20+ first." >&2
  exit 1
fi

echo "Install dir : $INSTALL_DIR"
echo "Run as user : $RUN_USER"
echo "Node binary : $NODE_BIN"

echo "==> Installing dependencies and building"
sudo -u "$RUN_USER" bash -lc "cd '$INSTALL_DIR' && npm ci && npm run build"

mkdir -p "$INSTALL_DIR/logs"
chown "$RUN_USER" "$INSTALL_DIR/logs"

echo "==> Writing $PLIST_DEST"
sed \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__RUN_USER__|$RUN_USER|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  "$SCRIPT_DIR/com.crashlyticsbot.slack.plist.template" > "$PLIST_DEST"
chown root:wheel "$PLIST_DEST"
chmod 644 "$PLIST_DEST"

echo "==> Loading service"
launchctl bootout system "$PLIST_DEST" 2>/dev/null || true
launchctl bootstrap system "$PLIST_DEST"
launchctl enable "system/${LABEL}"
launchctl kickstart -k "system/${LABEL}"

echo "==> Done. Tailing logs (ctrl-C to stop watching, the service keeps running):"
sleep 1
tail -n 20 "$INSTALL_DIR/logs/bot.log" "$INSTALL_DIR/logs/bot.err.log" 2>/dev/null || true
echo
echo "Check status any time with: sudo launchctl print system/${LABEL}"
