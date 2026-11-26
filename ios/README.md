# Stream Multiview for iPad

크롬 확장 뷰어를 그대로 감싼 개인용 iPadOS 앱. WKWebView 하나가 `viewer.html`을 띄우고,
확장의 콘텐츠 스크립트는 WKUserScript로 치지직 iframe에 주입한다. 앱스토어 배포 없이
SideStore 또는 Xcode로 본인 아이패드에 설치해 쓴다.

## 구성

| 경로 | 역할 |
|---|---|
| `project.yml` | XcodeGen 정의. `StreamMultiview.xcodeproj`는 여기서 생성 |
| `Sources/Core/WebAssets.swift` | viewer.html에 CSS, chrome 대체 계층, viewer.js를 인라인. ES 모듈은 data: URL로 묶음 |
| `Sources/Core/NativeBridge.swift` | `chrome.storage`(UserDefaults), 치지직 API와 유튜브 HTML fetch(URLSession), 외부 링크 열기 |
| `Sources/Core/ViewerWebViewController.swift` | WKWebView 설정, 사용자 스크립트 주입, 내비게이션 가로채기 |
| `Sources/App/` | SwiftUI 진입점과 전체화면 웹뷰 |
| `Resources/ios-web/chrome-shim.js` | viewer.js가 쓰는 `chrome.*` API를 네이티브 브리지로 연결 |
| `harness/` | macOS 하네스. Xcode 없이 이 맥의 WebKit으로 실제 동작을 검증 |
| `build-ipa.sh` | 서명 없는 ipa 생성(SideStore 설치용). 결과는 `build/`(git 제외) |
| `Local.xcconfig` | Xcode 직접 실행 시에만 필요한 Team ID |

웹 자산(`viewer.*`, `background.js`, `src/`, `content/`)은 레포 루트를 직접 참조한다.
확장 쪽 파일을 고치면 앱에도 그대로 들어간다.

버전은 0.1.6(7)이다. 씨미(ci.me) 타일은 사이트가 프레임 표시를 막아(X-Frame-Options, frame-ancestors) 페이지를 넣지 않고,
`src/shared/cime-player.js`가 만든 srcdoc 문서가 방송 주소(IVS HLS)를 직접 재생한다. 씨미 API는 CORS가 없어 `chrome-shim.js`가
네이티브 fetch(`ci.me`)로 중계한다. 프레임은 치지직과 같은 postMessage 규약으로 소리, 볼륨, 상태를 주고받고,
오른쪽 아래 전체화면 버튼(44px)이 있다. 볼륨은 세터를 쓴 뒤 읽은 값으로 지원 여부를 판정한다. 씨미 채팅은 앱에서 못 열고 원본 버튼으로 연다.

## 왜 이렇게 만들었나

- 뷰어 문서를 `loadHTMLString(_:baseURL: https://chzzk.naver.com/)`로 올린다. 실기기에서 네이버
  로그인 쿠키(NID_AUT, NID_SES)는 SameSite=Lax로 저장되는데, Lax 쿠키는 추적 방지 해제나
  Storage Access와 무관하게 크로스사이트 iframe에는 절대 실리지 않는다. 뷰어가 chzzk.naver.com
  오리진이면 방송 iframe이 same-site라 쿠키가 그대로 흐른다(0.1.4에서 `stream-multiview.invalid`
  오리진을 이것으로 바꿈). 유튜브 embed에 필요한 Referer도 이 오리진으로 나간다. 메인 프레임이
  실제 chzzk.naver.com으로 이동하는 일은 내비게이션 델리게이트가 전부 가로챈다.
- UA를 데스크톱 사파리로 고정한다. 치지직은 UA에 `mobile`이 들어가면 m.chzzk로
  보내는데, 그 빌드는 360p로 시작하고 화질 키(`live-player-video-track`)가 없다.
- `api.chzzk.naver.com`은 CORS 허용 오리진이 chzzk.naver.com뿐이라 페이지 fetch가
  403이다. 그래서 `background.js`의 요청 로직은 그대로 두고 전역 `fetch`만 네이티브
  URLSession으로 바꿔 끼운다(Origin 헤더가 없으면 200).
- 치지직 다시보기 주소도 타일로 추가할 수 있다. 영상은 첫 재생 전에 inline·음소거 상태를
  적용하고, 재생 시작 Promise가 완료된 뒤 각 타일의 소리 선택을 복원한다. iOS 관리 프레임에서는 페이지 이동으로
  제어용 query가 사라져도 동작한다. 전체화면과 로그인 연결 UI는 iOS 전용이다.

