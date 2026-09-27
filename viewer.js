import { PRESET_GROUP_ORDER, STREAM_PRESETS } from "./src/shared/members.js";
import { createGridLayout, createMosaicLayout } from "./src/shared/layout.js";
import {
  makeChzzkStream,
  makeYouTubeStream,
  parseStreamInput,
  sanitizeStream,
  streamKey,
  streamToChatUrl,
  streamToOriginalUrl,
  streamToPlayerUrl,
  youtubeClientOrigin,
} from "./src/shared/streams.js";

const DEFAULT_SETTINGS = Object.freeze({
  quality: "1080p",
  gridBypass: true,
  chatOpen: true,
  rememberSession: true,
  volumes: Object.freeze({}),
});
const FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 1_800;
const DEFAULT_VOLUME = 100;
const VOLUME_UNSUPPORTED_HINT = "이 기기에서는 볼륨 조절이 되지 않아 소리 켬/끔만 가능합니다";
const chzzkPresets = STREAM_PRESETS.filter((preset) => preset.platform === "chzzk");
const presetKeys = new Set(STREAM_PRESETS.map((preset) => streamKey(presetStream(preset))));

const body = document.body;
// The Chrome extension keeps the original desktop behaviour. The iPad and
// Android wrappers load these same files from an https origin and opt into
// the touch additions (fullscreen overlay bar, always-applied volume)
// through this class and flag.
const isWrapperHost = location.protocol !== "chrome-extension:";
body.classList.toggle("sv-wrapper", isWrapperHost);
const grid = document.querySelector("#stream-grid");
const emptyState = document.querySelector("#empty-state");
const tileTemplate = document.querySelector("#tile-template");
const memberGroups = document.querySelector("#viewer-member-groups");
const streamCount = document.querySelector("#stream-count");
const chatFrame = document.querySelector("#chat-frame");
const chatEmpty = document.querySelector("#chat-empty");
const chatTitle = document.querySelector("#chat-title");
const chatToggle = document.querySelector("#chat-toggle");
const qualitySelect = document.querySelector("#quality-select");
const layoutSelect = document.querySelector("#layout-select");
const gridBypassInput = document.querySelector("#grid-bypass");
const rememberSessionInput = document.querySelector("#remember-session");
const addForm = document.querySelector("#viewer-add-form");
const addInput = document.querySelector("#viewer-stream-input");
const formMessage = document.querySelector("#viewer-form-message");
const fullscreenButton = document.querySelector("#fullscreen");
const volumeToggle = document.querySelector("#volume-toggle");
const volumeRowList = document.querySelector("#volume-rows");
const volumeEmpty = document.querySelector("#volume-empty");
const youtubeOrigin = youtubeClientOrigin(chrome.runtime.id);

let settings = { ...DEFAULT_SETTINGS };
let streams = [];
const activeAudioKeys = new Set();
let activeChatKey = null;
let draggingKey = null;
let hasCompleteStatusSnapshot = false;
const metadata = new Map();
const tiles = new Map();
// key -> 0..100. A missing entry means the default volume on the wrappers and
// the player's own volume in the extension (see applyVolumeState).
const tileVolumes = new Map();
// key -> { supported, mode } as reported by the player frame.
const volumeCapabilities = new Map();
// key -> 0..100, the player's own volume as reported by the frame while the
// tile is untouched (extension only). Shown as the slider position so the
// first drag starts from the real level instead of jumping from 100.
const siteVolumes = new Map();
// key -> the volume panel row nodes, kept alive so a dragged slider survives
// unrelated re-renders.
const volumeRows = new Map();
let youtubeIdentityReady = false;
let fullscreenControlsTimer = null;

function frameOrigin(stream) {
  return stream.platform === "chzzk"
    ? "https://chzzk.naver.com"
    : "https://www.youtube.com";
}

function sendFullscreenControlsStateToFrame(frame, stream, hidden) {
  frame.contentWindow?.postMessage(
    {
      source: "stellaview",
      type: "fullscreen-controls",
      hidden,
    },
    frameOrigin(stream),
  );
}

function setFullscreenControlsHidden(hidden, forceFrameSync = false) {
  const changed = body.classList.contains("fullscreen-controls-hidden") !== hidden;
  body.classList.toggle("fullscreen-controls-hidden", hidden);
  if (!changed && !forceFrameSync) return;

  for (const stream of streams) {
    const frame = tiles.get(streamKey(stream))?.querySelector(".stream-frame");
    if (frame) sendFullscreenControlsStateToFrame(frame, stream, hidden);
  }
}

function clearFullscreenControlsTimer() {
  if (fullscreenControlsTimer !== null) {
    clearTimeout(fullscreenControlsTimer);
    fullscreenControlsTimer = null;
  }
}

// Chrome never sets :focus-visible on a control focused by pointer, so a held
// slider or a pointer resting on the bar looks idle to the timer. :hover and
// :active are the pointer-user signals; :focus-visible only covers the
// keyboard. A range input captures the pointer, so its moves stop arriving
// here: the press itself is tracked instead.
// Wrapper-only in effect: the extension hides the bar and the volume panel in
// fullscreen (display:none), so this and the frame-activity flag stay inert.
let fullscreenPointerHeld = false;
// The player frames are out-of-process. Once the pointer moves into one, this
// document receives nothing at all (measured in fullscreen: zero pointermove,
// pointerout and mouseout) and :hover keeps naming the bar the pointer left,
// which would hold the overlay open for good. The frames relay their own
// activity, so a relayed ping is the signal that the pointer is over a tile
// and this document's :hover has gone stale.
let fullscreenActivityFromFrame = false;

