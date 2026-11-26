# Stream Multiview

개인용 영상 멀티뷰 확장 프로그램.

## 크롬 확장 기능

버전 0.1.10. 지원 주소 형식은 `chzzk.naver.com/live/채널ID`, `chzzk.naver.com/video/숫자ID`, 유튜브 주소, `ci.me/@slug`.

- 스텔라이브 4기 ABYSS(하나요 히요리, 토키노 메리, 코가네 랑, 시즈키 토아)가 멤버 목록에 있다.
- 씨미(ci.me) 채널을 타일로 추가할 수 있다. 함께 보기에 헤비(씨미)가 있다. 확장에서는 ci.me 페이지를 프레임으로 넣고,
  iPad와 안드로이드 래퍼에서는 방송 주소를 직접 재생한다(채팅은 래퍼에서 못 연다, 원본 버튼으로 연다). 성인, 로그인 전용 방송은 지원하지 않는다.
- 전체화면에서는 원래처럼 상단 바, 사이드바, 채팅이 모두 숨는다. 전체화면에 들어가면 볼륨 패널도 닫힌다.
  타일 컨트롤은 마우스를 움직이면 나타나고 1.8초 뒤 다시 숨는다.
- 상단 바의 "볼륨" 버튼이 타일별 볼륨 패널을 연다. 타일마다 0~100 슬라이더와 소리 켬/끔이 있고,
  "모두 음소거"와 "모두 100%"가 있다.
- 슬라이더를 한 번도 움직이지 않은 타일은 플레이어 자체 볼륨(사이트에 저장된 값)을 그대로 쓰고, 패널에는
  "기본 30%"처럼 그 값이 표시된다. 슬라이더를 움직이면 그 타일부터 패널 값이 적용되고, "모두 100%"는 모든 타일을 100%로 맞춘다.
  패널 값이 적용된 타일은 플레이어 안에서 볼륨을 바꿔도 패널 값으로 돌아간다.
  패널 값은 방송별로 저장되어 타일을 뺐다 다시 넣거나 다음에 실행해도 유지된다.
- 타일 여러 개의 소리를 동시에 켤 수 있다. 다른 타일을 켜도 먼저 켠 타일은 꺼지지 않는다.
- 치지직 `/video/숫자ID` 다시보기 주소를 타일로 추가할 수 있다. 다시보기에는 실시간 채팅이 없다.
- 휴대폰용 간소 배치(전체 폭 채팅, ⋯ 더보기 메뉴)는 너비 720px 이하의 터치 전용 기기에서만 켜진다.
  데스크톱 크롬 창을 좁히면 원래 배치를 쓰고, 760px 이하에서는 사이드바와 채팅이 영상 위에 겹쳐 열린다.
- 터치 전용 기기에서는 타일 컨트롤이 항상 보인다.

## 검증

```
npm run check              # 모든 스크립트 문법 검사
npm run check:volume-panel # 볼륨 패널 상태와 명령, 저장
npm run check:chzzk-vod    # 치지직 다시보기 주소와 독립 소리
npm run check:cime         # 씨미 주소 파싱, 멤버, 매니페스트와 DNR 규칙, 플레이어 소스 단언
npm run check:volume-frame # 프레임의 set-volume 처리와 오리진 정책
npm run check:ios-fullscreen
npm run check:ios-session
npm run check:chrome       # 실제 Chrome for Testing에 확장을 올려 CDP로 검증
```

`npm run check:chrome`의 설치 방법은 `harness/chrome/README.md`.

씨미 실방송 재생은 맥 WebKit 하네스로 본다: `ios/harness/run.sh --cime <라이브 slug> --timeout 60`. 자세한 옵션은 `ios/README.md`.

## iPad

`ios/`에 같은 뷰어를 감싼 iPadOS 앱(WKWebView)이 있다. 설치와 구조는 `ios/README.md`.

## Android

`android/`에 같은 뷰어를 감싼 안드로이드 앱(WebView, 갤럭시 Z 폴드8과 삼성 DeX 대상)이 있다. 빌드와 구조는 `android/README.md`.
