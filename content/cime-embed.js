(() => {
  "use strict";

  // CIME (ci.me) live page inside a StellaView tile. Runs in the isolated world:
  // everything here only needs the DOM (video.js player, <video> element).
  const url = new URL(location.href);
  let embedded = false;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true;
  }

  const liveMatch = /^\/@([a-z0-9_.-]{1,40})\/live\/?$/.exec(url.pathname);
  if (!embedded || !liveMatch || url.searchParams.get("sv") !== "1") {
    return;
  }

  const slug = liveMatch[1];
  const viewerOrigin = new URL(chrome.runtime.getURL("/")).origin;
  const VOLUME_CONTROL = '.vjs-volume-panel, .vjs-mute-control, .vjs-volume-control, [class*="volume"]';
  const VOLUME_KEYS = new Set(["m", "M", "ArrowUp", "ArrowDown"]);
  const USER_AUDIO_WINDOW_MS = 1_500;

  // CIME autoplays with sound; every tile starts muted until the viewer says
  // otherwise, like the CHZZK tiles.
  let desiredMuted = true;
  let desiredVolume = null;
  let lastUserInput = -Infinity;
  let draggingVolume = false;
  let isolatedRoot = null;
  let readyAnnounced = false;

  document.documentElement.classList.add("sv-embedded");

  // The CIME player reads its start volume from `player-volume`
  // ({ volume, muted }) when it is created. Writing a muted state here, before
  // the page scripts run, makes it start muted by itself instead of autoplaying
  // with sound until the viewer's first message arrives. (Tile frames have
  // partitioned storage, so the viewer's normal ci.me tabs keep their volume.)
  try {
    const saved = JSON.parse(localStorage.getItem("player-volume") || "null");
    const volume = typeof saved?.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : 0.5;
    localStorage.setItem("player-volume", JSON.stringify({ volume, muted: true }));
  } catch {
    // Without storage the page starts with its own default.
  }

  // "player-ready" ends the viewer's handshake, which answers with the audio
  // state. Answering every viewer message with "player-ready" again made the
  // two frames ping-pong forever and starved the player (stuck at "0%"), so
  // it is sent once per <video> and when playback starts.
  function announceReady() {
    if (readyAnnounced) return;
    readyAnnounced = true;
    post({ type: "player-ready" });
  }

  function post(message) {
    try {
      window.parent.postMessage({ source: "stellaview", ...message }, viewerOrigin);
    } catch {
      // The viewer can be closed while the frame is tearing down.
    }
  }

  function playerVideo() {
    return document.querySelector(".VideoPlayerView video, video.vjs-tech") || document.querySelector("video");
  }

  // Keep only the video player: mark the path from the player up to <body>
  // and hide every sibling along it (header, chat, recommendations).
  function isolatePlayer(video) {
    const root = video.closest(".VideoPlayerView") || video.closest(".video-js") || video.parentElement;
    if (!root || root === isolatedRoot) return;
    document.querySelectorAll(".sv-player-path, .sv-shell-hidden, .sv-player-root").forEach((element) => {
      element.classList.remove("sv-player-path", "sv-shell-hidden", "sv-player-root");
    });
    root.classList.add("sv-player-root");
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
    isolatedRoot = root;
  }

  // Audio is only touched once the player has media to play; before that the
  // stored start state above applies and the IVS player is left to start.
  const playerStarted = (video) => video.readyState >= 2;

  function applyAudio(video) {
    if (!playerStarted(video)) return;
    try {
      video.muted = desiredMuted;
      if (desiredVolume !== null && Math.abs(video.volume - desiredVolume) > 0.001) {
        video.volume = desiredVolume;
      }
      // Only resume a player that already has media; while the IVS player is
      // still attaching its stream it starts playback itself.
      if (video.paused && video.readyState >= 2) video.play().catch(() => {});
    } catch {
      // The player can replace the media element while it reconnects.
    }
  }

  // Changes made with the player's own volume controls become the requested
  // state and are mirrored in the multiview mixer; anything the page changes
  // by itself is undone.
  function keepAudio(video) {
    if (!playerStarted(video)) return;
    const mutedDiffers = video.muted !== desiredMuted;
    const volumeDiffers = desiredVolume !== null && Math.abs(video.volume - desiredVolume) > 0.01;
    if (!mutedDiffers && !volumeDiffers) return;
    if (performance.now() - lastUserInput <= USER_AUDIO_WINDOW_MS) {
      desiredMuted = video.muted;
      desiredVolume = video.volume;
      post({ type: "audio-user-changed", muted: video.muted, volume: Number(video.volume.toFixed(2)) });
      return;
    }
    const observed = { muted: video.muted, volume: Number(video.volume.toFixed(2)) };
    applyAudio(video);
    post({
      type: "audio-corrected",
      entry: { channelId: slug, observed, wanted: { muted: desiredMuted, volume: desiredVolume }, paused: video.paused },
    });
  }

  const onVolumeControl = (event) =>
    event.target instanceof Element && Boolean(event.target.closest(VOLUME_CONTROL));

  document.addEventListener("pointerdown", (event) => {
    if (!event.isTrusted) return;
    draggingVolume = onVolumeControl(event);
    if (draggingVolume) lastUserInput = performance.now();
  }, { capture: true, passive: true });
  document.addEventListener("pointermove", (event) => {
    if (event.isTrusted && draggingVolume && event.buttons) lastUserInput = performance.now();
  }, { capture: true, passive: true });
  document.addEventListener("pointerup", (event) => {
    if (event.isTrusted && draggingVolume) lastUserInput = performance.now();
    draggingVolume = false;
  }, { capture: true, passive: true });
  document.addEventListener("wheel", (event) => {
    if (event.isTrusted && onVolumeControl(event)) lastUserInput = performance.now();
  }, { capture: true, passive: true });
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || !VOLUME_KEYS.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
    lastUserInput = performance.now();
  }, true);

  let trackedVideo = null;

  // Runs once per <video> element (the page swaps it when it reconnects), not
  // on every DOM change: the page mutates constantly (chat, counters).
  function track(video) {
    isolatePlayer(video);
    if (video === trackedVideo) return;
    trackedVideo = video;
    readyAnnounced = false;
    applyAudio(video);
    video.addEventListener("volumechange", () => keepAudio(video));
    video.addEventListener("playing", () => {
      applyAudio(video);
      readyAnnounced = false;
      announceReady();
    });
    video.addEventListener("resize", () => post({ type: "quality", status: "selected", label: `${video.videoHeight}p` }));
    announceReady();
  }

  const observer = new MutationObserver(() => {
    const video = playerVideo();
    if (video && video !== trackedVideo) track(video);
  });

  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const video = playerVideo();
    if (video) track(video);
  };

  if (document.documentElement) {
    start();
  } else {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== viewerOrigin || event.data?.source !== "stellaview") {
      return;
    }
    const video = playerVideo();
    if (event.data.type === "set-muted" && typeof event.data.muted === "boolean") {
      desiredMuted = event.data.muted;
      if (video) applyAudio(video);
    }
    if (
      event.data.type === "set-volume" &&
      typeof event.data.volume === "number" &&
      event.data.volume >= 0 &&
      event.data.volume <= 1
    ) {
      desiredVolume = event.data.volume;
      if (video) applyAudio(video);
    }
    if (video) announceReady();
  });
})();
