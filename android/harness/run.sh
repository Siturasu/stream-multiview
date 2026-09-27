#!/usr/bin/env bash
# Runs the Android verification harness against the app already running on the
# connected device/emulator. Finds the WebView DevTools socket, forwards it and
# hands every argument to cdp-scenario.mjs (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PACKAGE="${SV_PACKAGE:-dev.siturasu.streammultiview}"
PORT="${SV_PORT:-9222}"

[ -x "$ADB" ] || { echo "adb not found at $ADB (set ADB=...)" >&2; exit 2; }

PID="$("$ADB" shell pidof "$PACKAGE" | tr -d '\r' | awk '{print $1}')"
if [ -z "$PID" ]; then
  echo "$PACKAGE is not running; launch it first" >&2
  exit 2
fi

SOCKET="webview_devtools_remote_$PID"
# The renderer may host the socket under a different pid than the browser
# process; fall back to whatever devtools socket the app actually opened.
if ! "$ADB" shell cat /proc/net/unix | tr -d '\r' | grep -q "@$SOCKET\$"; then
  FOUND="$("$ADB" shell cat /proc/net/unix | tr -d '\r' | grep -o 'webview_devtools_remote_[0-9]*' | head -n 1)"
  [ -n "$FOUND" ] && SOCKET="$FOUND"
fi

"$ADB" forward "tcp:$PORT" "localabstract:$SOCKET" >/dev/null
echo "[run.sh] $PACKAGE pid=$PID socket=$SOCKET forwarded to tcp:$PORT" >&2

set +e
ADB="$ADB" node "$HERE/cdp-scenario.mjs" --port "$PORT" --adb "$ADB" "$@"
STATUS=$?
set -e
exit $STATUS
