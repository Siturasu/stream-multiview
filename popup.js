import { PRESET_GROUP_ORDER, STREAM_PRESETS } from "./src/shared/members.js";
import {
  makeChzzkStream,
  makeYouTubeStream,
  parseStreamInput,
  sanitizeStream,
  streamKey,
} from "./src/shared/streams.js";

const chzzkPresets = STREAM_PRESETS.filter((preset) => preset.platform === "chzzk");
const presetKeys = new Set(STREAM_PRESETS.map((preset) => streamKey(presetStream(preset))));

const memberGroups = document.querySelector("#member-groups");
const liveCount = document.querySelector("#live-count");
const selectedCount = document.querySelector("#selected-count");
const customCount = document.querySelector("#custom-count");
const openViewerButton = document.querySelector("#open-viewer");
const form = document.querySelector("#add-form");
const streamInput = document.querySelector("#stream-input");
const formMessage = document.querySelector("#form-message");

let selectedStreams = [];
let hasCompleteStatusSnapshot = false;
const metadata = new Map();

function safeStream(stream) {
  try {
    return sanitizeStream(stream);
  } catch {
    return null;
  }
}

function selectedKeys() {
  return new Set(selectedStreams.map(streamKey));
}

function memberStream(member) {
  return presetStream(member);
}

function presetStream(preset) {
  return preset.platform === "youtube"
    ? makeYouTubeStream(preset.channelId, preset.name)
    : makeChzzkStream(preset.channelId, preset.name);
}

function formatViewers(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}명` : "LIVE";
}

function createAvatar(member, meta, className) {
  const avatar = document.createElement("span");
  avatar.className = className;
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

function renderMembers() {
  const keys = selectedKeys();
  memberGroups.replaceChildren();

  for (const group of PRESET_GROUP_ORDER) {
    const section = document.createElement("section");
    section.className = "member-group";

    const heading = document.createElement("h2");
    heading.textContent = group;
    section.append(heading);

    const grid = document.createElement("div");
    grid.className = "member-grid";

    for (const member of STREAM_PRESETS.filter((item) => item.group === group)) {
      const stream = memberStream(member);
      const meta = member.platform === "chzzk" ? metadata.get(member.channelId) : null;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `member-card${meta?.open ? " is-live" : ""}`;
      button.style.setProperty("--member-accent", member.accent);
      button.setAttribute("aria-pressed", String(keys.has(streamKey(stream))));
      button.dataset.channelId = member.channelId;
      button.dataset.platform = member.platform;

      const avatar = createAvatar(member, meta, "member-avatar");
      const copy = document.createElement("span");
      copy.className = "member-copy";
      const name = document.createElement("strong");
      name.textContent = member.name;
      const state = document.createElement("small");
      state.textContent = member.platform === "youtube"
        ? "YouTube 라이브"
        : meta?.open
          ? formatViewers(meta.viewers)
          : meta
            ? "오프라인"
            : "상태 확인 중";
      copy.append(name, state);

      const check = document.createElement("span");
      check.className = "member-check";
      check.textContent = "✓";
      button.append(avatar, copy, check);
      button.addEventListener("click", () => toggleStream(stream));
      grid.append(button);
    }

    section.append(grid);
    memberGroups.append(section);
  }
}

function renderSummary() {
  const custom = selectedStreams.filter(
    (stream) => !presetKeys.has(streamKey(stream)),
  ).length;
  selectedCount.textContent = `${selectedStreams.length}개 선택`;
  customCount.textContent = `사용자 방송 ${custom}개`;
  openViewerButton.disabled = selectedStreams.length === 0;
}

function render() {
  renderMembers();
  renderSummary();
}

async function persist() {
  await chrome.storage.local.set({ selectedStreams });
}

async function toggleStream(stream) {
  const key = streamKey(stream);
  const index = selectedStreams.findIndex((item) => streamKey(item) === key);
  if (index >= 0) {
    selectedStreams.splice(index, 1);
  } else {
    selectedStreams.push(stream);
  }
  render();
  await persist();
}

function setFormMessage(message, success = false) {
  formMessage.textContent = message;
  formMessage.classList.toggle("is-success", success);
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

  if (stream.platform === "chzzk" && stream.channelId && !stream.name) {
    const response = await chrome.runtime.sendMessage({
      type: "fetch-chzzk-meta",
      channelId: stream.channelId,
    });
    if (response?.ok && response.meta?.name) {
      stream = { ...stream, name: response.meta.name };
    }
  }

  return stream;
}

async function addInput(input) {
  const stream = await resolveStream(input);
  const key = streamKey(stream);
  if (selectedStreams.some((item) => streamKey(item) === key)) {
    setFormMessage("이미 선택한 방송입니다.");
    return;
  }
  selectedStreams.push(stream);
  await persist();
  render();
  setFormMessage(`${stream.name || "방송"}을 추가했습니다.`, true);
}

async function refreshMetadata() {
  const results = await Promise.allSettled(
    chzzkPresets.map(async (member) => {
      const response = await chrome.runtime.sendMessage({
        type: "fetch-chzzk-meta",
        channelId: member.channelId,
      });
      if (response?.ok && response.meta) {
        metadata.set(member.channelId, response.meta);
        return true;
      }
      return false;
    }),
  );
  const openCount = [...metadata.values()].filter((meta) => meta.open).length;
  const succeeded = results.filter(
    (result) => result.status === "fulfilled" && result.value === true,
  ).length;
  hasCompleteStatusSnapshot = succeeded === chzzkPresets.length;
  liveCount.textContent = succeeded === 0
    ? "상태 확인 실패"
    : hasCompleteStatusSnapshot
      ? `● ${openCount}명 방송 중`
      : `● ${openCount}명 방송 중 · 일부 확인 실패`;
  renderMembers();
  return hasCompleteStatusSnapshot;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = streamInput.value.trim();
  if (!input) return;
  setFormMessage("방송 주소를 확인하고 있습니다…");
  try {
    await addInput(input);
    streamInput.value = "";
  } catch (error) {
    setFormMessage(error?.message || "방송을 추가하지 못했습니다.");
  }
});

document.querySelector("#select-live").addEventListener("click", async () => {
  if (!hasCompleteStatusSnapshot && !(await refreshMetadata())) {
    setFormMessage("멤버 방송 상태를 모두 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    return;
  }
  const existingCustom = selectedStreams.filter(
    (stream) => stream.platform !== "chzzk" || !presetKeys.has(streamKey(stream)),
  );
  const liveMembers = chzzkPresets
    .filter((member) => metadata.get(member.channelId)?.open)
    .map(memberStream);
  selectedStreams = [...liveMembers, ...existingCustom];
  await persist();
  render();
});

document.querySelector("#add-current").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error("현재 탭 주소를 읽을 수 없습니다.");
    await addInput(tab.url);
  } catch (error) {
    setFormMessage(error?.message || "현재 탭을 추가하지 못했습니다.");
  }
});

document.querySelector("#clear-selection").addEventListener("click", async () => {
  selectedStreams = [];
  await persist();
  render();
});

openViewerButton.addEventListener("click", async () => {
  openViewerButton.disabled = true;
  await persist();
  const response = await chrome.runtime.sendMessage({ type: "open-viewer" });
  if (!response?.ok) {
    await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  }
  window.close();
});

async function initialize() {
  const stored = await chrome.storage.local.get({ selectedStreams: [] });
  selectedStreams = stored.selectedStreams.map(safeStream).filter(Boolean);
  render();
  refreshMetadata();
}

initialize();
