// Authenticated CHZZK embeds need their first-party cookies inside the
// cross-site viewer frame. WebKit's standard path is the Storage Access API,
// which must be requested by the embedded document during a real user click.
(() => {
  "use strict";

  const isDirectManagedFrame =
    location.hostname === "chzzk.naver.com" &&
    window.self !== window.top &&
    window.parent === window.top &&
    globalThis.__stellaViewManagedFrame === true &&
    /^\/(?:live|video)\//.test(location.pathname) &&
    !/\/chat\/?$/.test(location.pathname);
  if (!isDirectManagedFrame) return;

  const viewerOrigin =
    typeof globalThis.__stellaViewViewerOrigin === "string"
      ? globalThis.__stellaViewViewerOrigin
      : null;
  const statusURL = globalThis.__stellaViewChzzkStatusURL;
  if (typeof statusURL !== "string") return;
  const panelClass = "sv-session-panel";
  let storageAccess = null;
  let panel = null;
  let button = null;
  let detail = null;
  let busy = false;
  let dismissed = false;

  function publish(loggedIn, reason) {
    if (!viewerOrigin) return;
    try {
      window.parent.postMessage(
        {
          source: "stellaview-session",
          type: "chzzk-auth-status",
          hasStorageAccess: storageAccess === true,
          loggedIn: typeof loggedIn === "boolean" ? loggedIn : null,
          reason,
        },
        viewerOrigin,
      );
    } catch {
      // The viewer can disappear while the frame is being replaced.
    }
  }

  async function readLoginStatus() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(statusURL, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return { loggedIn: null, reason: "status-unavailable" };
      const payload = await response.json();
      if (payload?.code !== 200 || typeof payload?.content?.loggedIn !== "boolean") {
        return { loggedIn: null, reason: "status-unavailable" };
      }
      return {
        loggedIn: payload?.content?.loggedIn === true,
        reason: payload?.content?.loggedIn === true ? "connected" : "signed-out",
      };
    } catch {
      return { loggedIn: null, reason: "status-unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }

  function ensurePanel() {
    if (dismissed || panel?.isConnected) return;

    panel = document.createElement("section");
    panel.className = panelClass;
    panel.setAttribute("role", "status");
    panel.style.cssText = [
      "position:fixed",
      "left:12px",
      "bottom:12px",
      "z-index:2147483647",
      "display:grid",
      "gap:10px",
      "width:min(360px,calc(100vw - 24px))",
      "padding:14px",
      "border:1px solid rgba(255,255,255,.16)",
      "border-radius:12px",
      "background:rgba(8,10,12,.92)",
      "box-shadow:0 8px 24px rgba(0,0,0,.28)",
      "color:#fff",
      "font:600 14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif",
      "pointer-events:auto",
    ].join(";");

    const title = document.createElement("strong");
    title.textContent = "방송에 로그인 연결";
    title.style.fontSize = "16px";

    detail = document.createElement("span");
    detail.textContent = "계정에서 로그인한 뒤 방송에 연결해 주세요.";
    detail.style.cssText = "color:#d7dadd;font-weight:500";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end";

    button = document.createElement("button");
    button.type = "button";
    button.textContent = "방송에 연결";
    button.style.cssText = [
      "min-width:120px",
      "min-height:44px",
      "padding:10px 18px",
      "border:0",
      "border-radius:10px",
      "background:#00ffa3",
      "color:#07110d",
      "font:700 16px/1 -apple-system,BlinkMacSystemFont,sans-serif",
    ].join(";");
    button.addEventListener("click", requestFromUserClick);

    const later = document.createElement("button");
    later.type = "button";
    later.textContent = "나중에";
    later.style.cssText = [
      "min-width:72px",
      "min-height:44px",
      "padding:10px 14px",
      "border:1px solid rgba(255,255,255,.22)",
      "border-radius:10px",
      "background:transparent",
      "color:#fff",
      "font:600 14px/1 -apple-system,BlinkMacSystemFont,sans-serif",
    ].join(";");
    later.addEventListener("click", () => {
      dismissed = true;
      panel?.remove();
      panel = null;
    });

    actions.append(later, button);
    panel.append(title, detail, actions);
    (document.body || document.documentElement).append(panel);
  }

  function showFailure(message) {
    ensurePanel();
    detail.textContent = message;
    button.textContent = "다시 연결";
    button.disabled = false;
    busy = false;
  }

  function finishConnected() {
    publish(true, "connected");
    panel?.remove();
    panel = null;
    // Storage access is granted for this top-level page. Reload this frame so
    // requests that started before the grant are recreated with cookie access.
    location.reload();
  }

  function requestFromUserClick() {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = "확인 중…";

    // Do not await hasStorageAccess() here. WebKit requires
    // requestStorageAccess() to begin while this click activation is live.
    const accessPromise = storageAccess === true
      ? Promise.resolve()
      : typeof document.requestStorageAccess === "function"
        ? document.requestStorageAccess()
        : Promise.reject(new Error("storage-access-unavailable"));

    accessPromise.then(
      async () => {
        storageAccess = true;
        const status = await readLoginStatus();
        publish(status.loggedIn, status.reason);
        if (status.loggedIn) {
          finishConnected();
          return;
        }
        const message = status.reason === "status-unavailable"
          ? "로그인 상태를 확인하지 못했습니다. 잠시 후 다시 눌러 주세요."
          : "계정에서 로그인한 뒤 다시 연결해 주세요.";
        showFailure(message);
      },
      () => {
        storageAccess = false;
        publish(false, "storage-access-denied");
        showFailure("방송 로그인 연결이 허용되지 않았습니다. 다시 눌러 허용해 주세요.");
      },
    );
  }

  async function inspect() {
    if (typeof document.hasStorageAccess === "function") {
      try {
        storageAccess = await document.hasStorageAccess();
      } catch {
        storageAccess = false;
      }
    }

    const status = await readLoginStatus();
    publish(status.loggedIn, status.reason);
    if (status.loggedIn) return;

    ensurePanel();
    if (typeof document.requestStorageAccess !== "function" && storageAccess !== true) {
      detail.textContent =
        "현재 환경에서는 방송 로그인 연결을 지원하지 않습니다. 앱을 업데이트한 뒤 다시 확인해 주세요.";
      button.disabled = true;
      return;
    }
    if (storageAccess === true && status.reason === "signed-out") {
      detail.textContent = "계정에서 로그인한 뒤 다시 연결해 주세요.";
    } else if (status.reason === "status-unavailable") {
      detail.textContent = "로그인 상태를 확인하지 못했습니다. 잠시 후 다시 눌러 주세요.";
      button.textContent = "다시 확인";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inspect, { once: true });
  } else {
    inspect();
  }
})();
