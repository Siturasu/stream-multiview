# Chrome 확장 회귀 검증 하네스

실제 Chrome을 띄워서 확장을 직접 로드하고, viewer.html을 실제 입력으로 조작해 확인한다.
치지직 다시보기와 YouTube 영상을 실제로 재생시키고 손대지 않은 타일의 자체 볼륨 유지,
볼륨, 동시 음성, 재접속 복원, 전체 화면, 터치 모드, 좁은 데스크톱 창 배치까지 검사한다.
프레임 안의 값은 전부 해당 iframe 안에서 직접 읽으며, 확장 쪽 코드는 어떤 것도 완화하거나
가짜 메시지로 대체하지 않는다.

## 실행

```
node harness/chrome/check-extension.mjs
```

JSON 리포트를 stdout으로 출력하고 `harness/chrome/report-latest.json`에도 쓴다.
진행 로그는 stderr에 `[harness]` 접두어로 나간다. 실패가 하나라도 있으면 종료 코드 1.

Chrome for Testing이 없으면 한 번만 설치한다.

```
harness/chrome/install-chrome.sh
```

`~/.cache/stream-multiview/browsers`에 Stable 빌드를 내려받고 실행 파일 경로를 출력한다.
npm이나 npx는 쓰지 않는다.

## 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--chrome <path>` | 자동 탐색 | Chrome 실행 파일. 환경변수 `SV_CHROME`도 같은 역할 |
| `--video <id>` | 14920476 | 치지직 다시보기 ID. 기본값이 준비되지 않으면 14782779로 한 번 재시도 |
| `--youtube <id\|none>` | dQw4w9WgXcQ | YouTube 영상 ID. `none`이면 youtube-player-ready, youtube-volume, youtube-capability, youtube-model-sync를 건너뛰고 untouched-volume-left-alone의 YouTube 부분을 뺀다 |
| `--timeout <초>` | 90 | 치지직 플레이어 준비 대기 시간 |
| `--keep` | 꺼짐 | 끝난 뒤 Chrome을 그대로 남긴다 |
| `--port <n>` | 빈 포트 | 원격 디버깅 포트 고정 |

Chrome 탐색 순서는 `--chrome`, `SV_CHROME`,
`~/.cache/stream-multiview/browsers/*/Google Chrome for Testing.app/...` 순이다.

## 검사 항목

