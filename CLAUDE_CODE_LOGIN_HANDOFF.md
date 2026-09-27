# Claude Code 인수인계 및 작업지시서: Stream Multiview 로그인 미해결

작성일: 2026-09-13. 작업 폴더: `/Users/dw.kang/Documents/Claude/Projects/personal/stream-multiview`.
사용자가 직접 iPad를 확인하며 Claude Code와 재현·수정을 진행하기 위한 문서다.
Codex는 이번 차례에 이 문서와 HANDOFF만 작성했으며, 여기 적은 후속 진단·수정을 실행하지 않았다.

## 1. 시작할 때 읽을 내용

사용자의 최신 보고는 “로그인이 전혀안됨”이다. 로그인은 미해결이다.
이전의 “검증 통과”는 익명 상태와 공개 영상 재생 검사였고 실제 계정 인증 성공 기록은 없다.
아래 작업을 실행할 때 설치 버전과 실패 단계를 먼저 확정하고, 같은 설치/로그인 안내를 반복하지 말 것.

1. `HANDOFF.md` 1·15절을 먼저 읽고 14절은 직전 구현 이력으로 읽는다.
2. 이 문서의 사용자 확인표로 실패 지점을 정한다.
3. 현재 소스에서 필요한 부분만 진단·수정하고, 실제 계정으로 수정 전/후를 대조한다.
4. 실제 기기 확인을 기다리는 상태는 “실기기 검증 대기”로 남긴다. 완료로 보고하지 않는다.

현재 요청의 우선 대상은 Stream Multiview 앱 내부의 치지직(네이버) 로그인이다.
SideStore의 Apple 계정은 설치/서명용이며 과거 설치 단계에서 이미 로그인 성공했다.
최신 실패 보고가 SideStore나 유튜브를 뜻하는 것으로 확인되면 그 사실을 기록하고 범위를 맞춘다.

## 2. 작업 환경·보존 조건

| 항목 | 인수 상태 |
|---|---|
| 실제 기기 | 기존 인계 기록: iPad Pro 12.9 5세대 M1, iPadOS 26.6.2. 작업 시 설정 화면으로 확인 |
| Mac | 기존 기록: macOS 26.6.2, Xcode 26.6, iOS SDK 26.5, XcodeGen |
| 마지막 전달 IPA | 0.1.2(3), 814,496바이트. 현재 iPad 설치 버전은 미확인 |
| 로컬 파일 | `ios/build/StreamMultiview.ipa` |
| 전달 위치 | `iCloud Drive/Stream Multiview/StreamMultiview.ipa` |
| SHA256 | `e1653ff0873257d88a73064ad04ce00050a55c3336856e961d60325ee9b1886c` |
| 설치 방식 | SideStore Nightly 0.7.0 사용 이력. USB 신뢰·개발자 모드·첫 설치는 이미 완료 |
| 작업 트리 | README.md, content/chzzk-main.js, package.json, popup.js, src/shared/streams.js, viewer.js 수정 상태. ios/ 전체 untracked |

사용자는 코드·빌드·자동 테스트에 일반 개발 도구 사용을 허용했다. Mac 설치·파일 전달·화면 확인은
Computer Use 조건을 유지한다. Claude Code 환경에 해당 도구가 없으면 사용자에게 그 UI 단계만 맡기고
코드·자동 검사 등 독립 작업을 계속한다. 임의의 다른 화면 제어 방식으로 조건을 우회하지 않는다.
서브에이전트가 필요하면 사용자가 지정한 sol/terra, 업무 수준에 맞춰 medium~xhigh를 사용한다.

기존 변경을 stash/reset/clean하거나 ios/를 덮어쓰지 않는다. HANDOFF와 build 결과는 git 제외다.
clone한 HEAD에 iOS 코드가 모두 들어 있다고 가정하지 않는다. 이 문서는 commit/push 지시가 아니다.
원인 확인 전에 앱 삭제·쿠키 초기화·SideStore 재설치를 하지 않는다. 현재 실패 증거와 세션을 보존한다.

## 3. 사용자가 직접 확인할 순서

비밀번호·인증코드는 사용자가 기기에서 직접 입력한다. 채팅이나 문서에 적지 않는다.
한 번의 재현에서 아래 표를 위에서부터 확인하고 처음 실패한 단계의 화면 문구를 기록한다.

