// iPad wrapper only. This runs in page world at document-start in every
// subframe. It redirects a player page's Fullscreen API request to its
// already-full-screen WKWebView parent instead of asking WebKit for a second
// native video surface.
//
// The parent origin is injected by WebAssets.swift. Do not fall back to "*":
// a frame must know exactly which wrapper document may receive this signal.
(() => {
  if (!globalThis.__stellaViewIOSFullscreenAdapter) return;
  const isSubframe = (() => {
    try { return window.top !== window.self; } catch { return true; }
  })();
  if (!isSubframe) return;

  const parentOrigin = globalThis.__stellaViewFullscreenParentOrigin;
  if (typeof parentOrigin !== "string") return;
  try {
    if (new URL(parentOrigin).origin !== parentOrigin) return;
  } catch {
    return;
  }

  function tellParent(type) {
    try {
      window.parent.postMessage(
        { source: "stellaview-ios-fullscreen-frame", type },
        parentOrigin,
      );
    } catch {
      // The frame can be removed between a player interaction and delivery.
    }
  }

  let lastPointerReport = -Infinity;
  function reportActivity(event) {
    const now = performance.now();
    if (event.type === "pointermove" && now - lastPointerReport < 80) return;
    if (event.type === "pointermove") lastPointerReport = now;
    tellParent("activity");
  }

  // The isolated-world relay intentionally skips VOD navigations that lose
  // `sv=1`. This page-world relay covers those managed frames and does not
  // prevent, pause, or otherwise interfere with player gestures.
  document.addEventListener("pointermove", reportActivity, { capture: true, passive: true });
  document.addEventListener("pointerdown", reportActivity, { capture: true, passive: true });
  document.addEventListener("keydown", reportActivity, true);
  document.addEventListener("focusin", reportActivity, true);

  // `isElementFullscreenEnabled = false` may make WebKit expose no usable
  // Fullscreen API to a player. Provide only the small API surface this
  // adapter implements, inside an embedded player frame. A site can therefore
  // keep its own fullscreen button state and use the second press to exit.
  let virtualFullscreenElement = null;
  let dispatchingVirtualFullscreenChange = false;
  function setVirtualFullscreenElement(element) {
    virtualFullscreenElement = element;
    dispatchingVirtualFullscreenChange = true;
    try { document.dispatchEvent(new Event("fullscreenchange")); } catch {}
    dispatchingVirtualFullscreenChange = false;
  }

  function defineVirtualDocumentProperty(name, getter) {
    try {
      Object.defineProperty(document, name, { configurable: true, get: getter });
      return;
    } catch {}
    try {
      Object.defineProperty(Document.prototype, name, { configurable: true, get: getter });
    } catch {}
  }

  defineVirtualDocumentProperty("fullscreenElement", () => virtualFullscreenElement);
  defineVirtualDocumentProperty("webkitFullscreenElement", () => virtualFullscreenElement);
  defineVirtualDocumentProperty("fullscreenEnabled", () => true);
  defineVirtualDocumentProperty("webkitFullscreenEnabled", () => true);

  // The wrapper owns the visible Exit affordance. Clear only this frame's
  // virtual state when it is used, so the next player fullscreen press enters
  // again instead of calling the player's exit branch.
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== parentOrigin ||
      event.data?.source !== "stellaview-ios-fullscreen" ||
      event.data.type !== "reset"
    ) return;
    setVirtualFullscreenElement(null);
  });

  // Limit the override to fullscreen entry/exit methods in this player frame.
  // The wrapper document itself retains the standard APIs for every other
  // platform and never receives this script's override.
  function redirectMethod(prototype, name, type) {
    if (!prototype) return;
    try {
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value() {
          setVirtualFullscreenElement(type === "request" ? this : null);
          tellParent(type);
          return Promise.resolve();
        },
      });
    } catch {
      // A locked future WebKit API keeps its normal behavior. The event
      // listeners below still try to return to the wrapper surface.
    }
  }

  // Keep a direct reference for the event fallback below. Calling the method
  // through `event.target` after it has been redirected would only post a
  // second message and would leave the native surface open.
  const nativeVideoExit = HTMLVideoElement?.prototype?.webkitExitFullscreen;

  redirectMethod(Element?.prototype, "requestFullscreen", "request");
  redirectMethod(HTMLElement?.prototype, "webkitRequestFullscreen", "request");
  redirectMethod(HTMLVideoElement?.prototype, "webkitEnterFullscreen", "request");
  redirectMethod(Document?.prototype, "exitFullscreen", "exit");
  redirectMethod(HTMLVideoElement?.prototype, "webkitExitFullscreen", "exit");

  // Some native control paths bypass the JavaScript method. When WebKit tells
  // us it entered one, leave it immediately and expose the same CSS tile view.
  document.addEventListener("webkitbeginfullscreen", (event) => {
    try { nativeVideoExit?.call(event.target); } catch {}
    tellParent("request");
  }, true);
  document.addEventListener("fullscreenchange", () => {
    if (!dispatchingVirtualFullscreenChange && document.fullscreenElement) tellParent("request");
  }, true);
})();