| 이름 | 확인하는 것 |
|---|---|
| viewer-loads | viewer.html이 열리고 `#volume-toggle`, `#volume-panel`이 있으며 패널은 닫혀 있다 |
| add-streams | 치지직 다시보기와 YouTube URL을 입력 폼으로 추가하면 타일 2개가 생기고 embed URL에 `sv=1`, `enablejsapi=1`이 붙는다 |
| chzzk-player-ready | 치지직 iframe에 `sv-embedded`와 video가 있고 화질 배지가 "대기 중"에서 바뀐다 |
| youtube-player-ready | YouTube iframe의 video가 소스를 얻거나 readyState 1 이상이 된다 |
| untouched-volume-left-alone | 슬라이더를 움직이기 전에는 프레임이 volume-capability를 보내지 않는다. 치지직 프레임 안에서 본편 video의 volume을 0.5로 바꾸거나 muted를 뒤집어도 1초 뒤 그대로이고, YouTube 프레임에서 `setVolume(10)`을 해도 1초 뒤 `getVolume()`이 10, video가 0.5 미만으로 남는다. 끝나면 1과 100, 원래 muted로 되돌린다. 광고 중이면 그 부분은 inconclusive |
| volume-panel-open | 볼륨 버튼을 실제로 눌러 패널이 열리고 타일 수만큼 `.volume-row`가 생기며, 아직 아무것도 움직이지 않았으므로 모든 `.volume-value`가 "기본" 또는 프레임이 알려 준 "기본 NN%"다 |
| chzzk-volume | 슬라이더를 30으로 내리면 치지직 프레임의 video가 0.3이 되고 volume-capability가 도착한다 |
| youtube-volume | 슬라이더를 40으로 내리면 YouTube 프레임의 video가 0.4가 된다 |
| youtube-capability | YouTube 프레임이 `stellaview-youtube` 소스로 volume-capability를 보낸다 (content/youtube-volume-frame.js 필요) |
| multi-audio | 두 타일을 동시에 소리 켜고, 치지직만 다시 끄면 YouTube는 그대로 들리고, 모두 음소거로 둘 다 조용해진다 |
| persistence | 새로고침 뒤 슬라이더가 30과 40으로 돌아오고 추가 입력 없이 프레임 볼륨도 0.3과 0.4로 복원된다 |
| vod-activity-relay | 다시보기 타일 위에서 마우스를 움직이면 치지직 프레임이 viewer-activity를 올려보낸다 (manifest의 `/video/*` 매치 필요) |
| fullscreen-hides-chrome | 볼륨 패널을 연 채 `#fullscreen`을 실제로 누르면 상단 바, 사이드바, 채팅, 볼륨 패널이 모두 `display: none`이 되고 `volume-panel-open`이 빠진다. 그리드는 (0, 0, innerWidth, innerHeight)를 채우고 `is-top-row` 타일이 없으며 포커스가 상단 바에 남지 않는다. 타일 위에 포인터를 두고 viewer에 들어오는 활동 신호가 2.6초 끊기면 `fullscreen-controls-hidden`이 붙고 `.tile-header`가 opacity 0이 되며, 마우스 한 번에 0.7초 안에 풀리고 가리킨 타일의 헤더가 opacity 1로 돌아온다. Esc로 나오면 `fullscreen-view`, `fullscreen-controls-hidden`, `is-top-row`가 모두 없다 |
| fullscreen-space-keeps-fullscreen | 전체 화면에 들어간 직후 Space를 눌러도 0.5초 뒤 여전히 전체 화면이다 |
| touch-controls | hover가 없는 환경에서 `.tile-header`가 계속 보이고, hover가 돌아오면 다시 숨는다. 그 터치 환경에서 폭을 700으로 줄이면 `sv-compact`와 `#sv-overflow-toggle`이 나타나고, 폭과 hover를 되돌리면 `sv-compact`가 빠진다 |
| youtube-model-sync | 슬라이더 40이 `#movie_player.getVolume()`에도 반영되고, 프레임 안에서 `setVolume(10)`을 해도 video가 0.4, 모델이 40으로 되돌아온다 |
| desktop-narrow-layout | 마우스 환경에서 폭 700과 740일 때 `sv-compact`가 없고 `#sv-overflow-toggle`은 숨는다. 사이드바와 채팅은 원래의 760px 이하 오버레이(`position: fixed`, 채팅은 오른쪽에 붙은 폭)로 뜨고, `.drag-handle`이 보이며 `#quality-select`는 상단 바에 남는다. 1400으로 되돌리면 사이드바가 다시 fixed가 아니다 |

각 항목은 pass, fail, inconclusive 중 하나로 기록된다. inconclusive는 환경이 그 조건을
만들어 주지 못한 경우이며 종료 코드에는 영향을 주지 않는다.

## 알아둘 점

- Space 입력(`Input.dispatchKeyEvent`)에는 `nativeVirtualKeyCode`를 넣지 않는다. 이 맥의 Chrome for Testing은
  네이티브 코드(32든 macOS kVK_Space 49든)를 받으면 뷰어 body에 신뢰된 keydown을 초당 2천 번 넘게 계속 만들어
  전체 화면 자동 숨김 타이머가 영원히 초기화된다. CDP에서만 생기는 현상이고, 코드 없이도 Blink에는
  keydown과 keypress가 전달된다. Escape는 브라우저가 전체 화면을 풀어야 하므로 네이티브 코드 27을 그대로 둔다.


- 브랜드 Chrome 137 이상은 `--load-extension`을 무시한다. 그래서 Chrome for Testing을
  `--enable-unsafe-extension-debugging`으로 띄우고 CDP의 `Extensions.loadUnpacked`로
  확장을 올린다. 확장 ID는 fddklecfkdohmpdhhbhaglepeeiegpbc로 고정된다.
- chzzk.naver.com과 www.youtube.com iframe은 별도 프로세스라 각자 세션을 갖는다.
  타일의 iframe 엘리먼트에서 frameId를 얻어 그 세션을 찾으므로, 같은 URL을 가진 죽은
  문서를 잘못 잡는 일이 없다.
- 클릭은 `Input.dispatchMouseEvent`의 실제 누름과 뗌으로 보낸다. 합성 `click()`에는
  사용자 제스처가 없어서 전체 화면 요청이 거부된다.