| 순서 | 기기에서 확인 | 기록할 내용 |
|---|---|---|
| A | 실행한 앱이 Stream Multiview인지, 설치된 버전/빌드 | 앱 이름·표시 버전·확인 시각. 빌드가 안 보이면 미확인으로 두고 Claude가 표시 수단 추가 |
| B | 앱의 계정 → 치지직(네이버)에서 사용자 직접 로그인 | 인증 완료/실패/추가 인증 여부, 오류 문구, 최종 화면의 사이트 |
| C | 로그인 후 같은 앱 내부 치지직 화면 | 프로필/로그아웃 등 로그인된 사이트 UI가 보이는지. 닉네임 등 식별자는 공유 불필요 |
| D | 앱 상단 상태 문구와 “다시 확인” 1회 | 사이트는 로그인됐는데 앱만 미확인인지, 실제 사이트도 비로그인인지 구분 |
| E | 로그인된 치지직 화면을 한 번 터치하고 완료 → 방송 타일 | “방송에 로그인 연결” 유무, “방송에 연결” 클릭 후 허용 창·성공·오류 문구 |
| F | 본인에게 접근 권한이 있는 로그인 필요 콘텐츠 | 계정 화면과 타일에서 같은 콘텐츠의 접근 가능 여부. 공개 VOD 재생만으로 대체하지 않음 |
| G | 앱 종료 후 재실행 | 다시 로그인해야 하는지, 두 타일 각각에 세션이 유지되는지 |

E~G는 앞선 단계가 성공한 경우에만 진행한다. 인증 실패 상태에서 타일 연결을 반복하지 않는다.
Safari 비교가 필요하면 같은 iPad·같은 네트워크·같은 계정·같은 콘텐츠 조건을 기록한다.
Safari 성공은 계정/콘텐츠 비교 자료이며 앱 WKWebView 쿠키 공유의 증거는 아니다.
확인할 로그인 필요 콘텐츠가 없으면 권한 있는 콘텐츠를 준비할 때까지 그 항목은 검증 대기로 둔다.

복사해 채울 기록:

```text
확인 시각 / iPadOS:
실행 앱 / 설치 버전·빌드 / 버전 확인 방법:
로그인 대상: 치지직(네이버) / 유튜브(구글) / SideStore(Apple)
처음 실패한 단계: A / B / C / D / E / F / G
앱 상태 문구:
사이트 또는 타일의 오류 문구:
앱 내부 치지직의 로그인된 UI: 있음 / 없음 / 확인 못함
방송에 연결 클릭 결과:
확인 콘텐츠: 공개 주소 또는 콘텐츠 ID만 기록(인증 토큰 포함 주소 금지)
같은 계정·콘텐츠의 비교 결과:
앱 재실행 후 결과:
```

## 4. 이미 확인한 것과 아직 확인하지 못한 것

0.1.1 상태 확인 URL의 호스트가 잘못되어 404/TypeError가 발생했다. 0.1.2에서
`https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus`로 수정했다.
이 변경으로 확인한 것은 익명 HTTP 200·code 200·loggedIn=false 응답이다.
현재 사용자 로그인 실패의 원인이 모두 해결됐다는 의미가 아니다.

두 파일을 직접 읽으면 다음 결과를 볼 수 있다:

- `ios/build/macos-vod-0.1.2-report.json`
- `ios/build/ipad-simulator-vod-0.1.2-report.json`

```json
{
  "anonymousChzzkLogin": "signedOut",
  "embeddedLoginChecks": {
    "chzzk:video:14782779": { "loggedIn": false, "reason": "signed-out" },
    "chzzk:video:14920476": { "loggedIn": false, "reason": "signed-out" }
  },
  "passed": true
}
```

`ViewerScenario.runVideoScenario()`는 별도의 nonPersistent WKWebView에서 signedOut을 기대한다.
iframe 검사도 loggedIn이 boolean인지만 요구해 false로 통과한다. 이 시나리오는 공개 VOD와
로그인 상태 조회 API 회귀 검사다. 실제 로그인 수용 검사가 아니다.
JS 프로브 쿠키 전달, mock의 loggedIn=true, persistent store 설정, SPI 호출 성공도 실제 인증을 증명하지 않는다.

