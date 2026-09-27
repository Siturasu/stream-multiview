#!/bin/zsh
# 서명 없는 .ipa 를 만든다. SideStore/AltStore 가 아이패드에서 본인 Apple ID로 다시 서명하므로
# Team ID 없이도 된다. 결과: ios/build/StreamMultiview.ipa
#
#   ios/build-ipa.sh            # Release
#   ios/build-ipa.sh Debug
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
CONFIGURATION="${1:-Release}"
DERIVED="${TMPDIR:-/tmp}/stream-multiview-derived-ios"
OUT_DIR="$SCRIPT_DIR/build"
APP_NAME="Stream Multiview.app"

APP="$DERIVED/Build/Products/$CONFIGURATION-iphoneos/$APP_NAME"
# Do not let a previous build masquerade as this build when xcodebuild fails
# or returns success without producing a fresh app bundle.
rm -rf "$APP"

BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/stream-multiview-xcodebuild.XXXXXX")"
trap 'rm -f "$BUILD_LOG"' EXIT

if ! xcodebuild -project "$SCRIPT_DIR/StreamMultiview.xcodeproj" -scheme StreamMultiview \
  -configuration "$CONFIGURATION" -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build >"$BUILD_LOG" 2>&1; then
  grep -E "error:|warning:|BUILD" "$BUILD_LOG" || true
  exit 1
fi
grep -E "error:|warning:|BUILD" "$BUILD_LOG" || true

[[ -d "$APP" ]] || { echo "build output missing: $APP" >&2; exit 1; }

rm -rf "$OUT_DIR/Payload" "$OUT_DIR/StreamMultiview.ipa"
mkdir -p "$OUT_DIR/Payload"
cp -R "$APP" "$OUT_DIR/Payload/"
(cd "$OUT_DIR" && zip -qr StreamMultiview.ipa Payload && rm -rf Payload)
echo "ipa: $OUT_DIR/StreamMultiview.ipa ($(du -h "$OUT_DIR/StreamMultiview.ipa" | cut -f1))"
