#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
REPO="${SCRIPT_DIR:h:h:h}"
# Per-user TMPDIR (same as ../run.sh) so another account cannot pre-create
# these directories or plant the binary that SKIP_BUILD=1 runs.
STAGE="${TMPDIR:-/tmp}/sv-login-probe-webroot"
BIN_DIR="${TMPDIR:-/tmp}/sv-login-probe-build"
PROCESS_NAME="sv-login-probe"
BIN="$BIN_DIR/$PROCESS_NAME"

rm -rf "$HOME/Library/WebKit/$PROCESS_NAME" \
       "$HOME/Library/HTTPStorages/$PROCESS_NAME" \
       "$HOME/Library/HTTPStorages/$PROCESS_NAME.binarycookies" \
       "$HOME/Library/Caches/$PROCESS_NAME"

rm -rf "$STAGE"; mkdir -p "$STAGE" "$BIN_DIR"
cp "$REPO"/viewer.html "$REPO"/viewer.css "$REPO"/viewer.js "$REPO"/background.js "$STAGE"/
cp -R "$REPO"/src "$REPO"/content "$STAGE"/
cp -R "$REPO"/ios/Resources/ios-web "$STAGE"/

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  swiftc -swift-version 5 -Onone -framework AppKit -framework WebKit \
    -module-cache-path "$BIN_DIR/module-cache" \
    -o "$BIN" "$REPO"/ios/Sources/Core/*.swift "$SCRIPT_DIR"/main.swift
fi
[[ -O "$BIN_DIR" && -O "$BIN" ]] || { echo "refusing to run $BIN: not owned by $USER" >&2; exit 1; }
exec "$BIN" "$STAGE" "$@"
