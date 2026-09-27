#!/bin/zsh
# macOS 하네스: 앱 번들과 같은 배치로 웹 루트를 스테이징하고, Command Line Tools의
# swiftc로 Core 소스 + 하네스를 빌드한 뒤 실행한다. Xcode가 없어도 된다.
#
#   ios/harness/run.sh [--keep-data] [--youtube VIDEO_ID|none] [--channel CHANNEL_ID] [--timeout SEC] [--keep] [--private none|all]
#
# 기본으로 하네스 프로세스의 WebKit 프로필(쿠키, 캐시, 추적 통계)을 지우고 시작한다.
# 실제 로그인 쿠키를 유지한 채 돌리려면 --keep-data 를 첫 인자로 준다.
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
REPO="${SCRIPT_DIR:h:h}"
STAGE="${TMPDIR:-/tmp}/stream-multiview-webroot"
# WebKit creates "<TMPDIR>/<process name>/WebKit/..." caches, so the binary
# must not itself live at "<TMPDIR>/<process name>".
BIN_DIR="${TMPDIR:-/tmp}/stream-multiview-harness-build"
PROCESS_NAME="stream-multiview-harness"
BIN="$BIN_DIR/$PROCESS_NAME"

if [[ "${1:-}" == "--keep-data" ]]; then
  shift
else
  rm -rf "$HOME/Library/WebKit/$PROCESS_NAME" \
         "$HOME/Library/HTTPStorages/$PROCESS_NAME" \
         "$HOME/Library/HTTPStorages/$PROCESS_NAME.binarycookies" \
         "$HOME/Library/Caches/$PROCESS_NAME"
fi

rm -rf "$STAGE"
mkdir -p "$STAGE" "$BIN_DIR"
cp "$REPO"/viewer.html "$REPO"/viewer.css "$REPO"/viewer.js "$REPO"/background.js "$STAGE"/
cp -R "$REPO"/src "$REPO"/content "$STAGE"/
cp -R "$REPO"/ios/Resources/ios-web "$STAGE"/

swiftc -swift-version 5 -Onone -framework AppKit -framework WebKit \
  -module-cache-path "$BIN_DIR/module-cache" \
  -o "$BIN" "$REPO"/ios/Sources/Core/*.swift "$SCRIPT_DIR"/main.swift

exec "$BIN" "$STAGE" "$@"
