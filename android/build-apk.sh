#!/bin/zsh
# 서명된 릴리스 APK를 만들어 iCloud Drive에 넣는다. 갤럭시에서는 파일 앱에서 APK를 열거나
# `adb install -r` 로 설치한다. 결과: android/app/build/outputs/apk/release/app-release.apk
#
#   android/build-apk.sh            # Release
#   android/build-apk.sh --no-copy  # iCloud 복사 생략
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
cd "$SCRIPT_DIR"
./gradlew --no-daemon -q :app:assembleRelease
APK="$SCRIPT_DIR/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || { echo "release APK missing: $APK" >&2; exit 1; }
SHA=$(shasum -a 256 "$APK" | cut -c1-64)
echo "$SHA  app-release.apk" > "$SCRIPT_DIR/app/build/outputs/apk/release/app-release.apk.sha256"
echo "apk: $APK ($(du -h "$APK" | cut -f1)) sha256 $SHA"
if [[ "${1:-}" != "--no-copy" ]]; then
  ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Stream Multiview"
  mkdir -p "$ICLOUD"
  cp "$APK" "$ICLOUD/StreamMultiview.apk"
  echo "copied to iCloud Drive/Stream Multiview/StreamMultiview.apk"
fi