function fullscreenChromeEngaged() {
  // The extension has no fullscreen bar: only a keyboard-focused tile control
  // holds the controls open, as in the original.
  if (!isWrapperHost) return Boolean(document.querySelector(".tile-actions :focus-visible"));
  if (fullscreenPointerHeld) return true;
  if (document.querySelector(
    ".volume-panel :active, .sv-overflow :active, .topbar :focus-visible, .volume-panel :focus-visible, .sv-overflow :focus-visible, .tile-actions :focus-visible",
  )) {
    return true;
  }
  return !fullscreenActivityFromFrame
    && Boolean(document.querySelector(".topbar:hover, .volume-panel:hover, .sv-overflow:hover"));
}

// Activity this document saw itself, which makes :hover trustworthy again.
function notePointerActivity(event) {
  // A release can be lost to the OS app switcher or a context menu, so the
  // held flag is also derived from the next move that reports no button down.
  if (event?.type === "pointermove" && event.buttons === 0) fullscreenPointerHeld = false;
  fullscreenActivityFromFrame = false;
  noteFullscreenActivity();
}

function noteFullscreenActivity() {
  if (document.fullscreenElement !== document.documentElement) return;
  setFullscreenControlsHidden(false);
  clearFullscreenControlsTimer();
  fullscreenControlsTimer = setTimeout(() => {
    fullscreenControlsTimer = null;
    if (document.fullscreenElement === document.documentElement) {
      if (fullscreenChromeEngaged()) {
        noteFullscreenActivity();
      } else {
        setFullscreenControlsHidden(true);
      }
    }
  }, FULLSCREEN_CONTROLS_HIDE_DELAY_MS);
}

async function prepareYoutubeIdentity() {
  if (youtubeIdentityReady) return;
  const response = await chrome.runtime.sendMessage({
    type: "prepare-youtube-player",
  });
  if (!response?.ok || !response.origin || response.origin !== youtubeOrigin) {
    throw new Error(
      response?.error || "YouTube 플레이어를 준비하지 못했습니다. 확장 프로그램을 새로고침해 주세요.",
    );
  }
  youtubeIdentityReady = true;
}

function safeStream(value) {
  try {
    return sanitizeStream(value);
  } catch {
    return null;
  }
}

function uniqueStreams(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const stream = safeStream(value);
    if (!stream) continue;
    const key = streamKey(stream);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(stream);
  }
  return result;
}

function getStream(key) {
  return streams.find((stream) => streamKey(stream) === key) || null;
}

function displayName(stream) {
  if (stream.name) return stream.name;
  if (stream.platform === "chzzk") return stream.videoId ? "치지직 다시보기" : metadata.get(stream.channelId)?.name || "치지직 방송";
  return "YouTube";
}

function setFormMessage(message, success = false) {
  formMessage.textContent = message;
  formMessage.classList.toggle("is-success", success);
}