## 5. 코드 흐름과 정확한 파일

아래 경로는 모두 프로젝트 폴더 기준이다. 파일명 추측 대신 심볼로 검색한다.

| 경로·심볼 | 현재 동작 / 진단 포인트 |
|---|---|
| `ios/Sources/App/LoginScreen.swift` | 계정 화면, 목적지 선택, 다시 확인, 완료 시 synchronizeCookies. Coordinator의 탐색·팝업·상태 확인 수명 |
| `ios/Sources/Core/LoginWebViewFactory.swift` | 네이버 로그인 후 chzzk 홈으로 돌아오는 URL, top-level page fetch로 상태 확인. host가 chzzk가 아니면 waiting |
| `ios/Sources/Core/ViewerConfiguration.swift` | viewerOrigin과 chzzkUserStatusURL. 현재 viewer는 `https://stream-multiview.invalid` |
| `ios/Sources/Core/WebSessionCookies.swift` | SharedWebSession은 이 파일에 정의. default store 공유. synchronizeCookies는 allCookies 대기만 수행 |
| `ios/Sources/Core/ViewerWebViewController.swift` | viewer와 login이 쓰는 makeConfiguration, 사용자 스크립트, 로그인 후 기존 iframe만 재로드 |
| `ios/Sources/Core/WebAssets.swift` | chzzk 하위 프레임에 origin·statusURL·managed flag와 session-access-frame.js 주입. 로그인 웹뷰에는 이 스크립트가 없음 |
| `ios/Resources/ios-web/session-access-frame.js` | 직접 자식 live/video 프레임만 대상. 상태 조회, 실제 클릭에서 requestStorageAccess, true 확인 후 해당 프레임 reload |
| `ios/Sources/Core/WebKitPrivateSettings.swift` | `_setResourceLoadStatisticsEnabled:false` 호출 여부. 이를 쿠키 송신 성공으로 해석하지 말 것 |
| `ios/Sources/Core/NativeBridge.swift` | 신뢰된 viewer 메인 프레임만 사용. URLSession fetch는 명시적 credentials:include일 때 제한된 쿠키 선택 |
| `ios/Resources/ios-web/chrome-shim.js` | viewer 문서의 fetch를 native로 연결. 방송 사이트 내부의 모든 fetch를 대체하는 코드가 아님 |
| `ios/Sources/App/ViewerScreen.swift` | 로그인 화면 닫힘 → reloadCount → refreshStreamsAfterLogin |
| `ios/Sources/Core/ViewerScenario.swift` | 익명 검사와 공개 재생 회귀. 실제 인증 수용 검사를 별도로 추가해야 함 |

현재 인증 경로:

```text
앱 계정 화면 WKWebView
  → nid.naver.com 로그인
  → 같은 웹뷰의 chzzk.naver.com
  → 그 페이지의 credentials:include 상태 조회
  → 완료 / SharedWebSession / viewer의 기존 iframe reload
  → chzzk iframe의 상태 조회
  → 필요한 경우 실제 사용자 클릭으로 Storage Access 요청
  → 상태 true 확인 / 그 iframe reload / 실제 콘텐츠 접근 확인
```

로그인 상태 조회는 CHZZK 페이지에서 comm-api로 직접 요청한다. nativeFetchHosts에 comm-api가
없다는 이유만으로 버그라고 판단하거나 허용 목록을 넓히지 않는다. native의 기존 api.chzzk 메타데이터
요청은 credentials:omit이며, 이것이 iframe 로그인 실패의 확정 원인이라는 증거도 없다.

## 6. Claude Code 작업 순서

### 1단계: 실패 지점과 진단 수단 확보

- 작업 트리와 위 기준 파일을 확인하고 사용자 확인표에서 비어 있는 핵심 정보만 묻는다.
- 현재 앱에서 빌드 식별이 어려우면 계정/진단 화면에 버전·빌드를 표시해 설치 후보를 구분한다.
- 상태를 인증 탐색, 최상위 치지직 상태, iframe 상태, Storage Access 결과, 재로드 후 상태로
  나눠 기록한다. HTTP 실패·JSON/schema 실패·명시적 signedOut을 한 문구로 뭉개지 않는다.
