// Direct HLS player for CIME (ci.me) tiles inside the iOS/Android wrappers.
//
// The wrappers cannot frame ci.me pages (X-Frame-Options / frame-ancestors and
// no declarativeNetRequest), but the IVS playback URL CIME hands out is a plain
// CORS-open HLS stream. The viewer renders it in a srcdoc iframe so the tile
// keeps the same postMessage protocol as the CHZZK frames.

const CIME_PLAYBACK_HOST_SUFFIX = ".live-video.net";
const MAX_PLAYBACK_URL_LENGTH = 2_048;
const STALL_TIMEOUT_MS = 20_000;
const RETRY_INTERVAL_MS = 30_000;
// The fullscreen button dims (never hides) after the pointer rests this long.
const CONTROL_IDLE_MS = 1_800;
// iPadOS may ignore HTMLMediaElement.volume writes (it reads back 1), so a
// request for 1 proves nothing. Each source is probed once with this level at
// loadedmetadata (the player starts muted, so it is not heard); a read back
// further than VOLUME_TOLERANCE from it means no volume control.
const VOLUME_PROBE_LEVEL = 0.5;
const VOLUME_TOLERANCE = 0.01;
const OFFLINE_NOTICE = "방송이 꺼져 있거나 연결이 끊겼습니다. 30초마다 다시 시도합니다";

