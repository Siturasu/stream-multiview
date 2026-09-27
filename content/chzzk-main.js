(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const isChatRoute = /\/chat\/?$/.test(location.pathname);
  // A /video replay must not be resumed by a mute command: the original
  // extension only ever hosted live channels, where "keep playing" is right.
  const isReplay = /^\/video\//.test(location.pathname);
  let isEmbedded = false;
  try {
    isEmbedded = window.self !== window.top;
  } catch {
    isEmbedded = true;
  }

  if (
    !isEmbedded ||
    isChatRoute ||
    (params.get("sv") !== "1" && globalThis.__stellaViewManagedFrame !== true)
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
  // Chrome hosts the viewer on chrome-extension://<id>. Other hosts (the iOS
  // WKWebView wrapper) announce their viewer origin before this script runs.
  const viewerOriginPattern = /^chrome-extension:\/\/[a-p]{32}$/;
  const configuredViewerOrigin =
    typeof globalThis.__stellaViewViewerOrigin === "string"
      ? globalThis.__stellaViewViewerOrigin
      : null;
  // The wrappers inject this script with a viewer origin or as a managed
  // frame. Only they get the iPad media handling below; the Chrome extension
  // keeps the original mute/play behaviour so the player's own controls work.
  const wrapperHost = configuredViewerOrigin !== null || globalThis.__stellaViewManagedFrame === true;

  function isViewerOrigin(origin) {
    return (
      viewerOriginPattern.test(origin) ||
      (configuredViewerOrigin !== null && origin === configuredViewerOrigin)
    );
  }

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

  const pendingAudioStart = new WeakMap();
  const preparedVideos = new WeakSet();

  function prepareVideo(video) {
    // VOD players can create a fresh video and call play before MutationObserver
    // runs. Configure inline playback and audio focus before that first play.
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    if (!preparedVideos.has(video)) {
      preparedVideos.add(video);
      video.addEventListener("playing", () => {
        // WebKit can dispatch `playing` before admitting the media session.
        // The play promise, when present, owns the later audio restoration.
        prepareVideo(video);
      });
    }
    const muted = desiredMuted || video.paused || pendingAudioStart.has(video);
    if (video.defaultMuted !== muted) video.defaultMuted = muted;
    if (video.muted !== muted) video.muted = muted;
  }

  // Wrappers only: the page's play() is wrapped so every start is muted and
  // inline first. Chrome plays audio from several tiles without it.
  if (wrapperHost) {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      let audioStart;
      if (this instanceof HTMLVideoElement) {
        // Starting a second audible element can interrupt another iPad video.
        // Start/restart inline and muted, then restore this tile's chosen audio
        // after its play promise settles (the playing event can be too early).
        if (this.paused || pendingAudioStart.has(this)) {
          audioStart = {};
          pendingAudioStart.set(this, audioStart);
        }
        prepareVideo(this);
      }
      const result = originalPlay.apply(this, args);
      if (!audioStart) return result;
      return result.then(() => {
        if (pendingAudioStart.get(this) !== audioStart) return;
        pendingAudioStart.delete(this);
        prepareVideo(this);
      }, (error) => {
        if (pendingAudioStart.get(this) === audioStart) pendingAudioStart.delete(this);
        throw error;
      });
    };
  }

  function applyMutedState(root = document, startPlayback = false) {
    const videos = root instanceof HTMLVideoElement ? [root] : root.querySelectorAll?.("video") || [];
    for (const video of videos) {
      try {
        if (wrapperHost) {
          prepareVideo(video);
          if (startPlayback && video.paused) video.play().catch(() => {});
        } else {
          // The original extension behaviour: apply the viewer's mute and
          // keep a live tile playing on every call. A paused replay only
          // starts when its element is first seen.
          video.defaultMuted = desiredMuted;
          video.muted = desiredMuted;
          if (video.paused && (startPlayback || !isReplay)) video.play().catch(() => {});
        }
      } catch {
        // The player can replace the media element during a quality switch.
      }
    }
  }

  // Per-tile volume. The element setter is tried first. iPadOS ignores it and
  // reads back 1, so a Web Audio gain node is the fallback -- but only for an
  // MSE-fed element (`blob:` source). A `data:` or `http(s)` source means
  // native HLS with cross-origin segments, where createMediaElementSource
  // would taint the graph and output silence, so that case reports "none".
  //
  // Mirrored verbatim between content/chzzk-main.js and
  // content/youtube-volume-frame.js; keep the two copies equal.
  function createVolumeController(reportMode) {
    const tolerance = 0.01;
    const states = new WeakMap();
    const graphs = new WeakMap();
    const applying = new WeakSet();
    let audioContext = null;
    let audioContextUnavailable = false;
    let desiredVolume = 1;
    let volumeRequested = false;
    let reportedMode = null;

    function frameAudioContext() {
      if (audioContext || audioContextUnavailable) return audioContext;
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof Context !== "function") {
        audioContextUnavailable = true;
        return null;
      }
      try {
        audioContext = new Context();
      } catch {
        audioContextUnavailable = true;
      }
      return audioContext;
    }

    function resumeAudioContext() {
      try {
        audioContext?.resume?.()?.catch?.(() => {});
      } catch {
        // A context that stays suspended resumes on the next user gesture.
      }
    }

    // One MediaElementAudioSourceNode per element, created at most once: a
    // second call throws and would leave that element permanently silent.
    function audioGraph(video) {
      if (graphs.has(video)) return graphs.get(video);
      const context = frameAudioContext();
      if (!context) return null;
      let graph = null;
      try {
        const source = context.createMediaElementSource(video);
        const gain = context.createGain();
        source.connect(gain).connect(context.destination);
        graph = { source, gain };
      } catch {
        // Already routed elsewhere, or unsupported by this engine.
      }
      graphs.set(video, graph);
      return graph;
    }

    function readVolume(video) {
      try {
        return typeof video.volume === "number" ? video.volume : 1;
      } catch {
        return 1;
      }
    }

    function currentSource(video) {
      return typeof video.currentSrc === "string" ? video.currentSrc : "";
    }

    function remember(video, mode, src) {
      states.set(video, { target: desiredVolume, mode, src });
      if (mode !== reportedMode) {
        reportedMode = mode;
        reportMode(mode);
      }
      return mode;
    }

    function applyNow(video) {
      const src = currentSource(video);
      const state = states.get(video);
      // An element that ignores the setter only needs work when the request
      // or the source changes. Re-applying would answer its own volumechange.
      if (state && state.mode !== "element" && state.target === desiredVolume && state.src === src) {
        return state.mode;
      }

      const graph = graphs.get(video);
      if (graph) {
        graph.gain.gain.value = desiredVolume;
        resumeAudioContext();
        return remember(video, "webaudio", src);
      }

      if (Math.abs(readVolume(video) - desiredVolume) >= tolerance) {
        try {
          video.volume = desiredVolume;
        } catch {
          // A detached element can throw while the player swaps sources.
        }
      }
      if (Math.abs(readVolume(video) - desiredVolume) < tolerance) return remember(video, "element", src);

      // Without a source the element cannot be classified yet. The
      // loadedmetadata listener runs this again once it has one.
      if (!src) return null;
      if (!src.startsWith("blob:")) return remember(video, "none", src);
      const created = audioGraph(video);
      if (!created) return remember(video, "none", src);
      created.gain.gain.value = desiredVolume;
      resumeAudioContext();
      return remember(video, "webaudio", src);
    }

    return {
      // Anything but a finite number is refused, so a malformed message
      // cannot silence a tile.
      request(volume) {
        if (typeof volume !== "number" || !Number.isFinite(volume)) return false;
        desiredVolume = Math.min(1, Math.max(0, volume));
        volumeRequested = true;
        return true;
      },
      requested() {
        return volumeRequested;
      },
      // The 1.0 default means "leave the site alone": nothing is written and
      // no capability is reported until the viewer asks for a volume.
      apply(video) {
        if (!volumeRequested || applying.has(video)) return states.get(video)?.mode ?? null;
        applying.add(video);
        try {
          return applyNow(video);
        } finally {
          applying.delete(video);
        }
      },
    };
  }

  const volumeControl = createVolumeController((mode) => {
    postToViewer({ type: "volume-capability", supported: mode !== "none", mode });
  });

  // While the viewer has not asked for a volume, tell it the player's own
  // level so the panel can show it (and start a drag from it) instead of 100.
  function reportSiteVolume(video) {
    // The wrappers always apply a panel value, so only the extension listens.
    if (wrapperHost || volumeControl.requested()) return;
    const volume = typeof video.volume === "number" ? video.volume : 1;
    postToViewer({ type: "volume-state", volume });
  }

  // Mute stays independent of volume; this only scales the audible level.
  function applyDesiredVolume(root = document) {
    const videos = root instanceof HTMLVideoElement ? [root] : root.querySelectorAll?.("video") || [];
    for (const video of videos) {
      try {
        volumeControl.apply(video);
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
        if (sibling !== node && !sibling.classList.contains("sv-session-panel")) sibling.classList.add("sv-shell-hidden");
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
    // The original extension re-applied the mute (and play) whenever an
    // element was seen again, e.g. re-inserted by the player.
    if (!wrapperHost) applyMutedState(video);
    if (video.dataset.stellaViewTracked === "1") return;
    video.dataset.stellaViewTracked = "1";
    // Wrappers try autoplay once for a new element; later mute/fullscreen/
    // quality updates must not resume a video the viewer or player has paused.
    // Chrome keeps the original behaviour and plays on every applyMutedState.
    applyMutedState(video, true);
    applyDesiredVolume(video);
    // Wrappers re-assert the viewer's mute on every play and volumechange. In
    // Chrome that would make the player's own mute button dead, so only the
    // volume (inert until the viewer sends set-volume) is re-applied there.
    if (wrapperHost) video.addEventListener("play", () => prepareVideo(video));
    video.addEventListener("volumechange", () => {
      if (wrapperHost) prepareVideo(video);
      // The site restores its stored volume on a new element; put the
      // viewer's value back whenever it drifts.
      applyDesiredVolume(video);
      reportSiteVolume(video);
    });
    const checkQuality = () => {
      applyMutedState(video);
      // `currentSrc` is only trustworthy once metadata exists, so the
      // element/Web Audio decision is re-made here.
      applyDesiredVolume(video);
      reportSiteVolume(video);
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
      !isViewerOrigin(event.origin) ||
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
    if (event.data.type === "set-volume" && volumeControl.request(event.data.volume)) {
      applyDesiredVolume();
    }
  });
})();