- 진단 항목은 시각, 단계, main/subframe, host/path(쿼리 제외), HTTP 상태, API code,
  loggedIn true/false/unknown, DOMException 이름, store 일치 여부 정도로 제한한다.
- 쿠키는 필요 시 WKHTTPCookieStore에서 이름·domain·path·Secure·HttpOnly·SameSite·유효 여부
  등 속성만 비교한다. 값, Cookie/Set-Cookie 헤더, Authorization, 응답 전체, 계정 식별자,
  전체 URL query, 민감한 Web Inspector/HAR 덤프를 문서나 채팅에 남기지 않는다.

### 2단계: 처음 깨지는 경계를 증거로 좁히기

| 관찰 | 다음 조사 | 결론 내리면 안 되는 것 |
|---|---|---|
| 네이버 인증 자체가 실패하거나 되돌아옴 | navigation redirect, popup 처리, 실제 오류, UA/요청 조건, 같은 기기의 비교 결과 | iframe 쿠키 문제로 즉시 단정 |
| 사이트 UI는 로그인인데 앱 표시만 실패 | 같은 웹뷰에서 현재 endpoint·HTTP·schema·쿠키 송신·상태 검사 타이밍 대조 | 에러 문구만 성공으로 바꾸기 |
| top-level true, iframe false | 두 웹뷰의 store, 요청 쿠키 존재 여부, top/frame origin, 실제 Storage Access 결과와 재로드 전후 | allCookies 대기 또는 SPI 반환만으로 동기화 완료 선언 |
| SAA 실패/미지원 | 사용자 실제 터치에서 호출됐는지, 예외 이름, 브라우저 동작·OS 조건을 확인 | native evaluateJavaScript 또는 자동 click 성공을 실제 터치 수용으로 대체 |
| iframe true인데 콘텐츠 접근 불가 | 같은 계정의 해당 콘텐츠 권한, 실제 플레이어 요청·응답, 캐시/재로드 | 로그인 bool을 성인 인증·멤버십 권한과 동일시 |
| 재시작 후에만 실패 | persistent store 사용과 재시작 전후 세션/요청 상태 | 앱 실행 중 쿠키 열람을 디스크 저장 증거로 간주 |

이 표는 조사 분기이며 원인 확정 목록이 아니다. `.invalid` 부모 origin, WebKit 추적 방지,
HttpOnly/SameSite, UA, 팝업, 응답 형식·타이밍은 관찰에 맞는 항목부터 검증한다.
사이트/WebKit의 현재 제약을 인용해야 할 때는 공식 자료와 재현 결과를 함께 확인한다.

### 3단계: 최소 수정과 실기기 재검증

- 재현된 경계에 필요한 최소 수정을 한다. 네트워크 오류를 성공으로 숨기거나 임의 지연/무한 재시도로 덮지 않는다.
- 기존 native bridge의 viewer 메인 프레임 제한, 호스트/redirect 검사, 쿠키 범위, 응답 크기 제한을 유지한다.
- `_setShouldRelaxThirdPartyCookieBlocking:`은 기존 실험에서 예외를 일으켰으므로 그대로 다시 추가하지 않는다.
  `_setResourceLoadStatisticsEnabled:`가 적용된 사실과 실제 로그인 세션이 전달된 사실을 구분한다.
- 쿠키 추출·속성 재작성·Safari 쿠키 복사로 정상 인증을 대체하지 않는다. 정상 웹뷰 구조로도
  요구사항을 충족할 수 없다는 재현 근거가 생기면 구조 변경의 범위와 검증 계획을 사용자와 정한다.
- 수정 버전은 0.1.2(3)과 구분되도록 버전/빌드를 올리고 새 IPA로 전달한다. 이름이 같은 파일을
  선택했다는 사실만으로 업데이트 완료라 하지 말고 실제 앱의 표시 버전을 확인한다.

## 7. 완료 조건

다음 조건을 실제 iPad의 동일 설치 빌드에서 확인해야 로그인 해결로 보고한다.

