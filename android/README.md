# Stream Multiview for Android (Galaxy Z Fold8, Samsung DeX)

크롬 확장 뷰어를 안드로이드 WebView 하나로 감싼 개인용 앱. 구조는 iPad 래퍼(`ios/`)와
같은 웹 자산을 쓰고, 플랫폼 계층만 Kotlin으로 옮겼다.

## 구성

| 경로 | 역할 |
|---|---|
| `app/build.gradle.kts` | 빌드 정의. 레포 루트의 `viewer.*`, `background.js`, `src/`, `content/`와 `ios/Resources/ios-web/`를 `assets/web/`로 스테이징 |
| `WrapperConfig.kt` | 뷰어 오리진(`https://chzzk.naver.com/__stellaview/`), 데스크톱 UA와 클라이언트 힌트, 허용 호스트 |
| `WebAssets.kt` | viewer.html 합성(터치 보정 CSS, 풀스크린 부트스트랩, chrome 대체 모듈 삽입), 프레임 주입 스크립트 |
| `ViewerWebViewController.kt` | WebView 설정, `/__stellaview/` 요청을 assets로 응답, `addDocumentStartJavaScript`로 치지직/유튜브 프레임에 스크립트 주입, `addWebMessageListener` 브리지, HTML5 전체화면, 새 창 처리 |
| `NativeBridge.kt` | chrome.storage(SharedPreferences), 허용 호스트 fetch(HttpURLConnection, 리다이렉트마다 검사), 외부 링크, 로그인 화면 열기 |
| `MainActivity.kt` | 전체화면 뷰어, 화면 꺼짐 방지, 시스템 바 숨김, 렌더 프로세스 종료 시 재생성, 로그인 후 프레임 갱신 |
| `LoginActivity.kt` | 앱 안 네이버/구글 로그인(같은 쿠키 저장소), 로그인 상태 확인, 진단 복사 |
| `harness/` | 에뮬레이터의 WebView를 Chrome DevTools Protocol로 구동하는 검증 시나리오(Node) |
| `build-apk.sh` | 서명된 릴리스 APK 빌드와 iCloud Drive 복사 |
| `keystore/` | 릴리스 서명 키(git 제외, iCloud 동기화). 잃어버리면 같은 앱 위에 업데이트 설치 불가 |

## iOS 래퍼와 다른 점

- 뷰어를 문자열로 합성하지 않는다. `shouldInterceptRequest`가 `https://chzzk.naver.com/__stellaview/` 아래
  요청을 assets에서 응답하므로 모듈 상대 경로가 그대로 동작한다. 문서 오리진은 chzzk.naver.com이라
  네이버 로그인 쿠키(SameSite=Lax)가 방송 iframe에 그대로 흐르고, 유튜브 embed의 Referer도 나간다.
- 프레임 스크립트 주입은 `WebViewCompat.addDocumentStartJavaScript`(오리진 규칙별, 모든 프레임, 페이지 월드).
  뷰어 문서도 같은 오리진이라 스크립트는 `window.self !== window.top`으로 자기 자신을 건너뛴다.
- 브리지는 `WebViewCompat.addWebMessageListener`. 요청 `{id, op, ...}`에 응답 `{id, result|error}`.
  `chrome-shim.js`가 iOS(WKScriptMessageHandler)와 안드로이드 전송을 모두 지원한다.
- 쿠키 저장소(`CookieManager`)는 앱 전체 공유라 로그인 WebView와 뷰어 WebView가 같은 세션을 쓴다.
  유튜브 프레임의 구글 쿠키는 `setAcceptThirdPartyCookies(true)`로 허용한다. 세션 쿠키도 재실행 후 유지된다.
- 영상 볼륨(`video.volume`)은 Chromium이 그대로 지원하므로 볼륨 패널이 iOS의 우회 없이 동작한다.
- UA는 설치된 WebView의 Chromium 버전을 딴 데스크톱 Chrome 문자열이고, 클라이언트 힌트(Sec-CH-UA-Mobile 등)도
  데스크톱으로 맞춘다. 치지직이 m.chzzk로 보내지 않고, 구글 로그인 차단 확률을 줄인다.