- Chrome 153의 `Emulation.setEmulatedMedia`는 hover 미디어 특성을 무시한다. 그래서
  touch-controls는 먼저 그 방법을 시도하고, 먹히지 않으면
  `Emulation.setTouchEmulationEnabled`로 `(hover: none)`을 만든다. 둘 다 안 되면
  inconclusive로 남긴다.
- 새로고침 직후에도 이전 문서가 잠깐 살아 있어서, 검사 전에 표식을 찍고 그 표식이
  사라진 문서에서만 값을 읽는다.
- 헤드리스에서 전체 화면 진입이 거부되면 fullscreen-hides-chrome과
  fullscreen-space-keeps-fullscreen은 inconclusive가 되고 touch-controls도 측정값만 남긴 채
  inconclusive로 처리한다.
- Space가 전체 화면을 빠져나오면 fullscreen-space-keeps-fullscreen은 fail이고,
  fullscreen-hides-chrome은 `#fullscreen`을 실제 클릭해 다시 들어가 자동 숨김을 잰다.
  재진입이 안 되면 자동 숨김은 재지 않는다.
- 전체 화면의 타일은 별도 프로세스 iframe이라 viewer 문서는 그 위의 포인터 이동을 프레임의
  viewer-activity로만 듣는다. 헤드리스에서 타일의 `:hover`가 잡히지 않으면 가리킨 타일 헤더의
  opacity 대신 `fullscreen-controls-hidden`이 풀리는 것만 보고, 그 사실을 notes에 남긴다.
- 포인터가 멈춘 뒤에도 플레이어가 늦게 활동 신호를 한 번 더 올릴 수 있다. 그래서 자동 숨김의
  2.6초는 포인터를 둔 시점이 아니라 마지막 신호가 들어온 시점부터 센다. 8초 안에 신호가
  끊이지 않으면 fail이고, notes의 `idleTiming.pingKinds`에 어떤 신호였는지 남는다.
- Blink는 마지막으로 처리한 마우스 이동을 기준으로 `:hover`를 다시 계산하는데 그
  계산이 늦다. 이동 한 번만 보내면 1.8초 뒤 타이머가 돌 때까지 이전 요소가 hover로
  남거나 반대로 hover가 잠깐 비어서, 컨트롤이 안 숨거나 반대로 숨어 버린다. 그래서
  `mouseMove`는 1px 앞 지점을 먼저 찍고 목표 지점으로 한 번 더 보낸다.
- 화면 크기는 1400x900이 기본이다. touch-controls와 desktop-narrow-layout만
  `Emulation.setDeviceMetricsOverride`로 폭을 700, 740으로 줄였다가 1400x900으로 되돌린다.
- Chrome은 화면에 떠 있는 fixed 상자의 `left: auto`를 실제 px 값으로 돌려주고, "auto"는
  `display: none`일 때만 나온다. 그래서 desktop-narrow-layout은 채팅이 숨어 있으면
  `#chat-toggle`로 먼저 띄우고, 전체 폭 오버레이가 아닌지는 상자 왼쪽 끝이 0보다 크고
  폭이 화면보다 좁은지로 본다. 띄운 채팅은 끝나고 다시 닫는다.
- untouched-volume-left-alone은 슬라이더를 움직이기 전이어야 하므로 볼륨 패널을 열기 전에
  돈다. 광고가 10초 넘게 이어지면 해당 부분만 inconclusive로 남긴다.
- 임시 프로필은 매번 새로 만들고 종료할 때 지운다. 사용자의 실제 Chrome 프로필은
  건드리지 않는다.
- 치지직 다시보기는 광고가 먼저 붙을 수 있는데, 이것도 플레이어가 준비된 것으로 본다.

## 배치 계측 도구

`node harness/chrome/layout-probe.mjs [--root <확장 폴더>] [--out <폴더>] [--channels <id,id>] [--size WxH]`는
검사가 아니라 A/B 계측 도구다. 같은 라이브 채널로 두 트리(예: `git worktree add /tmp/sv-head HEAD`)를 차례로
열어 타일, iframe, 플레이어 루트, video 사각형과 object-fit을 상태별로 기록하고 스크린샷을 남긴다.
출력은 `harness/chrome/shots/`(git 제외)에 쌓이므로 비교가 끝나면 지운다.
