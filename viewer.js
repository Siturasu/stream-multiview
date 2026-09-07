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
});
const FULLSCREEN_CONTROLS_HIDE_DELAY_MS = 1_800;
const chzzkPresets = STREAM_PRESETS.filter((preset) => preset.platform === "chzzk");
const presetKeys = new Set(STREAM_PRESETS.map((preset) => streamKey(presetStream(preset))));

const body = document.body;
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
const youtubeOrigin = youtubeClientOrigin(chrome.runtime.id);

let settings = { ...DEFAULT_SETTINGS };
let streams = [];
let activeAudioKey = null;
let activeChatKey = null;
let draggingKey = null;
let hasCompleteStatusSnapshot = false;
const metadata = new Map();
const tiles = new Map();
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

function noteFullscreenActivity() {
  if (document.fullscreenElement !== document.documentElement) return;
  setFullscreenControlsHidden(false);
  clearFullscreenControlsTimer();
  fullscreenControlsTimer = setTimeout(() => {
    fullscreenControlsTimer = null;
    if (document.fullscreenElement === document.documentElement) {
      const focusedControl = document.querySelector(".tile-actions :focus-visible");
      if (focusedControl) {
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
  if (stream.platform === "chzzk") return metadata.get(stream.channelId)?.name || "치지직 방송";
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
  if (activeAudioKey && !getStream(activeAudioKey)) activeAudioKey = null;
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
      setActiveAudio(activeAudioKey === key ? null : key);
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

function applyAudioState(tile, stream) {
  const muted = activeAudioKey !== streamKey(stream);
  const frame = tile.querySelector(".stream-frame");
  if (stream.platform === "chzzk") {
    sendChzzkCommand(frame, { type: "set-muted", muted });
  } else {
    sendYouTubeCommand(frame, muted);
  }
}

function updateAudioClasses() {
  for (const [key, tile] of tiles) {
    const active = key === activeAudioKey;
    tile.classList.toggle("is-audio-active", active);
    tile.querySelector('[data-action="audio"]').textContent = active ? "소리 켬" : "소리";
  }
}

function setActiveAudio(key) {
  activeAudioKey = key;
  for (const stream of streams) {
    const tile = tiles.get(streamKey(stream));
    if (tile) applyAudioState(tile, stream);
  }
  updateAudioClasses();
}

function setChatVisibility(open) {
  settings.chatOpen = open;
  body.classList.toggle("chat-hidden", !open);
  chatToggle.setAttribute("aria-pressed", String(open));
  updateLayout();
  saveSettings();
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
}

async function refreshStatuses() {
  const channelIds = new Set(chzzkPresets.map((member) => member.channelId));
  for (const stream of streams) {
    if (stream.platform === "chzzk") channelIds.add(stream.channelId);
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
  if (stream.platform === "chzzk" && !stream.name) {
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
  } catch (error) {
    setFormMessage(error?.message || "방송을 추가하지 못했습니다.");
  }
});

document.querySelector("#sidebar-toggle").addEventListener("click", (event) => {
  const hidden = body.classList.toggle("sidebar-hidden");
  event.currentTarget.setAttribute("aria-expanded", String(!hidden));
  updateLayout();
});

document.querySelector("#empty-open-sidebar").addEventListener("click", () => {
  body.classList.remove("sidebar-hidden");
  document.querySelector("#sidebar-toggle").setAttribute("aria-expanded", "true");
});

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
});

document.querySelector("#viewer-clear").addEventListener("click", () => setStreams([]));
document.querySelector("#mute-all").addEventListener("click", () => setActiveAudio(null));
chatToggle.addEventListener("click", () => setChatVisibility(!settings.chatOpen));
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
  if (active) {
    setFullscreenControlsHidden(false, true);
    noteFullscreenActivity();
  } else {
    setFullscreenControlsHidden(false, true);
  }
  requestAnimationFrame(updateLayout);
});

window.addEventListener("pointermove", noteFullscreenActivity, {
  capture: true,
  passive: true,
});
window.addEventListener("pointerdown", noteFullscreenActivity, {
  capture: true,
  passive: true,
});
window.addEventListener("keydown", noteFullscreenActivity, true);
window.addEventListener("focusin", noteFullscreenActivity, true);

// A handle press that never became a drag must re-enable the stream frames
// (a real drag ends through the handle's dragend instead).
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, () => {
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
    noteFullscreenActivity();
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

async function initialize() {
  const stored = await chrome.storage.local.get({
    selectedStreams: [],
    settings: DEFAULT_SETTINGS,
  });
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
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
  body.classList.toggle("chat-hidden", !settings.chatOpen);
  chatToggle.setAttribute("aria-pressed", String(settings.chatOpen));

  renderMemberLibrary();
  reconcileTiles();
  updateSummary();
  updateLayout();
  refreshStatuses();
}

initialize();