- 전체화면은 `WebChromeClient.onShowCustomView`로 네이티브 처리(iOS의 CSS 어댑터는 끔).
- DeX와 폴드: `resizeableActivity`, 넓은 `configChanges`, 삼성 keepalive 메타데이터로 접기/펴기와 창 크기
  변경에도 WebView를 다시 만들지 않는다. 마우스 호버가 있는 DeX에서는 타일 컨트롤이 호버로, 터치에서는
  항상 보인다(`(hover: none)` 규칙).

## 빌드와 설치

이 맥에는 Android Studio 2026.1(JBR 21), SDK 35/36, Gradle 8.7 캐시가 있다. 명령줄만으로 빌드된다.

```
android/build-apk.sh                 # 릴리스 APK → iCloud Drive/Stream Multiview/StreamMultiview.apk
cd android && ./gradlew :app:assembleDebug   # 디버그 APK (JAVA_HOME은 Android Studio의 jbr)
```

갤럭시 설치: iCloud Drive(파일 앱)나 Google Drive로 APK를 옮겨 열고 "출처를 알 수 없는 앱" 허용, 또는
USB 디버깅을 켜고 `adb install -r StreamMultiview.apk`. 같은 키로 서명한 APK는 위에 덮어써 업데이트된다.
2026-09-30부터 시작되는 안드로이드 개발자 인증 요건은 스토어 설치에 적용되고 adb 설치는 예외다.

## 검증(에뮬레이터)

```
~/Library/Android/sdk/emulator/emulator -avd fold8 -gpu auto &
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.siturasu.streammultiview/.MainActivity
android/harness/run.sh --channel https://chzzk.naver.com/video/14920476
```

시나리오는 iOS의 `ViewerScenario`와 같은 항목(뷰어 렌더링, 상태 조회, 프레임 주입, 쿠키 전달, 재생 진행,
음소거 해제, 볼륨 패널, 유튜브, 로그인 후 갱신)에 창 크기 변경 내성(DeX 대용)을 더했다.

## 구글 로그인 차단에 대해

구글은 임베디드 WebView의 로그인을 거부한다("브라우저 또는 앱이 안전하지 않을 수 있습니다").
0.1.1은 WebView가 드러내는 신호를 데스크톱 Chrome과 같게 맞춘다. UA 문자열, 클라이언트 힌트
브랜드(기본값에는 "Android WebView"가 들어 있다)와 Sec-CH-UA-Mobile, navigator.userAgentData의
고엔트로피 값, 그리고 로그인 화면의 구글 오리진에만 넣는 문서 시작 스크립트(window.chrome 객체,
navigator.platform "Linux x86_64", 터치 포인트 0, ontouchstart와 orientation 제거). X-Requested-With
헤더는 허용 목록을 비워 끄지만, 에뮬레이터의 WebView 124는 그 설정을 무시하고 계속 보냈고 구글도
계속 거부했다(실기기의 최신 WebView는 이 헤더를 기본으로 보내지 않는다). 실기기에서도 거부되면
안드로이드에서는 유튜브 로그인을 지원하지 않는 것으로 두고 공개 영상만 본다. 치지직 로그인은 이와 무관하다.

## 화면 크기와 카메라 구멍

시스템 바를 숨기고 가장자리까지 그리되, `CutoutPadding`이 디스플레이 컷아웃(커버 화면 펀치홀)
인셋만큼 루트 뷰에 패딩을 줘서 상단 바와 타일 컨트롤이 구멍 아래에 놓이지 않는다. 좁은 화면
(720px 이하)에서는 뷰어가 compact 모드(`body.sv-compact`)로 전환된다. 자세한 규칙은 viewer.css.

## 실기기에서만 확인할 수 있는 것

- 구글 로그인이 WebView를 거부하는지(데스크톱 UA와 힌트로 통과를 기대).
- 폴드8 실제 디코더 한계(2~4개 1080p), 발열, DeX 창 크기 변경 시 레이아웃.
- 백그라운드 재생: 앱을 뒤로 보내면 잠시 뒤 시스템이 프로세스를 얼릴 수 있다.