- 사용자가 앱 내부에서 정상 로그인하고, 실제 치지직 사이트와 앱의 상태 판정이 일치한다.
- 방송 iframe에서도 loggedIn=true가 확인되며, 본인에게 권한 있는 로그인 필요 콘텐츠가 재생된다.
- 두 타일에서 로그인 상태가 적용되고 새로고침·다른 영상 선택·앱 재시작 후 유지된다.
- 실패 응답은 signedOut과 확인 불가를 구분하며, 이미 로그인된 계정을 계속 재로그인시키지 않는다.
- 공개 영상 두 개 동시 재생·독립 소리·전체화면 첫 터치/자동 숨김·수동 pause 보존에 회귀가 없다.

계정 입력 또는 사용자 확인을 기다려야 하면 코드/자동 검사 결과까지 마무리하고, 남은 정확한
단계·후보 버전·확인 방법을 전달한다. 계정이나 콘텐츠를 사용할 수 없으면 해당 조건은 미검증이다.

## 8. 개발 도구 명령과 검사 범위

프로젝트 폴더에서 실행한다. 아래 명령은 다음 작업자를 위한 것이며 문서 작성 차례에 재실행하지 않았다.

```sh
git status --short
npm run check
npm run check:ios-session
npm run check:chzzk-vod
npm run check:ios-fullscreen
ios/harness/run.sh --keep-data --videos 14920476,14782779 --app-fullscreen --timeout 90
git diff --check
```

이 VOD 명령은 실제 계정 인증 검사가 아니다. 두 영상은 이전 공개 재생 fixture이며 작업 당시 가용성을 확인한다.
`run.sh`에서 `--keep-data`를 빼면 하네스 프로필을 지운다. 실제 로그인 증거 보존 중에는 빼지 않는다.
실제 로그인 진단에 기존 PageLog의 일반 콘솔 수집을 그대로 사용하지 말고 위 진단 항목만 남긴다.

수정 경로에 따른 추가 검사:

```sh
ios/harness/check-native-fetch.sh       # native fetch/쿠키 정책을 바꾼 경우
ios/harness/check-playback.sh           # 재생 증거 판정을 바꾼 경우
python3 ios/harness/check-ipa-build.py   # IPA 빌드 스크립트를 바꾼 경우
```

XcodeGen 설정을 바꿨으면 ios 폴더에서 `xcodegen generate`를 실행한다.
시뮬레이터 빌드 예시(이후 설치/실행과 실기기 확인 방법은 `ios/README.md` 참고):

```sh
xcodebuild -project ios/StreamMultiview.xcodeproj -scheme StreamMultiview \
  -configuration Debug -sdk iphonesimulator -derivedDataPath /tmp/sv-login-debug \
  CODE_SIGNING_ALLOWED=NO build
ios/build-ipa.sh
```

시뮬레이터 UDID·앱 container 경로는 이전 값을 재사용하지 말고 현재 환경에서 조회한다.
실제 기기 업데이트는 Mac에서 Finder Computer Use로 기존 iCloud 위치에 복사한 뒤 사용자가
SideStore My Apps → +로 설치한다. 추가 계정 조작이 필요하지 않은 경우 설치 준비를 다시 시키지 않는다.

## 9. 결과물과 최종 보고 형식

`HANDOFF.md`에 새 절을 추가하고 최신 요약을 갱신한다. 과거 0.1.2 리포트는 보존한다.
새 진단/검증 파일에는 버전·기기·시각·검사 범위·익명/실계정 구분·실패/미확인 항목을 넣는다.
IPA ZIP, Info.plist 버전·빌드, 웹 자산 동일성, 파일 크기·SHA256, 실제 전달/설치 확인을 별도로 기록한다.

최종 보고는 다음 순서로 짧게 작성한다:

1. 재현된 실패 지점과 근거. 미확정 가설은 별도 표시.
2. 바꾼 코드와 그 변경이 해당 실패를 고치는 이유.
3. 자동 검사 결과와 실제 iPad 계정/방송 검사 결과를 분리.
4. 새 설치 버전·전달 위치·사용자가 남겨야 할 확인 1~2개.
5. 완료/실기기 검증 대기/미해결 중 정확한 상태.

공개 재생, 익명 상태 조회, 빌드 성공만으로 “로그인 해결”이라 쓰지 않는다.