## 설치 A: SideStore (무료 Apple ID, 7일 갱신 자동)

채택한 방식. 서명 없는 ipa를 만들어 아이패드의 SideStore가 본인 Apple ID로 서명한다.
Team ID도, Xcode에서 매주 Run 할 필요도 없다. 이 기기에서는 2026-09-13 Stable 로그인
503 오류 후 Nightly 0.7.0으로 갱신했고, SideStore 로그인과 앱 설치를 확인했다.

ipa 만들기(맥):

```
ios/build-ipa.sh        # → ios/build/StreamMultiview.ipa (서명 없음, arm64)
```

생성한 파일을 iCloud Drive의 `Stream Multiview/StreamMultiview.ipa`로 복사한다.
레포 폴더 자체가 아이패드에 그대로 보인다고 가정하지 않는다.

처음 한 번(맥 + 아이패드, USB 연결):

1. 맥에 iloader 설치. https://github.com/nab138/iloader/releases 의 `iloader-darwin-universal.dmg`.
   AltServer 방식은 이제 구식으로 분류된다.
2. 아이패드를 USB로 연결하고 "이 컴퓨터를 신뢰" 후 암호 입력.
3. iloader 실행 > Apple 계정 로그인 > 기기 선택 > SideStore 설치.
   페어링 파일은 iloader가 알아서 만들어 넣는다(따로 옮길 것 없음).
4. 아이패드 설정 > 일반 > VPN 및 기기 관리 > 개발자 앱 > 본인 계정 > 신뢰 > 허용 및 재시동.
5. 설정 > 개인정보 보호 및 보안 > 개발자 모드 켬 > 재시동.
6. App Store에서 LocalDevVPN(무료, Coxson Engineering) 설치 후 연결. StosVPN은 구버전이라 쓰지 않는다.
7. SideStore 실행 > 같은 Apple 계정으로 로그인(일반 비밀번호 + 2단계 인증 코드, 앱 암호 불필요).
8. My Apps에서 SideStore 옆 "7 DAYS"를 눌러 한 번 갱신한다. 다른 앱을 넣기 전에 반드시 한다.