/** Accept only https IVS playback URLs without credentials or custom ports. */
export function isSafeCimePlaybackUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PLAYBACK_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      hostname.length > CIME_PLAYBACK_HOST_SUFFIX.length &&
      hostname.endsWith(CIME_PLAYBACK_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

function safeViewerOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function scriptLiteral(value) {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

function playerScript(playbackUrl, viewerOrigin) {
  return `(() => {
  "use strict";
  const SRC = ${scriptLiteral(playbackUrl)};
  const ORIGIN = ${scriptLiteral(viewerOrigin)};
  const STALL_TIMEOUT_MS = ${STALL_TIMEOUT_MS};
  const RETRY_INTERVAL_MS = ${RETRY_INTERVAL_MS};
  const CONTROL_IDLE_MS = ${CONTROL_IDLE_MS};
  const VOLUME_PROBE_LEVEL = ${VOLUME_PROBE_LEVEL};
  const VOLUME_TOLERANCE = ${VOLUME_TOLERANCE};
  const video = document.getElementById("video");
  const notice = document.getElementById("notice");
  const fullscreenButton = document.getElementById("fullscreen");
  let state = "";
  let readySent = false;
  let lastTime = -1;
  let lastProgressAt = Date.now();
  let retryTimer = null;
  let tornDown = false;
  // Last level the viewer asked for; the source the capability was probed for,
  // its result, and the capability last reported to the viewer.
  let requestedVolume = null;
  let probedSrc = null;
  let volumeSupported = null;
  let reportedSupported = null;
  let idleTimer = null;

  function post(type, extra) {
    try {
      window.parent.postMessage({ source: "stellaview", type, ...extra }, ORIGIN);
    } catch {}
  }

  function isBad(value) {
    return value === "offline" || value === "error";
  }

  function stopRetry() {
    if (retryTimer !== null) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  function setState(next) {
    if (tornDown || next === state) return;
    state = next;
    post("cime-player-state", {
      state: next,
      currentTime: Number(video.currentTime) || 0,
      videoHeight: Number(video.videoHeight) || 0,
    });
    notice.hidden = !isBad(next);
    if (isBad(next)) {
      if (retryTimer === null) retryTimer = setInterval(load, RETRY_INTERVAL_MS);
    } else {
      stopRetry();
    }
  }

  function sendReady() {
    if (readySent) return;
    readySent = true;
    post("player-ready", {});
  }

  function reportVolumeCapability() {
    if (volumeSupported === null || volumeSupported === reportedSupported) return;
    reportedSupported = volumeSupported;
    post(
      "volume-capability",
      volumeSupported ? { supported: true, mode: "element" } : { supported: false, mode: "none" },
    );
  }

  // Runs at loadedmetadata, once per source: writes VOLUME_PROBE_LEVEL, reads
  // it back, then restores the requested level (1 until the viewer asks).
  // Before this nothing is reported, since a read back without metadata
  // proves nothing.
  function probeVolume() {
    const src = video.currentSrc;
    if (!src) return;
    if (src === probedSrc) {
      applyVolume();
      return;
    }
    const wanted = requestedVolume === null ? 1 : requestedVolume;
    video.volume = VOLUME_PROBE_LEVEL;
    const supported = Math.abs(video.volume - VOLUME_PROBE_LEVEL) <= VOLUME_TOLERANCE;
    video.volume = wanted;
    probedSrc = src;
    volumeSupported = supported;
    reportVolumeCapability();
  }

  // Applies the requested level. After the probe a level the element did not
  // keep turns support off; an unsupported source stays unsupported (a read
  // back of 1 for a request of 1 does not prove control) until the source
  // changes and is probed again.
  function applyVolume() {
    if (requestedVolume === null) return;
    const wanted = requestedVolume;
    video.volume = wanted;
    if (probedSrc === null || probedSrc !== video.currentSrc || volumeSupported !== true) return;
    if (Math.abs(video.volume - wanted) > VOLUME_TOLERANCE) {
      volumeSupported = false;
      reportVolumeCapability();
    }
  }

  // Dim the fullscreen button while the pointer rests; any activity restores it.
  function noteActivity() {
    fullscreenButton.classList.remove("is-idle");
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      fullscreenButton.classList.add("is-idle");
    }, CONTROL_IDLE_MS);
  }

  // The iPad wrapper's frame adapter turns these calls into tile fullscreen
  // requests; elsewhere they are the standard API. Both may be missing or
  // reject, which leaves the tile as it is.
  function toggleFullscreen() {
    try {
      const result = document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function load() {
    if (tornDown) return;
    readySent = false;
    lastTime = -1;
    lastProgressAt = Date.now();
    video.src = SRC;
    video.load();
    const attempt = video.play();
    if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
  }

  video.addEventListener("loadedmetadata", () => {
    sendReady();
    probeVolume();
  });
  video.addEventListener("playing", () => {
    sendReady();
    lastProgressAt = Date.now();
    setState("playing");
  });
  video.addEventListener("timeupdate", () => {
    const time = Number(video.currentTime) || 0;
    if (time !== lastTime) {
      lastTime = time;
      lastProgressAt = Date.now();
      if (state !== "playing" && !video.paused) setState("playing");
    }
  });
  for (const type of ["waiting", "stalled"]) {
    video.addEventListener(type, () => {
      if (!isBad(state)) setState("waiting");
    });
  }
  video.addEventListener("error", () => setState("error"));
  video.addEventListener("ended", () => setState("offline"));
  video.addEventListener("resize", () => {
    const height = Number(video.videoHeight) || 0;
    if (height > 0) post("quality", { status: "selected", label: height + "p" });
  });

  const watchdog = setInterval(() => {
    if (!isBad(state) && Date.now() - lastProgressAt > STALL_TIMEOUT_MS) setState("offline");
  }, 1000);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== "stellaview") return;
    if (data.type === "set-muted" && typeof data.muted === "boolean") {
      video.muted = data.muted;
    } else if (
      data.type === "set-volume" &&
      typeof data.volume === "number" &&
      Number.isFinite(data.volume) &&
      data.volume >= 0 &&
      data.volume <= 1
    ) {
      requestedVolume = data.volume;
      applyVolume();
    } else if (data.type === "teardown") {
      tornDown = true;
      stopRetry();
      clearInterval(watchdog);
      if (idleTimer !== null) clearTimeout(idleTimer);
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  });

  fullscreenButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFullscreen();
    noteActivity();
  });
  for (const type of ["pointermove", "pointerdown"]) {
    document.addEventListener(type, noteActivity, { capture: true, passive: true });
  }
  noteActivity();

  video.muted = true;
  load();
})();`;
}

/**
 * Build the srcdoc HTML for a direct CIME HLS player, or null when the
 * playback URL or viewer origin is not acceptable.
 */
export function cimeDirectPlayerDocument({ playbackUrl, viewerOrigin } = {}) {
  if (!isSafeCimePlaybackUrl(playbackUrl)) return null;
  const origin = safeViewerOrigin(viewerOrigin);
  if (!origin) return null;
  const src = new URL(playbackUrl).href;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
#notice { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%); max-width: 88%; box-sizing: border-box; padding: 8px 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.72); color: #fff; font: 13px/1.45 -apple-system, system-ui, sans-serif; text-align: center; }
#notice[hidden] { display: none; }
#fullscreen { position: absolute; right: 6px; bottom: 6px; width: 44px; height: 44px; margin: 0; padding: 0; border: 0; border-radius: 8px; background: rgba(0, 0, 0, 0.45); color: #fff; font: 20px/44px -apple-system, system-ui, sans-serif; text-align: center; cursor: pointer; opacity: 0.9; transition: opacity 0.3s ease; -webkit-tap-highlight-color: transparent; }
#fullscreen.is-idle { opacity: 0.3; }
#fullscreen:focus-visible { opacity: 1; outline: 2px solid #fff; outline-offset: 2px; }
</style>
</head>
<body>
<video id="video" autoplay muted playsinline webkit-playsinline></video>
<div id="notice" role="status" hidden>${OFFLINE_NOTICE}</div>
<button id="fullscreen" type="button" aria-label="전체 화면" title="전체 화면">⛶</button>
<script>${playerScript(src, origin)}</script>
</body>
</html>`;
}
