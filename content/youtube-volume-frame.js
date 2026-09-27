// Page-world script for https://www.youtube.com/embed/* subframes. It applies
// the per-tile volume the viewer asks for and reports which mechanism actually
// worked, so the viewer can hide a dead slider.
//
// The same file runs in both hosts: Chrome loads it as a MAIN-world content
// script declared in manifest.json, and the iPad/Android wrappers inject it
// with globalThis.__stellaViewViewerOrigin set to their viewer origin. Do not
// fall back to "*": a frame must know exactly which document may command it.
(() => {
  "use strict";

  if (location.hostname !== "www.youtube.com" || !/^\/embed\//.test(location.pathname)) return;
  let isSubframe = false;
  try {
    isSubframe = window.self !== window.top;
  } catch {
    isSubframe = true;
  }
  if (!isSubframe) return;

  // Chrome hosts the viewer on chrome-extension://<id>. Other hosts (the
  // wrappers) announce their viewer origin before this script runs.
  const viewerOriginPattern = /^chrome-extension:\/\/[a-p]{32}$/;
  const configuredViewerOrigin =
    typeof globalThis.__stellaViewViewerOrigin === "string" ? globalThis.__stellaViewViewerOrigin : null;
  if (configuredViewerOrigin !== null) {
    try {
      if (new URL(configuredViewerOrigin).origin !== configuredViewerOrigin) return;
    } catch {
      return;
    }
  } else if (new URLSearchParams(location.search).get("sv") !== "1") {
    // A plain YouTube embed on some other page is none of our business.
    return;
  }

  function isViewerOrigin(origin) {
    return (
      viewerOriginPattern.test(origin) ||
      (configuredViewerOrigin !== null && origin === configuredViewerOrigin)
    );
  }

  // Set once a command from an accepted origin arrives; the capability report
  // goes back only to that exact origin.
  let viewerOrigin = configuredViewerOrigin;

  // Before any command, the only document allowed to hear the read-only level
  // report is the direct parent, and only when it is a viewer origin.
  function reportOrigin() {
    if (viewerOrigin) return viewerOrigin;
    const parentOrigin = location.ancestorOrigins?.[0] || "";
    return isViewerOrigin(parentOrigin) ? parentOrigin : null;
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
    // Without a known viewer origin there is nobody safe to answer.
    if (!viewerOrigin) return;
    try {
      window.parent.postMessage(
        { source: "stellaview-youtube", type: "volume-capability", supported: mode !== "none", mode },
        viewerOrigin,
      );
    } catch {
      // The viewer can be closed while this frame is tearing down.
    }
  });

  // The last volume the viewer asked for, 0..1, or null before any request.
  let lastRequestedVolume = null;

  // YouTube keeps its own volume model behind #movie_player. Writing only the
  // element leaves that slider on a stale number, and a drag on it moves the
  // model without the sound. Mirror the applied volume into the model; the
  // guard keeps the resulting volumechange from looping.
  function syncPlayerModel() {
    if (lastRequestedVolume === null) return;
    const player = document.getElementById("movie_player");
    if (!player || typeof player.getVolume !== "function" || typeof player.setVolume !== "function") return;
    const target = Math.round(lastRequestedVolume * 100);
    try {
      if (Math.abs(Number(player.getVolume()) - target) >= 1) player.setVolume(target);
    } catch {
      // player mid-teardown
    }
  }

  function applyDesiredVolume(video) {
    try {
      const mode = volumeControl.apply(video);
      if (mode === "element") syncPlayerModel();
    } catch {
      // The player replaces its media element on some quality switches.
    }
  }

  // While the viewer has not asked for a volume, report the player's own
  // level (the model's, which is what YouTube's slider shows; the element runs
  // below it under loudness normalisation) so the panel can show it and start
  // a drag from it instead of 100.
  function reportSiteVolume(video) {
    // The wrappers always apply a panel value, so only the extension listens.
    if (configuredViewerOrigin !== null || volumeControl.requested()) return;
    const target = reportOrigin();
    if (!target) return;
    let volume = typeof video.volume === "number" ? video.volume : 1;
    const player = document.getElementById("movie_player");
    if (player && typeof player.getVolume === "function") {
      try {
        const model = Number(player.getVolume());
        if (Number.isFinite(model)) volume = Math.min(1, Math.max(0, model / 100));
      } catch {
        // player mid-teardown
      }
    }
    try {
      window.parent.postMessage({ source: "stellaview-youtube", type: "volume-state", volume }, target);
    } catch {
      // The viewer can be closed while this frame is tearing down.
    }
  }

  function trackVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.dataset.stellaViewVolumeTracked !== "1") {
      video.dataset.stellaViewVolumeTracked = "1";
      // Once the panel has spoken it is the single source of truth. The site's
      // restore on a fresh element and any drag on the in-player slider are
      // both put back to the viewer's value, and the player model is re-synced
      // with it. Until then the level is only reported.
      video.addEventListener("volumechange", () => { applyDesiredVolume(video); reportSiteVolume(video); });
      video.addEventListener("loadedmetadata", () => { applyDesiredVolume(video); reportSiteVolume(video); });
    }
    applyDesiredVolume(video);
    reportSiteVolume(video);
  }

  function scanVideos() {
    document.querySelectorAll("video").forEach(trackVideo);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches("video")) trackVideo(node);
        node.querySelectorAll?.("video").forEach(trackVideo);
      }
    }
  });

  const start = () => {
    scanVideos();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== window.parent ||
      !isViewerOrigin(event.origin) ||
      !data ||
      typeof data !== "object" ||
      data.source !== "stellaview" ||
      data.type !== "set-volume" ||
      !volumeControl.request(data.volume)
    ) {
      return;
    }
    lastRequestedVolume = Math.min(1, Math.max(0, data.volume));
    viewerOrigin = event.origin;
    scanVideos();
  });
})();
