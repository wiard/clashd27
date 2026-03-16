#!/bin/bash
set -euo pipefail

CLASHD27_PATH="/Users/wiardvasen/clashd27"
PLIST="$HOME/Library/LaunchAgents/com.clashd27.nightly-reader.plist"
NODE_BIN="${NODE_BIN:-/usr/local/bin/node}"
LIBRARY_ROOT="${CLASHD27_LIBRARY_ROOT:-$CLASHD27_PATH/data}"
BACKUP_DIR="${CLASHD27_LIBRARY_BACKUP_DIR:-$CLASHD27_PATH/backups}"
GATEWAY_URL="${OPENCLASHD_GATEWAY_URL:-}"
OPENCLASHD_TOKEN_VALUE="${OPENCLASHD_TOKEN:-}"

if [[ -z "$GATEWAY_URL" ]]; then
  echo "Set OPENCLASHD_GATEWAY_URL to the VPS OpenClashd base URL before running this script."
  exit 1
fi

if [[ -z "$OPENCLASHD_TOKEN_VALUE" ]]; then
  echo "Set OPENCLASHD_TOKEN to a long-lived conductor token before running this script."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LIBRARY_ROOT/logs"
mkdir -p "$BACKUP_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.clashd27.nightly-reader</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${CLASHD27_PATH}/bin/nightly-reader.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${CLASHD27_PATH}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCLASHD_GATEWAY_URL</key>
    <string>${GATEWAY_URL}</string>
    <key>OPENCLASHD_TOKEN</key>
    <string>${OPENCLASHD_TOKEN_VALUE}</string>
    <key>CLASHD27_LIBRARY_ROOT</key>
    <string>${LIBRARY_ROOT}</string>
    <key>CLASHD27_LIBRARY_BACKUP_DIR</key>
    <string>${BACKUP_DIR}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LIBRARY_ROOT}/logs/nightly.log</string>
  <key>StandardErrorPath</key>
  <string>${LIBRARY_ROOT}/logs/nightly-error.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load "$PLIST"
echo "Nightly reader scheduled at 03:00"
echo "LaunchAgent: ${PLIST}"
echo "Library root: ${LIBRARY_ROOT}"
echo "Backup dir: ${BACKUP_DIR}"
echo "Gateway URL: ${GATEWAY_URL}"
