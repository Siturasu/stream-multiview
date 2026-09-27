(() => {
  "use strict";

  const url = new URL(location.href);
  let embedded = false;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true;
  }

  // CHZZK serves both live channels and /video/<id> replays inside tiles.
  const supportedFrame =
    (url.hostname === "chzzk.naver.com" && /^\/(?:live|video)\//.test(url.pathname)) ||
    (url.hostname === "www.youtube.com" && /^\/embed\//.test(url.pathname));
  if (!embedded || !supportedFrame || url.searchParams.get("sv") !== "1") {
    return;
  }

  const CURSOR_CLASS = "sv-fullscreen-cursor-hidden";
  const CURSOR_STYLE_ID = "sv-fullscreen-cursor-style";
  const viewerOrigin = new URL(chrome.runtime.getURL("/")).origin;
  let lastPointerReport = -Infinity;

  function markReady() {
    document.documentElement.dataset.svActivityRelay = "ready";
  }

  function setCursorHidden(hidden) {
    let style = document.getElementById(CURSOR_STYLE_ID);
    if (hidden && !style) {
      style = document.createElement("style");
      style.id = CURSOR_STYLE_ID;
      style.textContent = `html.${CURSOR_CLASS}, html.${CURSOR_CLASS} * { cursor: none !important; }`;
      (document.head || document.documentElement).append(style);
    }
    document.documentElement.classList.toggle(CURSOR_CLASS, hidden);
  }

  function reportActivity(event) {
    const now = performance.now();
    if (event.type === "pointermove" && now - lastPointerReport < 80) return;
    if (event.type === "pointermove") lastPointerReport = now;
    window.parent.postMessage(
      // kind lets the viewer tell a pointer that moved into this frame from a
      // key press or a focus change, which say nothing about pointer position.
      { source: "stellaview-frame", type: "viewer-activity", kind: event.type },
      viewerOrigin,
    );
  }

  document.addEventListener("pointermove", reportActivity, {
    capture: true,
    passive: true,
  });
  document.addEventListener("pointerdown", reportActivity, {
    capture: true,
    passive: true,
  });
  document.addEventListener("keydown", reportActivity, true);
  document.addEventListener("focusin", reportActivity, true);

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== viewerOrigin ||
      event.data?.source !== "stellaview" ||
      event.data.type !== "fullscreen-controls" ||
      typeof event.data.hidden !== "boolean"
    ) {
      return;
    }
    setCursorHidden(event.data.hidden);
  });

  if (document.documentElement) {
    markReady();
  } else {
    document.addEventListener("DOMContentLoaded", markReady, { once: true });
  }
})();
