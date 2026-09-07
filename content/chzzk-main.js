(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const isChatRoute = /\/chat\/?$/.test(location.pathname);
  let isEmbedded = false;
  try {
    isEmbedded = window.self !== window.top;
  } catch {
    isEmbedded = true;
  }

  if (
    !isEmbedded ||
    isChatRoute ||
    params.get("sv") !== "1"
  ) {
    return;
  }

  document.documentElement.classList.add("sv-embedded");

  const desiredLabel = new Set(["1080p", "720p", "480p", "360p"]).has(params.get("quality"))
    ? params.get("quality")
    : "1080p";
  const qualityTracks = Object.freeze({
    "1080p": Object.freeze({ label: "1080p", width: 1920, height: 1080 }),
    "720p": Object.freeze({ label: "720p", width: 1280, height: 720 }),
    "480p": Object.freeze({ label: "480p", width: 854, height: 480 }),
    "360p": Object.freeze({ label: "360p", width: 640, height: 360 }),
  });
  const desiredTrack = qualityTracks[desiredLabel];
  const desiredHeight = desiredTrack.height;
  let desiredMuted = params.get("muted") !== "0";
  let viewerOrigin = null;
  const pendingViewerMessages = new Map();

  function writeQualityPreference() {
    try {
      // CHZZK reads this first-party preference while creating its player and
      // selects the matching track label. Doing this at document_start avoids
      // opening the visible settings menu or depending on its DOM structure.
      localStorage.setItem("live-player-video-track", JSON.stringify(desiredTrack));
      document.documentElement.dataset.svQualityMethod = "preference";
      return true;
    } catch {
      document.documentElement.dataset.svQualityMethod = "unavailable";
      return false;
    }
  }

  let qualityPreferenceWritten = writeQualityPreference();

  function postToViewer(message) {
    if (!viewerOrigin) {
      pendingViewerMessages.set(message.type || "message", message);
      return;
    }
    try {
      window.parent.postMessage({ source: "stellaview", ...message }, viewerOrigin);
    } catch {
      // The viewer can be closed while the frame is tearing down.
    }
  }

  function installDirectHlsBridge() {
    if (params.get("grid") !== "1" || !/^\/live(?:\/|$)/.test(location.pathname)) return;

    const installFlag = "__stellaViewDirectHlsInstalled";
    const wrappedFlag = "__stellaViewDirectHlsWrapped";
    const nativeParse = JSON.parse;
    if (window[installFlag] || typeof nativeParse !== "function" || nativeParse[wrappedFlag]) return;

    const directHosts = new Set([
      "livecloud.pstatic.net",
      "nvelop-livecloud.pstatic.net",
      "ex-nlive-streaming.navercdn.com",
    ]);
    const playbackKeys = ["livePlaybackJson", "playbackJson"];
    const qualityKeys = ["p2pQuality", "pq"];
    const p2pKeys = ["p2pPath", "p2pPathUrlEncoding"];
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    function trustedDirectMedia(media) {
      if (
        media?.protocol !== "HLS" ||
        !["HLS", "LLHLS"].includes(media?.mediaId) ||
        typeof media?.path !== "string"
      ) {
        return false;
      }
      try {
        const url = new URL(media.path, location.href);
        return url.protocol === "https:" && directHosts.has(url.hostname) && url.pathname.endsWith(".m3u8");
      } catch {
        return false;
      }
    }

    function withoutP2pFields(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      if (!p2pKeys.some((key) => hasOwn(value, key))) return value;
      const copy = { ...value };
      for (const key of p2pKeys) delete copy[key];
      return copy;
    }

    function rewritePlayback(value) {
      if (!value || typeof value !== "object" || !Array.isArray(value.media)) return value;
      let changed = false;
      const media = value.media.map((entry) => {
        if (!trustedDirectMedia(entry)) return entry;
        let next = withoutP2pFields(entry);
        if (Array.isArray(entry.encodingTrack)) {
          const tracks = entry.encodingTrack.map(withoutP2pFields);
          if (tracks.some((track, index) => track !== entry.encodingTrack[index])) {
            next = { ...next, encodingTrack: tracks };
          }
        }
        changed ||= next !== entry;
        return next;
      });
      if (!changed) return value;
      const meta = value.meta?.p2p === true ? { ...value.meta, p2p: false } : value.meta;
      return { ...value, meta, media };
    }

    function rewriteEnvelope(value) {
      const content = value?.content;
      if (!content || typeof content !== "object" || Array.isArray(content)) return value;

      let nextContent = content;
      let patchedTrustedPlayback = false;
      let changed = false;
      for (const key of playbackKeys) {
        if (!hasOwn(content, key)) continue;
        const raw = content[key];
        try {
          const parsed = typeof raw === "string" ? nativeParse(raw) : raw;
          if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.media)) continue;
          const rewritten = rewritePlayback(parsed);
          if (rewritten !== parsed) {
            patchedTrustedPlayback = true;
            nextContent = {
              ...nextContent,
              [key]: typeof raw === "string" ? JSON.stringify(rewritten) : rewritten,
            };
            changed = true;
          }
        } catch {
          // Unknown response shapes remain untouched.
        }
      }

      if (patchedTrustedPlayback) {
        for (const key of qualityKeys) {
          if (Array.isArray(content[key]) && content[key].length > 0) {
            nextContent = { ...nextContent, [key]: [] };
            changed = true;
          }
        }
      }
      return changed ? { ...value, content: nextContent } : value;
    }

    const wrappedParse = function (...args) {
      const parsed = nativeParse.apply(this, args);
      if (args.length > 1 && typeof args[1] === "function") return parsed;
      const direct = rewritePlayback(parsed);
      return direct !== parsed ? direct : rewriteEnvelope(parsed);
    };

    try {
      Object.defineProperty(wrappedParse, wrappedFlag, { value: true });
      JSON.parse = wrappedParse;
      Object.defineProperty(window, installFlag, { value: true });
    } catch {
      // A future player may lock JSON.parse. Playback then continues unchanged.
    }
  }

  installDirectHlsBridge();

  function applyMutedState(root = document) {
    const videos = root instanceof HTMLVideoElement ? [root] : root.querySelectorAll?.("video") || [];
    for (const video of videos) {
      try {
        video.defaultMuted = desiredMuted;
        video.muted = desiredMuted;
        if (video.paused) video.play().catch(() => {});
      } catch {
        // The player can replace the media element during a quality switch.
      }
    }
  }

  let isolatedPlayerRoot = null;

  function isolatePlayerShell(root) {
    if (!root || root === isolatedPlayerRoot) return;
    document.querySelectorAll(".sv-player-path, .sv-shell-hidden").forEach((element) => {
      element.classList.remove("sv-player-path", "sv-shell-hidden");
    });

    let node = root;
    while (node && node !== document.body) {
      node.classList.add("sv-player-path");
      const parent = node.parentElement;
      if (!parent) break;
      for (const sibling of parent.children) {
        if (sibling !== node) sibling.classList.add("sv-shell-hidden");
      }
      node = parent;
    }
    isolatedPlayerRoot = root;
  }

  function playerRoot() {
    const root = document.querySelector("#live_player_layout, #player_layout, [aria-label='비디오 플레이어']");
    if (root) {
      root.classList.add("sv-player-root");
      isolatePlayerShell(root);
    }
    return root;
  }

  let alignedPlayerRoot = null;

  function alignPlayerToViewport(force = false) {
    const root = playerRoot();
    if (!root || (!force && root === alignedPlayerRoot)) return;
    const isNewRoot = root !== alignedPlayerRoot;

    // CHZZK currently places the live player inside a transformed shell. A
    // fixed child is therefore offset by the site's header/sidebar containing
    // block. Measure that offset at zero and cancel it without moving the
    // React-owned player node.
    root.style.setProperty("--sv-player-offset-x", "0px");
    root.style.setProperty("--sv-player-offset-y", "0px");
    const rect = root.getBoundingClientRect();
    root.style.setProperty("--sv-player-offset-x", `${-rect.left}px`);
    root.style.setProperty("--sv-player-offset-y", `${-rect.top}px`);
    alignedPlayerRoot = root;
    if (isNewRoot) resetQualityObservation();
  }

  let qualityFallbackTimer = 0;
  let qualityFallbackReported = false;
  let qualityConfirmed = false;
  let lastQualityReport = "";

  function reportQuality(status, label = desiredLabel) {
    const reportKey = `${status}:${label}`;
    if (reportKey === lastQualityReport) return;
    lastQualityReport = reportKey;
    document.documentElement.dataset.svQualityStatus = status;
    document.documentElement.dataset.svQualityLabel = label;
    postToViewer({ type: "quality", status, label });
  }

  function clearQualityFallback() {
    if (!qualityFallbackTimer) return;
    window.clearTimeout(qualityFallbackTimer);
    qualityFallbackTimer = 0;
  }

  function actualQualityLabel(height) {
    const rounded = [1080, 720, 480, 360].find((candidate) => Math.abs(candidate - height) <= 32);
    return rounded ? `${rounded}p` : `${height}p`;
  }

  function resetQualityObservation() {
    clearQualityFallback();
    qualityFallbackReported = false;
    qualityConfirmed = false;
    lastQualityReport = "";
    qualityPreferenceWritten = writeQualityPreference();
    reportQuality(qualityPreferenceWritten ? "requested" : "unavailable", desiredLabel);
  }

  function observeVideoQuality(video) {
    if (qualityConfirmed || !video.isConnected || !video.closest(".sv-player-root") || !video.videoHeight) return;
    if (Math.abs(video.videoHeight - desiredHeight) <= 32) {
      clearQualityFallback();
      qualityConfirmed = true;
      reportQuality("selected", desiredLabel);
      return;
    }
    if (qualityFallbackTimer || qualityFallbackReported) return;
    qualityFallbackTimer = window.setTimeout(() => {
      qualityFallbackTimer = 0;
      if (qualityConfirmed) return;
      const current = document.querySelector(".sv-player-root video");
      if (current?.videoHeight) {
        qualityFallbackReported = true;
        reportQuality("fallback", actualQualityLabel(current.videoHeight));
      }
    }, 8_000);
  }

  function trackVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    applyMutedState(video);
    if (video.dataset.stellaViewTracked === "1") return;
    video.dataset.stellaViewTracked = "1";
    const checkQuality = () => {
      applyMutedState(video);
      observeVideoQuality(video);
      postToViewer({ type: "player-ready" });
    };
    video.addEventListener("loadedmetadata", checkQuality);
    video.addEventListener("resize", checkQuality);
    checkQuality();
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("video")) trackVideo(node);
        node.querySelectorAll?.("video").forEach(trackVideo);
      }
    }
    alignPlayerToViewport();
  });

  const start = () => {
    alignPlayerToViewport();
    applyMutedState();
    document.querySelectorAll("video").forEach(trackVideo);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (!lastQualityReport) resetQualityObservation();
    postToViewer({ type: "player-ready" });
  };

  window.addEventListener("resize", () => alignPlayerToViewport(true));

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(event.origin) ||
      event.data?.source !== "stellaview"
    ) {
      return;
    }
    viewerOrigin = event.origin;
    for (const message of pendingViewerMessages.values()) {
      postToViewer(message);
    }
    pendingViewerMessages.clear();
    if (event.data.type === "set-muted" && typeof event.data.muted === "boolean") {
      desiredMuted = event.data.muted;
      applyMutedState();
    }
  });
})();
