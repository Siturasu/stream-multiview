#!/bin/bash
# 만료된 SideStore를 맥의 iloader로 재서명·재설치한다. iPad USB 연결, iloader(/Applications)에 Apple ID 저장,
# 이 터미널 앱의 손쉬운 사용 권한이 전제다. 끝나면 iPad에서 SideStore를 열어 자기 자신과 Stream Multiview를 갱신한다.
# 사용: SV_UDID=<iPad UDID> ios/harness/iloader-resign.sh [--stable] [--dry-run]   (기본은 SideStore Nightly, dry-run은 설치 버튼 직전까지)
set -uo pipefail
BUILD="SideStore (Nightly)"; DRY=0
for a in "$@"; do case "$a" in --stable) BUILD="SideStore (Stable)";; --dry-run) DRY=1;; *) echo "모르는 인자: $a"; exit 2;; esac; done
UDID=${SV_UDID:-}
[ -n "$UDID" ] || { echo "사용: SV_UDID=<iPad UDID> ios/harness/iloader-resign.sh [--stable] [--dry-run]  (UDID는 xcrun devicectl list devices로 확인)"; exit 2; }

ax_dump() {
osascript - <<'AS' 2>/dev/null
tell application "System Events"
  tell process "iloader"
    set out to ""
    set els to entire contents of window 1
    repeat with e in els
      try
        set r to role of e
        if r is in {"AXButton", "AXStaticText", "AXTextField", "AXSecureTextField", "AXCheckBox"} then
          set t to name of e
          if t is missing value then set t to ""
          set out to out & r & " | " & t & linefeed
        end if
      end try
    end repeat
    return out
  end tell
end tell
AS
}
ax_press() {
osascript - "$1" <<'AS' 2>/dev/null
on run argv
  tell application "System Events"
    tell process "iloader"
      set els to entire contents of window 1
      repeat with e in els
        try
          if role of e is "AXButton" and name of e is (item 1 of argv) then
            perform action "AXPress" of e
            return "pressed: " & (item 1 of argv)
          end if
        end try
      end repeat
      return "not found: " & (item 1 of argv)
    end tell
  end tell
end run
AS
}
has() { ax_dump | grep -q -F "$1"; }

open -a /Applications/iloader.app || { echo "iloader 없음"; exit 1; }
for i in $(seq 1 20); do sleep 1; osascript -e 'tell application "System Events" to tell process "iloader" to count windows' 2>/dev/null | grep -q '^[1-9]' && break; done
osascript -e 'tell application "System Events" to tell application process "iloader" to set value of attribute "AXEnhancedUserInterface" to true' >/dev/null 2>&1
osascript -e 'tell application "System Events" to tell process "iloader" to set position of window 1 to {300, 120}' >/dev/null 2>&1
sleep 2
has "Version" || { echo "iloader 창을 못 읽음(손쉬운 사용 권한 확인)"; exit 1; }

has "iPad USB Selected" || { ax_press "iPad USB"; sleep 2; }
has "iPad USB Selected" || { echo "iPad가 iloader 기기 목록에 없음. USB 연결과 '이 컴퓨터를 신뢰'를 확인."; ax_dump; exit 1; }
if ! has "Sign Out"; then
  ax_press "Sign in"
  for i in $(seq 1 30); do sleep 2; has "Sign Out" && break; done
fi
has "Sign Out" || { echo "로그인 안 됨(2단계 인증 코드나 비밀번호 입력이 필요). iloader 창을 직접 확인."; ax_dump; exit 1; }
[ "$DRY" = 1 ] && { echo "dry-run: 기기 선택과 로그인 정상. '$BUILD' 설치 직전에서 멈춤."; exit 0; }

echo "$(ax_press "$BUILD")"
ok=0
for i in $(seq 1 60); do
  sleep 5
  d=$(ax_dump)
  echo "$d" | grep -q "SideStore Installed!" && { ok=1; break; }
  echo "$d" | grep -q -i -E "AXStaticText \| .*(error|failed)" && { echo "$d" | grep -i -E "error|failed"; exit 1; }
done
[ "$ok" = 1 ] || { echo "5분 안에 완료 메시지가 없음"; ax_dump; exit 1; }
ax_press "Dismiss" >/dev/null
echo "SideStore 재설치 완료. iPad 설치 상태:"
xcrun devicectl device info apps --device "$UDID" --timeout 90 2>/dev/null | grep -E "SideStore|Stream"
echo "다음: iPad에서 LocalDevVPN 연결 → SideStore 열기 → 자기 자신 갱신 → My Apps의 Stream Multiview 갱신."