function formatViewers(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}명 시청 중` : "방송 중";
}

async function saveSettings() {
  // Volumes live in a Map at runtime. The stored copy is merged, not replaced:
  // another viewer tab may have set tiles this one never showed, and a settings
  // write from here (chat toggle, quality) must not wipe those.
  const stored = await chrome.storage.local.get({ settings: {} });
  settings.volumes = { ...sanitizeVolumes(stored.settings?.volumes), ...volumesToObject() };
  await chrome.storage.local.set({ settings });
}

async function saveStreams() {
  if (settings.rememberSession) {
    await chrome.storage.local.set({ selectedStreams: streams });
  } else {
    await chrome.storage.local.remove("selectedStreams");
  }
}

async function setStreams(nextStreams) {
  streams = uniqueStreams(nextStreams);
  for (const key of activeAudioKeys) {
    if (!getStream(key)) activeAudioKeys.delete(key);
  }
  pruneVolumeState();
  if (activeChatKey && !getStream(activeChatKey)) {
    activeChatKey = null;
    closeChatContent();
  }
  reconcileTiles();
  renderMemberLibrary();
  updateSummary();
  updateLayout();
  await saveStreams();
}

function createAvatar(member, meta) {
  const avatar = document.createElement("span");
  avatar.className = "viewer-avatar";
  avatar.textContent = member.name.slice(-2);
  if (meta?.image) {
    const image = document.createElement("img");
    image.src = meta.image;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    avatar.append(image);
  }
  return avatar;
}

function presetStream(preset) {
  return preset.platform === "youtube"
    ? makeYouTubeStream(preset.channelId, preset.name)
    : makeChzzkStream(preset.channelId, preset.name);
}

function renderMemberLibrary() {
  const selected = new Set(streams.map(streamKey));
  memberGroups.replaceChildren();

  for (const group of PRESET_GROUP_ORDER) {
    const section = document.createElement("section");
    section.className = "viewer-group";
    const heading = document.createElement("h3");
    heading.textContent = group;
    section.append(heading);

    for (const member of STREAM_PRESETS.filter((item) => item.group === group)) {
      const memberValue = presetStream(member);
      const meta = member.platform === "chzzk" ? metadata.get(member.channelId) : null;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `viewer-member${meta?.open ? " is-live" : ""}`;
      button.style.setProperty("--member-accent", member.accent);
      button.setAttribute("aria-pressed", String(selected.has(streamKey(memberValue))));

      const avatar = createAvatar(member, meta);
      const copy = document.createElement("span");
      copy.className = "viewer-member-copy";
      const name = document.createElement("strong");
      name.textContent = member.name;
      const detail = document.createElement("small");
      detail.textContent = member.platform === "youtube"
        ? "YouTube 라이브 채널"
        : meta?.open
          ? meta.title || meta.category || "방송 중"
          : "";
      copy.append(name, detail);
      const state = document.createElement("span");
      state.className = "viewer-member-state";
      state.textContent = member.platform === "youtube" ? "YT" : meta?.open ? "LIVE" : meta ? "OFF" : "…";
      button.append(avatar, copy, state);
      button.addEventListener("click", async () => {
        try {
          await toggleMember(memberValue);
        } catch (error) {
          setFormMessage(error?.message || "방송을 추가하지 못했습니다.");
        }
      });
      section.append(button);
    }
    memberGroups.append(section);
  }
}

async function toggleMember(stream) {
  const key = streamKey(stream);
  if (getStream(key)) {
    await setStreams(streams.filter((item) => streamKey(item) !== key));
  } else {
    if (stream.platform === "youtube") await prepareYoutubeIdentity();
    await setStreams([...streams, stream]);
  }
  closeCompactPanels();
}

function playerOptions() {
  return {
    quality: settings.quality,
    gridBypass: settings.gridBypass,
    // YouTube uses the actual parent origin to authenticate JS API commands.
    // The separate HTTPS-shaped app identity is supplied as the HTTP Referer
    // by the background rule for environments where Referer is otherwise empty.
    origin: location.origin,
  };
}

function updateTileText(tile, stream) {
  const meta = stream.platform === "chzzk" ? metadata.get(stream.channelId) : null;
  tile.querySelector(".tile-name").textContent = meta?.name || displayName(stream);
  tile.querySelector(".tile-subtitle").textContent = meta?.open
    ? `${meta.title || meta.category || "방송 중"} · ${formatViewers(meta.viewers)}`
    : stream.platform === "chzzk" && stream.videoId
      ? "다시보기"
      : stream.platform === "chzzk"
      ? meta ? "현재 오프라인" : "치지직"
      : "YouTube";
}

function startChzzkHandshake(tile, stream) {
  if (stream.platform !== "chzzk") return;
  tile.dataset.playerReady = "0";
  let attempts = 0;
  let wasConnected = false;
  const handshake = () => {
    if (tile.isConnected) wasConnected = true;
    if (wasConnected && !tile.isConnected) return;
    applyAudioState(tile, stream);
    attempts += 1;
    if (tile.dataset.playerReady !== "1" && attempts < 240) {
      setTimeout(handshake, 500);
    }
  };
  setTimeout(handshake, 50);
}

function createTile(stream) {
  const key = streamKey(stream);
  const tile = tileTemplate.content.firstElementChild.cloneNode(true);
  const frame = tile.querySelector(".stream-frame");
  const platform = tile.querySelector(".platform-pill");

  tile.dataset.key = key;
  frame.title = `${displayName(stream)} 방송`;
  if (stream.platform === "youtube") {
    frame.referrerPolicy = "strict-origin-when-cross-origin";
  }
  frame.src = streamToPlayerUrl(stream, playerOptions());
  platform.textContent = stream.platform === "chzzk" ? "CHZZK" : "YOUTUBE";
  platform.classList.toggle("youtube", stream.platform === "youtube");
  updateTileText(tile, stream);

  tile.querySelector(".tile-actions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    event.stopPropagation();
    handleTileAction(key, button.dataset.action);
  });

  frame.addEventListener("load", () => {
    setTimeout(() => applyAudioState(tile, stream), 120);
    sendFullscreenControlsStateToFrame(
      frame,
      stream,
      body.classList.contains("fullscreen-controls-hidden"),
    );
  });

  startChzzkHandshake(tile, stream);

  const dragHandle = tile.querySelector(".drag-handle");
  // Cross-origin stream frames swallow mouse/drag events. Unless their hit
  // testing is off before the gesture crosses them, Chromium never even fires
  // dragstart, so the frames are disabled from pointerdown, not dragstart
  // (see body.is-reordering in CSS; released on pointerup/dragend).
  dragHandle.addEventListener("pointerdown", () => {
    body.classList.add("is-reordering");
  });
  dragHandle.addEventListener("dragstart", (event) => {
    draggingKey = key;
    tile.classList.add("is-dragging");
    body.classList.add("is-reordering");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
  });
  dragHandle.addEventListener("dragend", () => {
    draggingKey = null;
    tile.classList.remove("is-dragging");
    body.classList.remove("is-reordering");
    document.querySelectorAll(".drag-target").forEach((item) => item.classList.remove("drag-target"));
  });
  tile.addEventListener("dragover", (event) => {
    if (!draggingKey || draggingKey === key) return;
    event.preventDefault();
    tile.classList.add("drag-target");
  });
  tile.addEventListener("dragleave", () => tile.classList.remove("drag-target"));
  tile.addEventListener("drop", async (event) => {
    event.preventDefault();
    tile.classList.remove("drag-target");
    if (!draggingKey || draggingKey === key) return;
    const from = streams.findIndex((item) => streamKey(item) === draggingKey);
    const to = streams.findIndex((item) => streamKey(item) === key);
    if (from < 0 || to < 0) return;
    const reordered = [...streams];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    await setStreams(reordered);
  });

  return tile;
}

function reconcileTiles() {
  const wanted = new Set(streams.map(streamKey));
  for (const [key, tile] of tiles) {
    if (wanted.has(key)) continue;
    tile.remove();
    tiles.delete(key);
  }

  for (const stream of streams) {
    const key = streamKey(stream);
    let tile = tiles.get(key);
    if (!tile) {
      tile = createTile(stream);
      tiles.set(key, tile);
    } else {
      updateTileText(tile, stream);
    }
    grid.append(tile);
  }

  emptyState.hidden = streams.length > 0;
  if (!emptyState.hidden) grid.append(emptyState);
  renderVolumePanel();
  updateAudioClasses();
}

function reloadTile(key) {
  const tile = tiles.get(key);
  const stream = getStream(key);
  if (!tile || !stream) return;
  const frame = tile.querySelector(".stream-frame");
  const quality = tile.querySelector(".quality-pill");
  quality.textContent = "다시 불러오는 중";
  quality.classList.remove("is-ready");
  frame.src = streamToPlayerUrl(stream, playerOptions());
  startChzzkHandshake(tile, stream);
}

function handleTileAction(key, action) {
  const stream = getStream(key);
  if (!stream) return;
  switch (action) {
    case "audio":
      setTileAudio(key, !activeAudioKeys.has(key));
      break;
    case "chat":
      openChat(key);
      break;
    case "reload":
      reloadTile(key);
      break;
    case "open":
      chrome.tabs.create({ url: streamToOriginalUrl(stream) });
      break;
    case "remove":
      setStreams(streams.filter((item) => streamKey(item) !== key));
      break;
  }
}

function sendChzzkCommand(frame, payload) {
  frame.contentWindow?.postMessage({ source: "stellaview", ...payload }, "https://chzzk.naver.com");
}

function sendYouTubeCommand(frame, muted) {
  const command = {
    event: "command",
    func: muted ? "mute" : "unMute",
    args: [],
  };
  frame.contentWindow?.postMessage(JSON.stringify(command), "https://www.youtube.com");
}

// Two messages on purpose. On Chrome both act: the IFrame API command updates
// YouTube's own volume model, and the frame script applies the element volume,
// reports whether that worked and keeps the model in sync. On the wrappers the
// API volume is ignored and only the frame script does anything.
function sendYouTubeVolume(frame, volume) {
  const command = {
    event: "command",
    func: "setVolume",
    args: [volume],
  };
  frame.contentWindow?.postMessage(JSON.stringify(command), "https://www.youtube.com");
  frame.contentWindow?.postMessage(
    { source: "stellaview", type: "set-volume", volume: volume / 100 },
    "https://www.youtube.com",
  );
}

function applyAudioState(tile, stream) {
  const muted = !activeAudioKeys.has(streamKey(stream));
  const frame = tile.querySelector(".stream-frame");
  if (stream.platform === "chzzk") {
    sendChzzkCommand(frame, { type: "set-muted", muted });
  } else {
    sendYouTubeCommand(frame, muted);
  }
  // Every audio handshake also restores the selected volume: player-ready,
  // frame load, reload and unmute all reach the frame through this call.
  applyVolumeState(tile, stream);
}

function clampVolume(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_VOLUME;
  return Math.min(100, Math.max(0, number));
}

// Stored settings are untrusted: only integral in-range numbers survive, and
// every other entry falls back to the default volume.
function sanitizeVolumes(raw) {
  const result = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < 0 || value > 100) continue;
    result[key] = Math.round(value);
  }
  return result;
}

function volumesToObject() {
  const result = {};
  for (const [key, value] of tileVolumes) result[key] = value;
  return result;
}

function getTileVolume(key) {
  return tileVolumes.has(key) ? tileVolumes.get(key) : DEFAULT_VOLUME;
}

function setTileVolume(key, value) {
  const volume = clampVolume(value);
  tileVolumes.set(key, volume);
  const tile = tiles.get(key);
  const stream = getStream(key);
  if (tile && stream) applyVolumeState(tile, stream);
  updateVolumeRow(key);
  return volume;
}

// Set volumes are kept per stream key even after the tile is removed, so a
// member toggled off and on (or re-added after a restart) gets its level back.
// Only the frame reports, which belong to a live frame, are dropped.
function pruneVolumeState() {
  for (const key of [...volumeCapabilities.keys()]) {
    if (!getStream(key)) volumeCapabilities.delete(key);
  }
  for (const key of [...siteVolumes.keys()]) {
    if (!getStream(key)) siteVolumes.delete(key);
  }
}

function applyVolumeState(tile, stream) {
  // The extension leaves the player's own volume (and its saved level) alone
  // until the panel slider for that tile is moved. The wrappers keep applying
  // the panel value, default included, on every handshake.
  if (!isWrapperHost && !tileVolumes.has(streamKey(stream))) return;
  const frame = tile.querySelector(".stream-frame");
  if (!frame) return;
  const volume = getTileVolume(streamKey(stream));
  if (stream.platform === "chzzk") {
    sendChzzkCommand(frame, { type: "set-volume", volume: volume / 100 });
  } else {
    sendYouTubeVolume(frame, volume);
  }
}

function updateAudioClasses() {
  for (const [key, tile] of tiles) {
    const active = activeAudioKeys.has(key);
    tile.classList.toggle("is-audio-active", active);
    const button = tile.querySelector('[data-action="audio"]');
    button.textContent = active ? "소리 켬" : "소리";
    button.setAttribute("aria-pressed", String(active));
  }
  updateVolumeRows();
}

function createVolumeRow(key) {
  const root = document.createElement("div");
  root.className = "volume-row";
  root.dataset.key = key;

  const head = document.createElement("div");
  head.className = "volume-row-head";
  const name = document.createElement("span");
  name.className = "volume-row-name";
  const mute = document.createElement("button");
  mute.type = "button";
  mute.className = "volume-mute";
  mute.addEventListener("click", () => setTileAudio(key, !activeAudioKeys.has(key)));
  head.append(name, mute);

  const controls = document.createElement("div");
  controls.className = "volume-row-controls";
  const range = document.createElement("input");
  range.type = "range";
  range.className = "volume-range";
  range.min = "0";
  range.max = "100";
  range.step = "1";
  const value = document.createElement("span");
  value.className = "volume-value";
  range.addEventListener("input", () => setTileVolume(key, range.value));
  range.addEventListener("change", async () => {
    setTileVolume(key, range.value);
    await saveSettings();
  });
  controls.append(range, value);

  const hint = document.createElement("p");
  hint.className = "volume-hint";
  hint.textContent = VOLUME_UNSUPPORTED_HINT;
  hint.hidden = true;

  root.append(head, controls, hint);
  return { root, name, mute, range, value, hint };
}

function updateVolumeRow(key) {
  const row = volumeRows.get(key);
  const stream = getStream(key);
  if (!row || !stream) return;
  const meta = stream.platform === "chzzk" ? metadata.get(stream.channelId) : null;
  row.name.textContent = meta?.name || displayName(stream);

  const active = activeAudioKeys.has(key);
  row.mute.textContent = active ? "소리 켬" : "소리";
  row.mute.setAttribute("aria-pressed", String(active));
  row.mute.setAttribute("aria-label", `${row.name.textContent} 소리`);

  // In the extension an untouched tile keeps the player's own volume, so the
  // row says so instead of claiming 100%, and the thumb sits at the level the
  // frame reported so the first drag starts from there.
  const untouched = !isWrapperHost && !tileVolumes.has(key);
  const site = siteVolumes.get(key);
  const volume = untouched && site !== undefined ? site : getTileVolume(key);
  // Writing the same value back is a no-op, so an in-progress drag keeps its
  // thumb position.
  if (row.range.value !== String(volume)) row.range.value = String(volume);
  row.range.setAttribute("aria-label", `${row.name.textContent} 볼륨`);
  if (untouched) {
    row.value.textContent = site === undefined ? "기본" : `기본 ${site}%`;
    row.range.title = "플레이어 자체 볼륨을 그대로 둡니다. 움직이면 이 값이 적용됩니다.";
  } else {
    row.value.textContent = `${volume}%`;
    row.range.removeAttribute("title");
  }

  const capability = volumeCapabilities.get(key);
  const unsupported = capability?.supported === false;
  row.range.disabled = unsupported;
  row.hint.hidden = !unsupported;
}

function updateVolumeRows() {
  for (const key of volumeRows.keys()) updateVolumeRow(key);
}

function renderVolumePanel() {
  streams.forEach((stream, index) => {
    const key = streamKey(stream);
    let row = volumeRows.get(key);
    if (!row) {
      row = createVolumeRow(key);
      volumeRows.set(key, row);
    }
    // Only move a row that is actually out of place; re-inserting a node would
    // cancel a slider drag.
    if (volumeRowList.children[index] !== row.root) {
      volumeRowList.insertBefore(row.root, volumeRowList.children[index] || null);
    }
    updateVolumeRow(key);
  });

  for (const [key, row] of volumeRows) {
    if (getStream(key)) continue;
    row.root.remove();
    volumeRows.delete(key);
  }
  volumeEmpty.hidden = streams.length > 0;
}

function setVolumePanelOpen(open) {
  body.classList.toggle("volume-panel-open", open);
  volumeToggle.setAttribute("aria-pressed", String(open));
  volumeToggle.setAttribute("aria-expanded", String(open));
  if (open) renderVolumePanel();
}

// The frame's own level, 0..1, reported while no panel value applies.
function setSiteVolume(key, volume) {
  if (typeof volume !== "number" || !Number.isFinite(volume)) return;
  siteVolumes.set(key, clampVolume(volume * 100));
  updateVolumeRow(key);
}

function setVolumeCapability(key, data) {
  volumeCapabilities.set(key, {
    supported: data.supported !== false,
    mode: typeof data.mode === "string" ? data.mode : "none",
  });
  updateVolumeRow(key);
}

async function setAllVolumes(volume) {
  for (const stream of streams) setTileVolume(streamKey(stream), volume);
  await saveSettings();
}

function setTileAudio(key, enabled) {
  const stream = getStream(key);
  const tile = tiles.get(key);
  if (!stream || !tile) return;
  if (enabled) activeAudioKeys.add(key);
  else activeAudioKeys.delete(key);
  applyAudioState(tile, stream);
  updateAudioClasses();
}

function muteAll() {
  activeAudioKeys.clear();
  for (const stream of streams) {
    const tile = tiles.get(streamKey(stream));
    if (tile) applyAudioState(tile, stream);
  }
  updateAudioClasses();
}

function setChatVisibility(open) {
  settings.chatOpen = open;
  applyChatVisibility(open);
  saveSettings();
}

// Visibility without persistence. Compact mode hides the chat overlay when it
// takes over and restores the stored preference when it hands back, so a
// folded phone never starts with the chat covering the grid.
function applyChatVisibility(open) {
  body.classList.toggle("chat-hidden", !open);
  chatToggle.setAttribute("aria-pressed", String(open));
  if (open) setOverflowOpen(false);
  updateLayout();
}

function closeChatContent() {
  chatFrame.src = "about:blank";
  chatFrame.hidden = true;
  chatEmpty.hidden = false;
  chatTitle.textContent = "채팅을 선택하세요";
}

function openChat(key) {
  const stream = getStream(key);
  if (!stream) return;
  const url = streamToChatUrl(stream, { embedDomain: location.hostname });
  activeChatKey = key;
  setChatVisibility(true);
  chatTitle.textContent = displayName(stream);
  if (!url) {
    chatFrame.hidden = true;
    chatEmpty.hidden = false;
    chatEmpty.querySelector("p").textContent = "이 방송은 내장 채팅 주소를 확인할 수 없습니다. 원본 방송에서 채팅을 열어 주세요.";
    return;
  }
  chatEmpty.hidden = true;
  chatFrame.hidden = false;
  chatFrame.src = url;
}

function updateSummary() {
  streamCount.textContent = `${streams.length} stream${streams.length === 1 ? "" : "s"}`;
}

function updateLayout() {
  const layout = layoutSelect.value === "auto"
    ? createMosaicLayout(
        streams.length,
        Math.max(grid.clientWidth, 1),
        Math.max(grid.clientHeight, 1),
      )
    : createGridLayout(
        streams.length,
        Math.min(Number(layoutSelect.value) || 1, Math.max(streams.length, 1)),
        true,
      );
  grid.style.setProperty("--grid-track-columns", String(layout.trackColumns));
  grid.style.setProperty("--grid-rows", String(layout.rows));
  streams.forEach((stream, index) => {
    const tile = tiles.get(streamKey(stream));
    if (!tile) return;
    const span = layout.spans[index] || 1;
    tile.style.gridColumn = span > 1 ? `span ${span}` : "";
  });
  // The fullscreen overlay bar (wrappers only) covers the first grid row, so
  // only those tiles move their header down. Measured after the grid styles
  // apply so it holds for mosaic rows and fixed column counts alike.
  const overlayActive = isWrapperHost && body.classList.contains("fullscreen-view");
  const gridTop = grid.getBoundingClientRect().top;
  for (const tile of tiles.values()) {
    tile.classList.toggle("is-top-row", overlayActive && tile.getBoundingClientRect().top - gridTop < 1);
  }
}

async function refreshStatuses() {
  const channelIds = new Set(chzzkPresets.map((member) => member.channelId));
  for (const stream of streams) {
    if (stream.platform === "chzzk" && stream.channelId) channelIds.add(stream.channelId);
  }

  const succeeded = new Set();
  await Promise.allSettled([...channelIds].map(async (channelId) => {
    const response = await chrome.runtime.sendMessage({ type: "fetch-chzzk-meta", channelId });
    if (response?.ok && response.meta) {
      metadata.set(channelId, response.meta);
      succeeded.add(channelId);
    }
  }));
  hasCompleteStatusSnapshot = chzzkPresets.every((member) => succeeded.has(member.channelId));
  renderMemberLibrary();
  for (const stream of streams) {
    const tile = tiles.get(streamKey(stream));
    if (tile) updateTileText(tile, stream);
  }
  updateVolumeRows();
  return hasCompleteStatusSnapshot;
}

async function resolveStream(input) {
  let stream = parseStreamInput(input);
  if (!stream) throw new Error("지원하는 치지직 또는 YouTube 주소가 아닙니다.");
  if (stream.needsResolution) {
    const response = await chrome.runtime.sendMessage({ type: "resolve-youtube", input });
    if (!response?.ok || !response.stream) {
      throw new Error(response?.error || "현재 라이브 영상을 찾지 못했습니다.");
    }
    stream = response.stream;
  }
  stream = safeStream(stream);
  if (!stream) throw new Error("방송 주소를 안전하게 해석하지 못했습니다.");
  if (stream.platform === "youtube") await prepareYoutubeIdentity();
  if (stream.platform === "chzzk" && stream.channelId && !stream.name) {
    const response = await chrome.runtime.sendMessage({ type: "fetch-chzzk-meta", channelId: stream.channelId });
    if (response?.ok && response.meta) {
      metadata.set(stream.channelId, response.meta);
      stream = { ...stream, name: response.meta.name || undefined };
    }
  }
  return stream;
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = addInput.value.trim();
  if (!input) return;
  setFormMessage("방송 주소를 확인하고 있습니다…");
  try {
    const stream = await resolveStream(input);
    if (getStream(streamKey(stream))) throw new Error("이미 분할 화면에 있는 방송입니다.");
    await setStreams([...streams, stream]);
    addInput.value = "";
    setFormMessage(`${displayName(stream)}을 추가했습니다.`, true);
    closeCompactPanels();
  } catch (error) {
    setFormMessage(error?.message || "방송을 추가하지 못했습니다.");
  }
});

const sidebarToggle = document.querySelector("#sidebar-toggle");

function setSidebarOpen(open) {
  body.classList.toggle("sidebar-hidden", !open);
  sidebarToggle.setAttribute("aria-expanded", String(open));
  updateLayout();
}

sidebarToggle.addEventListener("click", () => {
  setSidebarOpen(body.classList.contains("sidebar-hidden"));
});

document.querySelector("#empty-open-sidebar").addEventListener("click", () => setSidebarOpen(true));

document.querySelector("#refresh-status").addEventListener("click", refreshStatuses);

document.querySelector("#viewer-select-live").addEventListener("click", async () => {
  if (!(await refreshStatuses())) {
    setFormMessage("멤버 방송 상태를 모두 확인하지 못했습니다. 현재 화면은 변경하지 않았습니다.");
    return;
  }
  const custom = streams.filter(
    (stream) => stream.platform !== "chzzk" || !presetKeys.has(streamKey(stream)),
  );
  const liveMembers = chzzkPresets
    .filter((member) => metadata.get(member.channelId)?.open)
    .map((member) => makeChzzkStream(member.channelId, member.name));
  await setStreams([...liveMembers, ...custom]);
  closeCompactPanels();
});

document.querySelector("#viewer-clear").addEventListener("click", () => setStreams([]));
document.querySelector("#mute-all").addEventListener("click", muteAll);
volumeToggle.addEventListener("click", () => {
  setVolumePanelOpen(!body.classList.contains("volume-panel-open"));
});
document.querySelector("#volume-panel-close").addEventListener("click", () => setVolumePanelOpen(false));
document.querySelector("#volume-mute-all").addEventListener("click", muteAll);
document.querySelector("#volume-max-all").addEventListener("click", () => setAllVolumes(100));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (body.classList.contains("volume-panel-open")) setVolumePanelOpen(false);
  setOverflowOpen(false);
});
chatToggle.addEventListener("click", () => setChatVisibility(body.classList.contains("chat-hidden")));
document.querySelector("#chat-close").addEventListener("click", () => setChatVisibility(false));

qualitySelect.addEventListener("change", async () => {
  settings.quality = qualitySelect.value;
  await saveSettings();
  for (const stream of streams) {
    if (stream.platform === "chzzk") reloadTile(streamKey(stream));
  }
});

layoutSelect.addEventListener("change", updateLayout);

gridBypassInput.addEventListener("change", async () => {
  settings.gridBypass = gridBypassInput.checked;
  await saveSettings();
  for (const stream of streams) {
    if (stream.platform === "chzzk") reloadTile(streamKey(stream));
  }
});

rememberSessionInput.addEventListener("change", async () => {
  settings.rememberSession = rememberSessionInput.checked;
  await saveSettings();
  await saveStreams();
});

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      await document.documentElement.requestFullscreen();
    }
  }
});

document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === document.documentElement;
  body.classList.toggle("fullscreen-view", active);
  fullscreenButton.setAttribute("aria-label", active ? "전체 화면 종료" : "전체 화면");
  fullscreenButton.title = active ? "Esc로 전체 화면 종료" : "전체 화면";
  clearFullscreenControlsTimer();
  fullscreenPointerHeld = false;
  if (active) {
    // The #fullscreen button keeps focus after the click. The extension hides
    // the bar, so Space/Enter would exit again; on the wrappers a focused bar
    // control would keep the overlay pinned.
    if (document.activeElement?.closest?.(".topbar")) document.activeElement.blur();
    // The extension hides the panel in fullscreen, as it hides the bar.
    if (!isWrapperHost) setVolumePanelOpen(false);
    setFullscreenControlsHidden(false, true);
    noteFullscreenActivity();
  } else {
    setFullscreenControlsHidden(false, true);
  }
  requestAnimationFrame(updateLayout);
});

window.addEventListener("pointermove", notePointerActivity, {
  capture: true,
  passive: true,
});
window.addEventListener("pointerdown", notePointerActivity, {
  capture: true,
  passive: true,
});
window.addEventListener("pointerdown", (event) => {
  fullscreenPointerHeld = Boolean(event.target?.closest?.(".topbar, .volume-panel, .sv-overflow"));
}, { capture: true, passive: true });
window.addEventListener("blur", () => { fullscreenPointerHeld = false; });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) fullscreenPointerHeld = false;
});
window.addEventListener("contextmenu", () => { fullscreenPointerHeld = false; }, true);
window.addEventListener("keydown", noteFullscreenActivity, true);
window.addEventListener("focusin", noteFullscreenActivity, true);

// A handle press that never became a drag must re-enable the stream frames
// (a real drag ends through the handle's dragend instead).
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
    fullscreenPointerHeld = false;
    if (!draggingKey) body.classList.remove("is-reordering");
  }, true);
}

window.addEventListener("message", (event) => {
  const entry = [...tiles.entries()].find(([, tile]) => tile.querySelector("iframe").contentWindow === event.source);
  if (!entry) return;
  const [key, tile] = entry;
  const stream = getStream(key);
  if (!stream || event.origin !== frameOrigin(stream)) return;

  if (
    event.data?.source === "stellaview-frame" &&
    event.data.type === "viewer-activity"
  ) {
    // Only a relayed pointer event means the pointer is inside that frame and
    // this document's :hover is stale. A keydown or a focusin in a background
    // player says nothing about where the pointer rests, so it must not
    // discard a :hover the user is holding on the bar.
    if (event.data.kind === "pointermove" || event.data.kind === "pointerdown") {
      fullscreenActivityFromFrame = true;
    }
    noteFullscreenActivity();
    return;
  }

  // Volume capability and the untouched level are the only reports a YouTube
  // frame may send. They arrive from the frame script under its own source
  // tag; the sender window and origin were already matched to this tile above.
  if (event.data?.type === "volume-capability" || event.data?.type === "volume-state") {
    const expected = stream.platform === "chzzk" ? "stellaview" : "stellaview-youtube";
    if (event.data.source !== expected) return;
    if (event.data.type === "volume-capability") setVolumeCapability(key, event.data);
    else setSiteVolume(key, event.data.volume);
    return;
  }

  if (event.data?.source !== "stellaview" || stream.platform !== "chzzk") return;

  if (event.data.type === "player-ready") {
    tile.dataset.playerReady = "1";
    applyAudioState(tile, stream);
  }
  if (event.data.type === "quality") {
    const badge = tile.querySelector(".quality-pill");
    badge.textContent = event.data.label || event.data.status || settings.quality;
    badge.classList.toggle(
      "is-ready",
      event.data.status === "selected" || event.data.status === "already" || event.data.status === "fallback",
    );
  }
});

new ResizeObserver(updateLayout).observe(grid);
// The wrapper adapter signals its CSS fullscreen transitions (enter app
// fullscreen, enter or switch a tile fullscreen, exit) through a synthetic
// resize: the grid box is identical across those states, so the observer
// above never fires and the top-row marking would stay on the old tile. A
// tile raised to fixed inset:0 has the same rect top as the fixed grid, so
// recomputing here moves is-top-row onto it and leaving fullscreen clears it.
window.addEventListener("resize", updateLayout, { passive: true });

// ------------------------------------------------------------- compact UI ---
// Narrow viewports (a folded phone, a cover screen) get a touch layout: the
// sidebar and the chat become overlays and the secondary top-bar controls move
// into a 더보기 popover. The wrappers switch on width alone, as they always
// did; the extension also requires (hover: none) so a narrow desktop window
// keeps the original layout. body.sv-compact is what viewer.css keys every
// compact rule on, so this query is the only switch. Folding and unfolding
// change the width live, so the switch listens for changes.
const COMPACT_MEDIA_QUERY = isWrapperHost ? "(max-width: 720px)" : "(max-width: 720px) and (hover: none)";
const compactMedia = window.matchMedia(COMPACT_MEDIA_QUERY);
// Controls that live in the top bar when wide and in the popover when compact.
const overflowControls = [
  qualitySelect.closest(".compact-field"),
  layoutSelect.closest(".compact-field"),
  document.querySelector("#mute-all"),
  chatToggle,
].filter(Boolean);
// control -> the comment node holding its place in the top bar.
const overflowSlots = new Map();
let compactActive = null;
let wideSidebarOpen = true;

const overflowToggle = document.createElement("button");
overflowToggle.id = "sv-overflow-toggle";
overflowToggle.className = "icon-button";
overflowToggle.type = "button";
overflowToggle.textContent = "⋯";
overflowToggle.title = "더보기";
overflowToggle.setAttribute("aria-label", "더보기");
overflowToggle.setAttribute("aria-expanded", "false");
overflowToggle.setAttribute("aria-controls", "sv-overflow");
fullscreenButton.before(overflowToggle);

const overflowPanel = document.createElement("div");
overflowPanel.id = "sv-overflow";
overflowPanel.className = "sv-overflow";
overflowPanel.setAttribute("role", "group");
overflowPanel.setAttribute("aria-label", "더보기");
document.querySelector(".topbar").after(overflowPanel);

// One backdrop for every compact overlay: tapping it dismisses whatever is on
// top of the grid. It is transparent when only the popover is open.
const compactScrim = document.createElement("div");
compactScrim.id = "sv-scrim";
compactScrim.className = "sv-scrim";
body.append(compactScrim);

function isCompact() {
  return compactMedia.matches;
}

function setOverflowOpen(open) {
  const next = Boolean(open) && body.classList.contains("sv-compact");
  body.classList.toggle("sv-overflow-open", next);
  overflowToggle.setAttribute("aria-expanded", String(next));
}

/** Closes whatever the compact layout stacks over the grid. */
function closeCompactPanels() {
  if (!body.classList.contains("sv-compact")) return;
  setOverflowOpen(false);
  setSidebarOpen(false);
}

function moveOverflowControls(intoPopover) {
  for (const control of overflowControls) {
    let slot = overflowSlots.get(control);
    if (!slot) {
      slot = document.createComment("sv-overflow-slot");
      overflowSlots.set(control, slot);
    }
    if (intoPopover) {
      if (!slot.isConnected) control.before(slot);
      overflowPanel.append(control);
    } else if (slot.isConnected) {
      slot.replaceWith(control);
    }
  }
}

function applyCompactMode(compact) {
  if (compactActive === compact) return;
  compactActive = compact;
  body.classList.toggle("sv-compact", compact);
  setOverflowOpen(false);
  moveOverflowControls(compact);
  if (compact) {
    wideSidebarOpen = !body.classList.contains("sidebar-hidden");
    setSidebarOpen(false);
    applyChatVisibility(false);
  } else {
    setSidebarOpen(wideSidebarOpen);
    applyChatVisibility(settings.chatOpen);
  }
  updateLayout();
}

overflowToggle.addEventListener("click", () => {
  setOverflowOpen(!body.classList.contains("sv-overflow-open"));
});

compactScrim.addEventListener("click", () => {
  setOverflowOpen(false);
  setSidebarOpen(false);
  if (!body.classList.contains("chat-hidden")) setChatVisibility(false);
});

compactMedia.addEventListener("change", (event) => applyCompactMode(event.matches));
applyCompactMode(compactMedia.matches);

async function initialize() {
  const stored = await chrome.storage.local.get({
    selectedStreams: [],
    settings: DEFAULT_SETTINGS,
  });
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  settings.volumes = sanitizeVolumes(settings.volumes);
  tileVolumes.clear();
  for (const [key, volume] of Object.entries(settings.volumes)) tileVolumes.set(key, volume);
  streams = uniqueStreams(stored.selectedStreams || []);

  if (streams.some((stream) => stream.platform === "youtube")) {
    try {
      await prepareYoutubeIdentity();
    } catch (error) {
      console.error("Failed to prepare YouTube player", error);
      setFormMessage(error?.message || "YouTube 플레이어를 준비하지 못했습니다.");
    }
  }

  qualitySelect.value = settings.quality;
  gridBypassInput.checked = settings.gridBypass;
  rememberSessionInput.checked = settings.rememberSession;
  applyChatVisibility(settings.chatOpen && !isCompact());
  setVolumePanelOpen(false);

  renderMemberLibrary();
  reconcileTiles();
  updateSummary();
  updateLayout();
  refreshStatuses();
}

initialize();