Stable 로그인에서 `Invalid server response`와 `503 Service Temporarily Unavailable`이
나면, 이 기기에서 확인한 방법은 iloader의 Nightly 덮어쓰기다. 0.7.0의
Settings → User Customizations → Reset adi.pb에서 Keep Headers를 해제하고 재시도한다.
[SideStore 유지보수자 안내](https://github.com/SideStore/SideStore/issues/1502#issuecomment-5627566740).

앱 설치와 업데이트:

1. SideStore > My Apps > 오른쪽 위 "+" > 파일 선택 > iCloud Drive에서 `StreamMultiview.ipa`.
2. 코드를 고쳤으면 `(cd ios && xcodegen generate)`와 `ios/build-ipa.sh` 후 iCloud Drive 파일을 교체한다.
   같은 방법으로 설치하면 덮어쓴다. 기존 앱을 먼저 삭제할 필요는 없다.

갱신:

- Wi-Fi와 LocalDevVPN이 둘 다 연결된 상태에서 SideStore가 백그라운드에서 갱신한다.
  iOS가 기회를 주는 방식이라 SideStore를 가끔 열어 주면 확실하다. 수동은 My Apps에서
  앱 옆 "N DAYS"를 누른다. 셀룰러 갱신은 0.6.4의 선택 기능이다.
- 무료 계정 한도: 동시 설치 3개(SideStore 포함이라 내 앱은 2개), App ID 7일에 10개.
- 갱신 실패의 흔한 원인: VPN이 LocalDevVPN이 아님, Wi-Fi 또는 VPN 끊김, 페어링 파일 만료
  (iloader에서 다시 배치), DNS 차단 앱. iPadOS 26.4 이상에서 AFC 오류(minimuxer 27)가
  나면 문서가 SideStore nightly를 권한다.

만료 복구(둘 다 7일을 넘겨 SideStore까지 만료된 경우, 2026-10-09 확인):

```
ios/harness/iloader-resign.sh          # iPad USB 연결 후. iloader 저장 로그인으로 SideStore Nightly 재설치, 15초
```

그 다음 iPad에서 LocalDevVPN 연결 → SideStore 열기 → 자기 자신 갱신 → My Apps의 Stream Multiview 갱신.
앱은 지워지지 않으므로 ipa를 다시 넣을 필요는 없다. 7일 갱신 자체를 없애려면 유료 개발자 프로그램(1년 서명)뿐이다.

## 설치 B: Xcode에서 직접 실행 (Team ID 필요)

1. Xcode 26.6 이상(이 맥에는 설치되어 있다). 처음 실행 시 iOS 플랫폼 구성요소를 받는다.
2. Xcode > Settings > Accounts에 Apple ID를 추가하고, 팀 목록의 Team ID(10자리)를
   `ios/Local.xcconfig`의 `DEVELOPMENT_TEAM =` 뒤에 적는다. 이 값이 비어 있으면 기기
   빌드가 "requires a development team"으로 실패한다(시뮬레이터와 build-ipa.sh는 무관).
   Xcode 화면에서 팀을 고르는 방법은 `xcodegen generate`를 돌리면 지워진다.
3. `ios/StreamMultiview.xcodeproj`를 연다. Bundle Identifier가 겹치면 project.yml의
   `PRODUCT_BUNDLE_IDENTIFIER` 뒤에 아무 문자열이나 붙이고 재생성한다.
4. 아이패드를 케이블로 연결하고 설정 > 개인정보 보호 및 보안 > 개발자 모드를 켠다(재부팅).
5. 실행 대상에서 아이패드를 고르고 Run. 첫 실행은 아이패드에서
   설정 > 일반 > VPN 및 기기 관리에서 개발자 앱을 신뢰해야 한다.
6. 무료 Apple ID는 7일마다 만료된다. 유료 개발자 프로그램(연 99달러)이면 1년이다.

## 로그인 (성인 인증 방송, 멤버십)

크롬 확장은 브라우저에 로그인된 네이버, 구글 세션을 그대로 쓰지만, 앱은 자체 쿠키
저장소를 가진다.

- 상단 바의 "계정" 버튼이 앱 안 로그인 화면을 연다. 치지직(네이버)과 유튜브(구글)에
  최상위 페이지로 로그인하면 쿠키가 `WKWebsiteDataStore.default()`에 남고 앱을 다시 켜도
  유지된다. 닫으면 방송과 열린 채팅 프레임만 다시 로드되어 새 쿠키를 반영한다.
  타일 구성과 소리 선택은 유지되며, “마지막 구성 기억”을 꺼도 현재 타일은 사라지지 않는다.
- 치지직 페이지에 도착하면 사이트의 로그인 상태를 확인해 안내한다. "로그인이 확인됐습니다"가
  나오면 아래 치지직 화면을 한 번 누른 뒤 완료한다. 방송 타일에 "방송에 로그인 연결"이
  나오면 "방송에 연결"을 누르고 접근 요청을 허용한다. 연결 성공 시 해당 타일이 다시 로드된다.
  공개 방송만 볼 때는 "나중에"로 닫을 수 있다.
- 상태 확인이 실패하면 계정 화면의 "다시 확인"으로 확인 요청만 다시 실행한다.
  0.1.1의 확인 코드에는 API 서버 오류가 있었으며 0.1.2에서 CHZZK 공식 NNG user client의
  `comm-api.game.naver.com/nng_main/v1/user/getUserStatus`로 고쳤다. HTTP/통신/응답형식 오류는
  로그인 실패와 구분한다.
- 방송 안 연결 버튼은 사용자의 실제 클릭에서 WebKit Storage Access API를 호출한다.
  최상위 페이지 로그인과 iframe의 로그인 상태를 각각 확인하며, 계정 식별자나 쿠키 값을
  UI/로그로 전달하지 않는다. [WebKit 사용 조건](https://webkit.org/blog/11545/updates-to-the-storage-access-api/).
- 뷰어 안의 치지직, 유튜브는 서드파티 iframe이라 WebKit 추적 방지가 쿠키를 막는다.
  `WebKitPrivateSettings`가 데이터 저장소의 `_setResourceLoadStatisticsEnabled:`를 꺼서
  쿠키가 프레임까지 전달되게 한다. 비공개 API라 존재 여부를 확인하고 호출하며, 하네스가
  프로브 쿠키로 전달 여부를 실측한다(macOS WebKit과 iPad 시뮬레이터에서 두 프레임 모두 확인).
  이는 테스트 쿠키의 접근 가능성만 확인하며, 실제 HttpOnly 로그인 쿠키나 인증 방송 재생을 보장하지 않는다.
  같은 목적의 `_setShouldRelaxThirdPartyCookieBlocking:`은 사파리 밖에서 예외를 던져 쓰지
  않는다.

실제 계정의 인증 방송·멤버십 재생은 실기기 확인 대상이다. 구글 로그인은 임베디드 웹뷰를
거부할 수 있으며, 이번 치지직 연결 보완으로 유튜브 계정 사용까지 확인한 것은 아니다.

## 조작

- 왼쪽 패널에서 멤버를 고르거나 치지직, 유튜브 주소를 붙여 넣는다.
- 타일 위 컨트롤(소리, 채팅, 새로고침, 원본, 제거, 순서 손잡이)은 원래 마우스 호버에서만
  보이지만, 터치 기기에서는 `viewer.css`가 항상 보이게 한다.
- 치지직 `/video/숫자ID` 다시보기 주소도 지원한다. 다시보기에는 실시간 채팅이 없다.
- 상단 바의 "볼륨" 버튼이 볼륨 패널을 연다. 타일마다 이름, 소리 켬/끔, 0~100 슬라이더가 있고
  "모두 음소거"와 "모두 100%"가 있다. 값은 설정에 저장되어 다음 실행에도 유지된다. 슬라이더는
  치지직 프레임과 유튜브 프레임의 영상 볼륨을 직접 맞추며(iPadOS 26 WebKit도 반영 확인), 프레임이
  "지원 안 됨"을 보고하는 기기에서는 슬라이더가 비활성화되고 켬/끔만 남는다. Esc로 닫힌다.
- 타일의 "소리" 버튼은 각각 독립적으로 켜고 끈다. 여러 타일의 소리를 동시에 켤 수 있으며,
  "모두 음소거"로 한 번에 끈다. 다른 타일의 소리를 켜도 먼저 켠 타일은 꺼지지 않는다.
  소리 변경·화면 크기 변경은 일시정지한 영상을 다시 재생하지 않는다.
- 앱 상단 전체화면은 그리드를 넓히고, 영상 안 전체화면은 해당 타일을 크게 표시한다.
  iOS에서는 기존 iframe을 유지한 채 크기를 바꾸며, 진입 시 조작부를 숨긴다. 화면을 터치하면
  상단 조작부와 "전체 화면 종료"가 나타나고 1.8초 비활성 후 다시 숨는다. 키보드 포커스 중인
  조작부는 유지한다. 숨겨진 상태의 첫 터치는 조작부만 표시하며 영상을 멈추지 않는다.
  조작부를 표시한 뒤에는 사이트 영상 내부의 자체 제어도 사용할 수 있다.
- 여러 영상을 켰을 때 버벅이면 화질을 낮춘다. M1 실기기의 4타일 성능·발열은 미확인이다.

## 검증(하네스)

시나리오는 `Sources/Core/ViewerScenario.swift` 하나이고 두 곳에서 돌린다.

macOS(이 맥의 WebKit, Xcode 불필요):

```
ios/harness/run.sh                      # 첫 LIVE 멤버 + 기본 유튜브 VOD
ios/harness/run.sh --channel <채널ID>   # 특정 치지직 채널
ios/harness/run.sh --youtube <영상ID>   # 특정 유튜브 영상, none이면 생략
ios/harness/run.sh --cime <slug>        # 씨미 채널(기본 hebi), none이면 생략. 라이브 slug면 재생과 볼륨 검사, 오프라인이면 inconclusive
npm run check:cime                      # 씨미 주소, 멤버, 매니페스트, 플레이어 소스 검증(네트워크 없음)
ios/harness/run.sh --keep               # 끝나도 창을 닫지 않음
ios/harness/run.sh --keep-data ...      # 하네스의 WebKit 프로필(쿠키)을 지우지 않음
ios/harness/run.sh --timeout 60         # 본 방송/음소거 해제 각 단계에서 최대 60초 대기
ios/harness/run.sh --videos 14920476,14782779 --app-fullscreen --timeout 90
npm run check:chzzk-vod                 # 주소·독립 소리·재생 완료/일시정지·관리 프레임 범위
npm run check:volume-panel              # 볼륨 패널 상태·명령·저장 검증
npm run check:volume-frame              # 프레임의 set-volume 처리(element/webaudio/none)·오리진 검증
npm run check:ios-fullscreen            # 진입·복귀·프레임 출처 검증
node ios/harness/check-session-access.mjs # 실제 클릭·연결 실패·공개 영상 UI 검증
ios/harness/check-playback.sh           # 광고·교체·정지·음소거 오판 회귀 검증(네트워크 없음)
ios/harness/check-native-fetch.sh       # 리다이렉트·응답 크기 제한 회귀 검증(네트워크 없음)
python3 ios/harness/check-ipa-build.py   # 실패한 빌드의 이전 앱 재포장 방지 검증
```

iPad 시뮬레이터(iOS WebKit):

```
cd ios
xcodebuild -project StreamMultiview.xcodeproj -scheme StreamMultiview -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' -derivedDataPath /tmp/sv-derived build
UDID=$(xcrun simctl list devices available | grep 'iPad Pro 13-inch (M5)' | grep -o '[0-9A-F-]\{36\}')
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "/tmp/sv-derived/Build/Products/Debug-iphonesimulator/Stream Multiview.app"
SIMCTL_CHILD_SV_TIMEOUT=30 xcrun simctl launch "$UDID" dev.siturasu.stream-multiview -svHarness
cat "$(xcrun simctl get_app_container "$UDID" dev.siturasu.stream-multiview data)/Documents/sv-harness-report.json"
```

환경변수 `SV_YOUTUBE`(영상ID 또는 none), `SV_CIME`(slug 또는 none), `SV_CHANNEL`, `SV_VIDEOS`(쉼표 구분 다시보기 ID),
`SV_TIMEOUT`은 `SIMCTL_CHILD_` 접두어로
넘긴다. 실기기에서는 Xcode 스킴의 Arguments Passed On Launch에 `-svHarness`를 넣고 실행한
뒤 Devices 창에서 앱 컨테이너를 내려받아 같은 파일을 읽는다.

확인 항목은 뷰어 렌더링, 방송 상태 조회(네이티브 fetch), 치지직 iframe 핸드셰이크와
스크립트 주입, 데스크톱 호스트 유지, 서드파티 쿠키 전달(프로브 쿠키), 화질 선택,
재생 진행(2초 간격 두 번 샘플), 음소거 해제, 유튜브 embed 재생, 로그인 화면 닫기 후
기억하지 않는 타일 구성 보존이다. 치지직의 알려진 광고 주소
`api.chzzk.naver.com/service/t/`는 재생 판정에서 제외하고, 동일 video 요소·동일 소스의
본 영상 진행을 별도로 요구한다. 광고 중에는 `--timeout`/`SV_TIMEOUT`까지 기다리며,
그 안에 본 영상을 확인하지 못하면 실패한다. 새 광고 전달 방식의 판별은 별도 확인이 필요하다.
LIVE 멤버가 없으면
재생 관련 항목은 실패 대신 inconclusive로 기록된다. 실패가 있으면 종료 코드 1이다.
`--videos`/`SV_VIDEOS`는 별도 다시보기 시나리오다. 두 영상의 본 재생이 같은 시간창에서
함께 진행되는지, 두 소리 동시 켬·하나만 끔·모두 끔, 전체화면 숨김·터치 표시·복귀,
iframe 유지와 제어 query 유실 후 재생을 확인한다. 새 최상위 페이지의 익명 로그인 판별과
각 iframe의 상태 확인 응답도 검사한다. 광고 진행만으로 통과하지 않는다.
최신 실행 결과는 `../HANDOFF.md`에 기록한다.

## 실기기에서만 확인할 수 있는 것

- 두 전체화면 버튼의 실기기 동작과 종료 터치, 타일 순서 끌기(터치 드래그), PiP.
- 실제 치지직 로그인 연결과 인증 방송·멤버십 재생.
- 4타일 1080p60 동시 디코딩의 발열과 배터리. 버벅이면 화질 선택을 720p로 내린다.
- 구글 로그인이 임베디드 웹뷰를 거부하는지 여부.
- 씨미 타일: iPadOS WebKit이 `video.volume` 세터를 반영하는지(무시하면 슬라이더가 비활성화되고 힌트가 보여야 함), srcdoc 전체화면 버튼과 타일 확대, 여러 타일 동시 재생의 발열.

## 프로젝트 재생성

```
brew install xcodegen
cd ios && xcodegen generate
```
