#!/usr/bin/env bash
# Downloads the current Stable "Chrome for Testing" build into
# ~/.cache/stream-multiview/browsers and prints the binary path on stdout.
#
# Branded Chrome 137+ ignores --load-extension, so the harness needs a Chrome
# for Testing build. npm/npx is deliberately not used here (the user's npm
# cache is root-owned and fails).
set -euo pipefail

CACHE_ROOT="${SV_BROWSER_CACHE:-$HOME/.cache/stream-multiview/browsers}"
FEED="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"

case "$(uname -m)" in
  arm64) PLATFORM="mac-arm64" ;;
  x86_64) PLATFORM="mac-x64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

BINARY="$CACHE_ROOT/chrome-$PLATFORM/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
if [ -x "$BINARY" ] && [ "${SV_FORCE_DOWNLOAD:-0}" != "1" ]; then
  echo "already installed: $("$BINARY" --version)" >&2
  echo "$BINARY"
  exit 0
fi

mkdir -p "$CACHE_ROOT"
TMP_JSON="$(mktemp)"
trap 'rm -f "$TMP_JSON"' EXIT

echo "[install-chrome] fetching $FEED" >&2
curl -fsSL "$FEED" -o "$TMP_JSON"

# The feed is one JSON object; node reads it without any npm dependency.
read -r VERSION URL <<EOF
$(node -e '
const feed = require(process.argv[1]);
const stable = feed.channels.Stable;
const entry = stable.downloads.chrome.find((d) => d.platform === process.argv[2]);
if (!entry) { console.error("no download for " + process.argv[2]); process.exit(1); }
console.log(stable.version + " " + entry.url);
' "$TMP_JSON" "$PLATFORM")
EOF

echo "[install-chrome] Stable $VERSION for $PLATFORM" >&2
ZIP="$CACHE_ROOT/chrome-$PLATFORM.zip"
curl -fsSL "$URL" -o "$ZIP"
rm -rf "$CACHE_ROOT/chrome-$PLATFORM"
unzip -q "$ZIP" -d "$CACHE_ROOT"
rm -f "$ZIP"

if [ ! -x "$BINARY" ]; then
  echo "[install-chrome] unzip did not produce $BINARY" >&2
  exit 1
fi

# Gatekeeper marks the freshly downloaded bundle; clearing the quarantine flag
# keeps the first launch from stalling on a dialog.
xattr -dr com.apple.quarantine "$CACHE_ROOT/chrome-$PLATFORM" 2>/dev/null || true

echo "[install-chrome] installed: $("$BINARY" --version)" >&2
echo "$BINARY"
