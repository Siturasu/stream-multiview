# Android verification harness

Drives the running Android app's WebView over the Chrome DevTools Protocol and
mirrors `ios/Sources/Core/ViewerScenario.swift` (same selectors, same probes,
same pass/fail rules). Prints a JSON report on stdout, also writes
`report-latest.json`, and exits 0 (passed) or 1 (any failure).

## Run

The app must already be installed and running on a connected device/emulator.

```sh
android/harness/run.sh --channel https://chzzk.naver.com/video/14920476
android/harness/run.sh                       # first LIVE member, else first OFF
android/harness/run.sh --youtube none --timeout 120
```

`run.sh` finds the app's pid, forwards `tcp:9222` to
`localabstract:webview_devtools_remote_<pid>`, runs the scenario and passes the
exit code through. Override `ADB`, `SV_PACKAGE` or `SV_PORT` in the environment.

Scenario flags: `--channel <url|id>`, `--youtube <id|url|none>` (default
`dQw4w9WgXcQ`), `--timeout <seconds>` (default 60, applies to every wait),
`--port`, `--adb`.

## What it checks

Viewer render and member statuses (native fetch bridge) · UA and
`stellaViewNative` · probe cookies seeded with `Network.setCookie` · adding a
CHZZK stream through `#viewer-add-form` and the tile's player-ready handshake ·
inside the chzzk iframe: desktop host (no m.chzzk redirect), `sv-embedded`,
`#sv-embed-style`, `data-sv-activity-relay` (live frames only), quality
method/status/label, both probe cookies visible, same-source playback progress
ignoring the `/service/t/` ad endpoint, unmute through the tile's audio button ·
volume panel driving the frame's `HTMLMediaElement.volume` · YouTube tile:
no `.ytp-error`, playback progress, third-party cookie, volume slider ·
`REFRESH_AFTER_LOGIN_JS` (copied verbatim from `ViewerWebViewController.kt`)
preserving the tiles and their keys · `wm size 1400x900` / `reset` not
recreating the document (`window.__svRunMarker`) · a final screenshot.

## Notes

- No npm dependencies. Node 24's global `WebSocket` is used; if a WebView build
  rejects that handshake, `npm i ws` inside this directory and the script falls
  back to it automatically.
- Execution contexts are tracked per frame from `Runtime.executionContextCreated`
  so probes run inside the chzzk and YouTube iframes. `Target.setAutoAttach`
  with `flatten` handles out-of-process iframes; auto-attached workers are
  ignored (they have no `Page` domain).
- CDP requires an explicit `sameSite`, so the iOS "no attribute" probe cookie is
  seeded as `None` + `Secure` alongside the `Lax` one.
- The screenshot display id comes from `dumpsys SurfaceFlinger --display-id`
  (the fold AVD has two panels), falling back to `dumpsys display` and then to
  the default display.
- `last-run.png` and `report-*.json` are git-ignored.
