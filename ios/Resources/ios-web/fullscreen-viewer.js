// iPad wrapper only. This module is imported by chrome-shim.js after the
// viewer DOM exists. It never moves an iframe: CSS raises the existing tile
// over the other tiles, so an active stream keeps its network/player state.

const FRAME_SOURCE = "stellaview-ios-fullscreen-frame";
const CONTROL_HIDE_DELAY_MS = 1_800;

export function trustedTileForFullscreenMessage(event, frames, baseURL = location.href) {
  if (
    event.data?.source !== FRAME_SOURCE ||
    !["request", "exit", "activity"].includes(event.data.type)
  ) return null;

  for (const frame of frames) {
    if (frame.contentWindow !== event.source) continue;
    try {
      if (new URL(frame.src, baseURL).origin !== event.origin) return null;
    } catch {
      return null;
    }
    return frame.closest(".stream-tile");
  }
  return null;
}

export function installIOSFullscreenAdapter() {
  if (!globalThis.__stellaViewIOSFullscreenAdapter) return;
  if (document.documentElement.dataset.svIOSFullscreenAdapter === "1") return;
  document.documentElement.dataset.svIOSFullscreenAdapter = "1";

  const body = document.body;
  const fullscreenButton = document.querySelector("#fullscreen");
  if (!body || !fullscreenButton) return;

  const exitButton = document.createElement("button");
  exitButton.type = "button";
  exitButton.className = "sv-ios-fullscreen-exit";
  exitButton.textContent = "전체 화면 종료";
  exitButton.setAttribute("aria-label", "전체 화면 종료");
  exitButton.hidden = true;
  body.append(exitButton);

  // Consume the first tap while chrome is hidden. Letting that tap reach the
  // CHZZK player would also toggle pause just to reveal the wrapper's exit.
  const wakeButton = document.createElement("button");
  wakeButton.type = "button";
  wakeButton.className = "sv-ios-fullscreen-wake";
  wakeButton.setAttribute("aria-label", "전체 화면 조작부 표시");
  body.append(wakeButton);

  let selectedTile = null;
  let leavingUnexpectedNativeFullscreen = false;
  let controlsTimer = null;

  function syncLayout() {
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function setButtonState(active) {
    fullscreenButton.setAttribute("aria-label", active ? "전체 화면 종료" : "전체 화면");
    fullscreenButton.title = active ? "전체 화면 종료" : "전체 화면";
    exitButton.hidden = !active;
  }

  function framesForTile(tile) {
    return tile
      ? [...tile.querySelectorAll("iframe.stream-frame")]
      : [...document.querySelectorAll("iframe.stream-frame")];
  }

  function fullscreenFrames() {
    return framesForTile(selectedTile);
  }

  function syncFrameControlState(hidden, frames = fullscreenFrames()) {
    for (const frame of frames) {
      let origin;
      try { origin = new URL(frame.src, location.href).origin; } catch { continue; }
      if (origin !== "https://chzzk.naver.com" && origin !== "https://www.youtube.com") continue;
      frame.contentWindow?.postMessage(
        { source: "stellaview", type: "fullscreen-controls", hidden },
        origin,
      );
    }
  }

  function clearControlsTimer() {
    if (controlsTimer === null) return;
    window.clearTimeout(controlsTimer);
    controlsTimer = null;
  }

  function setFullscreenControlsHidden(hidden, forceFrameSync = false) {
    if (!body.classList.contains("fullscreen-view")) return;
    const changed = body.classList.contains("fullscreen-controls-hidden") !== hidden;
    body.classList.toggle("fullscreen-controls-hidden", hidden);
    if (changed || forceFrameSync) syncFrameControlState(hidden);
  }

  function hasFocusedFullscreenControl() {
    return Boolean(document.querySelector(
      ".sv-ios-fullscreen-exit:focus-visible, .topbar :focus-visible, .tile-actions :focus-visible, .sv-overflow :focus-visible, .volume-panel :focus-visible",
    ));
  }

  function noteFullscreenActivity(event) {
    if (!body.classList.contains("fullscreen-view")) return;
    if (event?.target === wakeButton) return;
    setFullscreenControlsHidden(false);
    clearControlsTimer();
    controlsTimer = window.setTimeout(() => {
      controlsTimer = null;
      if (!body.classList.contains("fullscreen-view")) return;
      if (hasFocusedFullscreenControl()) noteFullscreenActivity();
      else setFullscreenControlsHidden(true);
    }, CONTROL_HIDE_DELAY_MS);
  }

  function resetTileFullscreenState(tile) {
    const frame = tile?.querySelector?.("iframe.stream-frame");
    if (!frame?.contentWindow) return;
    let origin;
    try { origin = new URL(frame.src, location.href).origin; } catch { return; }
    frame.contentWindow.postMessage(
      { source: "stellaview-ios-fullscreen", type: "reset" },
      origin,
    );
  }

  function exit() {
    clearControlsTimer();
    setFullscreenControlsHidden(false);
    if (body.classList.contains("sv-ios-tile-fullscreen")) {
      // App-fullscreen initially hides every frame. A later single-tile exit
      // must restore those background frames too.
      syncFrameControlState(false, framesForTile(null));
    }
    resetTileFullscreenState(selectedTile);
    selectedTile?.classList.remove("sv-ios-fullscreen-tile");
    selectedTile = null;
    body.classList.remove("fullscreen-view", "sv-ios-app-fullscreen", "sv-ios-tile-fullscreen", "fullscreen-controls-hidden");
    setButtonState(false);
    syncLayout();
  }

  function enterApp() {
    resetTileFullscreenState(selectedTile);
    selectedTile?.classList.remove("sv-ios-fullscreen-tile");
    selectedTile = null;
    body.classList.add("fullscreen-view", "sv-ios-app-fullscreen");
    body.classList.remove("sv-ios-tile-fullscreen");
    setButtonState(true);
    setFullscreenControlsHidden(true, true);
    syncLayout();
  }

  function enterTile(tile) {
    if (!tile?.isConnected) return;
    if (selectedTile && selectedTile !== tile) {
      // The old frame is no longer on top. Restore its cursor/control state
      // before resetting virtual fullscreen so it cannot stay hidden in a
      // later normal-grid view.
      syncFrameControlState(false, framesForTile(selectedTile));
      resetTileFullscreenState(selectedTile);
    }
    selectedTile?.classList.remove("sv-ios-fullscreen-tile");
    selectedTile = tile;
    tile.classList.add("sv-ios-fullscreen-tile");
    body.classList.add("fullscreen-view", "sv-ios-tile-fullscreen");
    body.classList.remove("sv-ios-app-fullscreen");
    setButtonState(true);
    // The prior tile can already have hidden controls. Force the same state
    // into this newly-selected iframe instead of relying on a class change.
    setFullscreenControlsHidden(true, true);
    syncLayout();
  }

  // Registered before viewer.js's bubble listener. This keeps its
  // requestFullscreen() path from reaching WKWebView on iPad.
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("#fullscreen")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (body.classList.contains("fullscreen-view")) exit();
    else enterApp();
  }, true);

  exitButton.addEventListener("click", exit);
  wakeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    noteFullscreenActivity();
  });
  for (const type of ["pointerdown", "pointermove", "focusin"]) {
    window.addEventListener(type, noteFullscreenActivity, { capture: true, passive: type !== "focusin" });
  }
  window.addEventListener("keydown", (event) => {
    if (!body.classList.contains("fullscreen-view")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      exit();
      return;
    }
    noteFullscreenActivity();
  }, true);
  window.addEventListener("orientationchange", syncLayout, { passive: true });
  window.visualViewport?.addEventListener("resize", syncLayout, { passive: true });

  window.addEventListener("message", (event) => {
    const tile = trustedTileForFullscreenMessage(
      event,
      document.querySelectorAll("iframe.stream-frame"),
    );
    if (!tile) return;
    event.stopImmediatePropagation();
    if (event.data.type === "activity") {
      noteFullscreenActivity();
      return;
    }
    if (event.data.type === "exit") {
      if (tile === selectedTile) exit();
      return;
    }
    enterTile(tile);
  }, true);

  // A closed or removed tile must never leave an invisible selected tile and
  // a stranded exit state behind.
  new MutationObserver(() => {
    if (selectedTile && !selectedTile.isConnected) exit();
  }).observe(document.body, { childList: true, subtree: true });

  // A bypassed document-level fullscreen request is not our normal path, but
  // returning to the CSS view is safer than leaving a native black surface.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement || leavingUnexpectedNativeFullscreen) return;
    leavingUnexpectedNativeFullscreen = true;
    Promise.resolve(document.exitFullscreen?.())
      .catch(() => {})
      .finally(() => {
        leavingUnexpectedNativeFullscreen = false;
        // viewer.js receives the native exit event too and clears its class.
        // Re-enter only after that transition has completed.
        if (!document.fullscreenElement) enterApp();
      });
  }, true);
}
