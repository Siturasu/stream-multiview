#!/usr/bin/env node
// Real-browser regression harness for the Stream Multiview Chrome extension.
//
// Launches Chrome for Testing headless, side-loads the unpacked extension over
// the DevTools Protocol (branded Chrome 137+ dropped --load-extension), opens
// viewer.html and drives it with real input events: add a CHZZK replay and a
// YouTube video, prove that tiles nobody touched keep the players' own volume
// and mute, open the volume panel, move the per-tile sliders, unmute several
// tiles at once, reload to prove persistence, check that fullscreen hides the
// top bar, the side panels and the volume panel like the original viewer
// (Space stays in, tile controls auto-hide), then the touch (hover: none)
// fallback with its compact layout and the narrow desktop layout.
//
// Everything is read from inside the real player frames. Nothing is spoofed:
// viewer.js only trusts frame messages whose origin matches the tile, so a
// faked postMessage would prove nothing.
//
// No npm dependencies (Node 24 global WebSocket and fetch only).
//
// Usage:
//   node harness/chrome/check-extension.mjs [--chrome <path>] [--video <id>]
//        [--youtube <id|none>] [--timeout 90] [--keep] [--port <n>]

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = resolve(HERE, "..", "..");
const REPORT_PATH = join(HERE, "report-latest.json");

// ---------------------------------------------------------------- options ---

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const DEFAULT_VIDEO = "14920476";
const FALLBACK_VIDEO = "14782779";

const options = {
  chrome: flag("chrome", process.env.SV_CHROME || null),
  video: flag("video", DEFAULT_VIDEO),
  youtube: flag("youtube", "dQw4w9WgXcQ"),
  timeout: Number(flag("timeout", "90")),
  keep: has("keep"),
  port: Number(flag("port", "0")) || 0,
};
if (options.youtube === "none" || options.youtube === "") options.youtube = null;
if (options.youtube && options.youtube.includes("://")) {
  options.youtube = new URL(options.youtube).searchParams.get("v") || options.youtube.split("/").pop();
}
const videoWasExplicit = flag("video", null) !== null;

// -------------------------------------------------------------- reporting ---

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const checks = {};
const notes = {};
const failures = [];
const inconclusive = [];

const log = (line) => process.stderr.write(`[harness] ${line}\n`);
const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));
const J = (value) => JSON.stringify(value);

function pass(name, note) {
  checks[name] = "pass";
  if (note !== undefined) notes[name] = note;
  log(`ok: ${name}`);
}
function fail(name, reason, note) {
  checks[name] = "fail";
  failures.push(`${name}: ${reason}`);
  notes[name] = note === undefined ? reason : note;
  log(`FAIL: ${name}: ${reason}`);
}
function skip(name, reason, note) {
  checks[name] = "inconclusive";
  inconclusive.push(`${name}: ${reason}`);
  notes[name] = note === undefined ? reason : note;
  log(`inconclusive: ${name}: ${reason}`);
}

/** Runs a check body; an exception becomes a failure instead of killing the run. */
async function step(name, body) {
  if (checks[name]) return;
  try {
    await body();
  } catch (error) {
    if (!checks[name]) fail(name, `threw: ${error?.message || error}`);
    else log(`${name} threw after reporting: ${error?.message || error}`);
  }
  if (!checks[name]) fail(name, "check produced no verdict");
}

async function waitFor(label, seconds, check, interval = 0.25) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const value = await check();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastWaitError = String(error?.message || error);
    }
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  log(`timeout after ${seconds}s: ${label}`);
  return null;
}
let lastWaitError = null;

// ----------------------------------------------------------------- chrome ---

function discoverChrome() {
  if (options.chrome) return options.chrome;
  const base = join(homedir(), ".cache", "stream-multiview", "browsers");
  if (!existsSync(base)) return null;
  const suffix = join("Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  for (const entry of readdirSync(base)) {
    const candidate = join(base, entry, suffix);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function freePort() {
  return new Promise((resolveport, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolveport(port));
    });
  });
}

let chrome = null;
let profileDir = null;
let cleanedUp = false;

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (chrome && !options.keep) {
    try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
  }
  if (profileDir && !options.keep) {
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { cleanup(); process.exit(130); });
}

// -------------------------------------------------------------------- CDP ---

class CDP {
  constructor(socket, callTimeoutMs) {
    this.socket = socket;
    this.callTimeoutMs = callTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.data || ""})`));
        else done(message.result || {});
        return;
      }
      if (message.method) for (const listener of this.listeners) listener(message);
    });
  }

  on(listener) { this.listeners.push(listener); }

  send(method, params = {}, sessionId = null) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${this.callTimeoutMs / 1000}s`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve: done, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }
}

let cdp = null;
let pageSession = null;
// Out-of-process iframes (chzzk.naver.com, www.youtube.com) each get their own
// flattened session. targetId equals the frame id for an OOPIF, which is how a
// tile's iframe element is mapped to the session that renders it.
const sessionByTarget = new Map(); // targetId  -> sessionId
const infoByTarget = new Map();    // targetId  -> targetInfo
const targetBySession = new Map(); // sessionId -> targetId

function trackEvent(message) {
  const params = message.params || {};
  switch (message.method) {
    case "Target.attachedToTarget": {
      const info = params.targetInfo || {};
      if (info.type === "page" || info.type === "iframe") {
        sessionByTarget.set(info.targetId, params.sessionId);
        infoByTarget.set(info.targetId, info);
        targetBySession.set(params.sessionId, info.targetId);
        initSession(params.sessionId).catch((error) => log(`child session init failed: ${error.message}`));
      }
      break;
    }
    case "Target.targetInfoChanged": {
      const info = params.targetInfo || {};
      if (infoByTarget.has(info.targetId)) infoByTarget.set(info.targetId, info);
      break;
    }
    case "Target.detachedFromTarget": {
      const targetId = targetBySession.get(params.sessionId);
      targetBySession.delete(params.sessionId);
      if (targetId && sessionByTarget.get(targetId) === params.sessionId) {
        sessionByTarget.delete(targetId);
        infoByTarget.delete(targetId);
      }
      break;
    }
    default:
      break;
  }
}

async function initSession(sessionId) {
  await cdp.send("Runtime.enable", {}, sessionId).catch(() => {});
  await cdp.send("Page.enable", {}, sessionId).catch(() => {});
  await cdp.send("DOM.enable", {}, sessionId).catch(() => {});
  await cdp.send(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId,
  ).catch(() => {});
}

/** Evaluates an async function body in a session's main world. */
async function evalIn(sessionId, body) {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text ||
      "evaluate failed",
    );
  }
  const value = result.result?.value;
  return value === undefined ? null : value;
}

const evalPage = (body) => evalIn(pageSession, body);

const CHZZK_TILE = '.stream-tile[data-key^="chzzk:"]';
const YOUTUBE_TILE = '.stream-tile[data-key^="youtube:"]';

/** Session of the OOPIF rendered by the iframe matching `selector` in the viewer. */
async function frameSession(selector, urlNeedle) {
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 1 }, pageSession);
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector }, pageSession);
    if (nodeId) {
      const { node } = await cdp.send("DOM.describeNode", { nodeId }, pageSession);
      const sessionId = node?.frameId ? sessionByTarget.get(node.frameId) : null;
      if (sessionId) return sessionId;
    }
  } catch { /* fall through to the URL match */ }
  // Fallback: newest attached iframe target whose URL matches.
  let found = null;
  for (const [targetId, info] of infoByTarget) {
    if (info.type !== "iframe" || !String(info.url || "").includes(urlNeedle)) continue;
    const sessionId = sessionByTarget.get(targetId);
    if (sessionId) found = sessionId;
  }
  return found;
}

const chzzkSession = () => frameSession(`${CHZZK_TILE} .stream-frame`, "chzzk.naver.com");
const youtubeSession = () => frameSession(`${YOUTUBE_TILE} .stream-frame`, "youtube.com/embed/");

// ----------------------------------------------------------------- probes ---

// Read from inside the real frames. `isKnownAd` mirrors the iOS/Android
// harnesses: a CHZZK replay may roll a pre-roll ad first, which still counts
// as a ready player.
const VIDEO_PROBE = `
const videos = [...document.querySelectorAll("video")].map((v) => {
  const source = v.currentSrc || "";
  let isKnownAd = false;
  let safe = "";
  if (source) {
    try {
      const url = new URL(source, location.href);
      isKnownAd = url.hostname === "api.chzzk.naver.com" && url.pathname.startsWith("/service/t/");
      safe = url.protocol === "data:" ? "data:[inline]" : (url.protocol + "//" + url.host + url.pathname).slice(0, 110);
    } catch { safe = "unparsed"; }
  }
  return {
    src: safe, isKnownAd, paused: v.paused, muted: v.muted,
    readyState: v.readyState, volume: Math.round(v.volume * 1000) / 1000,
    width: v.videoWidth, currentTime: Math.round(v.currentTime * 10) / 10,
  };
});
`;

const CHZZK_PROBE = `${VIDEO_PROBE}
const root = document.documentElement;
return {
  href: location.href.slice(0, 140),
  svEmbedded: root.classList.contains("sv-embedded"),
  qualityStatus: root.dataset.svQualityStatus || null,
  activityRelay: root.dataset.svActivityRelay || null,
  videos,
};
`;

const YOUTUBE_PROBE = `${VIDEO_PROBE}
return { href: location.href.slice(0, 140), title: document.title.slice(0, 80), videos };
`;

// YouTube keeps a second volume number behind #movie_player. The element and
// the model are read in the same turn so the two can be compared.
const YOUTUBE_MODEL_PROBE = `
const player = document.getElementById("movie_player");
if (!player) return { player: false, getVolume: false };
if (typeof player.getVolume !== "function") return { player: true, getVolume: false };
const video = document.querySelector("video");
return {
  player: true,
  getVolume: true,
  model: Number(player.getVolume()),
  muted: typeof player.isMuted === "function" ? player.isMuted() : null,
  volume: video ? Math.round(video.volume * 1000) / 1000 : null,
};
`;

// YouTube's own ad state, read off the player element.
const YOUTUBE_AD_SHOWING = `
const player = document.getElementById("movie_player");
return !!player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"));
`;

// The chzzk main video (not a pre-roll ad) as `main`, or null. Built on
// VIDEO_PROBE so the ad test is the one every other read uses; both walk the
// same querySelectorAll in the same turn, so the indexes line up.
const CHZZK_MAIN_VIDEO = `${VIDEO_PROBE}
const mainIndex = videos.findIndex((v) => !v.isKnownAd && v.src);
const main = mainIndex >= 0 ? document.querySelectorAll("video")[mainIndex] : null;
`;

// Reads back the element untouchedChzzk wrote to, through VIDEO_PROBE.
const UNTOUCHED_READ = `${VIDEO_PROBE}
const tracked = window.__svUntouched || null;
const index = tracked ? [...document.querySelectorAll("video")].indexOf(tracked) : -1;
return { tracked: index >= 0, video: index >= 0 ? videos[index] : null };
`;

// Everything fullscreen is meant to hide or resize, in one read.
const FULLSCREEN_STATE = `
const display = (selector) => {
  const el = document.querySelector(selector);
  return el ? getComputedStyle(el).display : null;
};
const grid = document.querySelector(".stream-grid");
const box = grid ? grid.getBoundingClientRect() : null;
const active = document.activeElement;
const describe = (el) => {
  if (!el) return null;
  if (el === document.body) return "body";
  if (el.id) return "#" + el.id;
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).join(".") : "";
  return el.tagName.toLowerCase() + cls;
};
return {
  fullscreen: document.fullscreenElement === document.documentElement,
  fullscreenView: document.body.classList.contains("fullscreen-view"),
  controlsHidden: document.body.classList.contains("fullscreen-controls-hidden"),
  panelOpen: document.body.classList.contains("volume-panel-open"),
  topbar: display(".topbar"),
  sidebar: display(".sidebar"),
  chat: display(".chat-panel"),
  volumePanel: display("#volume-panel"),
  grid: box ? { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } : null,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  topRow: document.querySelectorAll(".stream-tile.is-top-row").length,
  activeElement: describe(active),
  focusInTopbar: !!active?.closest?.(".topbar"),
};
`;

/** What is wrong with the view right after entering fullscreen (empty when nothing). */
function fullscreenEntryProblems(state) {
  if (!state) return ["the viewer answered nothing"];
  const problems = [];
  if (!state.fullscreen) problems.push("document.fullscreenElement is not the document element");
  for (const [label, value] of [
    [".topbar", state.topbar], [".sidebar", state.sidebar],
    [".chat-panel", state.chat], ["#volume-panel", state.volumePanel],
  ]) {
    if (value !== "none") problems.push(`${label} display is ${value}`);
  }
  if (state.panelOpen) problems.push("body still has volume-panel-open");
  const box = state.grid;
  const view = state.viewport;
  if (
    !box || Math.abs(box.left) > 1 || Math.abs(box.top) > 1 ||
    Math.abs(box.width - view.width) > 1 || Math.abs(box.height - view.height) > 1
  ) {
    problems.push(`.stream-grid box is ${JSON.stringify(box)}, expected 0,0 ${view.width}x${view.height}`);
  }
  if (state.topRow) problems.push(`${state.topRow} tile(s) carry is-top-row`);
  if (state.focusInTopbar) problems.push(`focus stayed in the hidden top bar (${state.activeElement})`);
  return problems;
}

/** The auto-hide class plus every tile header, and the tile under (x, y). */
function tileHeaderState(x, y) {
  return `
    const read = (tile) => {
      const header = tile.querySelector(".tile-header");
      return { key: tile.dataset.key, hover: tile.matches(":hover"), opacity: header ? getComputedStyle(header).opacity : null };
    };
    const under = document.elementFromPoint(${Number(x)}, ${Number(y)})?.closest?.(".stream-tile") || null;
    return {
      controlsHidden: document.body.classList.contains("fullscreen-controls-hidden"),
      fullscreen: document.fullscreenElement === document.documentElement,
      headers: [...document.querySelectorAll(".stream-tile")].map(read),
      hovered: under ? read(under) : null,
    };
  `;
}

// The layout switches a narrow viewport can flip, in one read.
const LAYOUT_STATE = `
const read = (selector) => {
  const el = document.querySelector(selector);
  return el ? getComputedStyle(el) : null;
};
const sidebar = read(".sidebar");
const chatPanel = document.querySelector(".chat-panel");
const chat = chatPanel ? getComputedStyle(chatPanel) : null;
const chatBox = chatPanel ? chatPanel.getBoundingClientRect() : null;
const handle = read(".stream-tile .drag-handle");
const overflow = read("#sv-overflow-toggle");
return {
  width: window.innerWidth,
  hoverNone: matchMedia("(hover: none)").matches,
  compact: document.body.classList.contains("sv-compact"),
  overflowToggle: overflow ? overflow.display : null,
  sidebarPosition: sidebar ? sidebar.position : null,
  chatHidden: document.body.classList.contains("chat-hidden"),
  chatDisplay: chat ? chat.display : null,
  chatPosition: chat ? chat.position : null,
  chatLeft: chat ? chat.left : null,
  chatBox: chatBox ? { left: Math.round(chatBox.left), width: Math.round(chatBox.width) } : null,
  dragHandle: handle ? handle.display : null,
  qualityInTopbar: !!document.querySelector("#quality-select")?.closest(".topbar"),
};
`;

async function chzzkProbe() {
  const session = await chzzkSession();
  if (!session) throw new Error("no chzzk iframe session attached");
  return evalIn(session, CHZZK_PROBE);
}
async function youtubeProbe() {
  const session = await youtubeSession();
  if (!session) throw new Error("no youtube iframe session attached");
  return evalIn(session, YOUTUBE_PROBE);
}

/**
 * Writes volume 0.5 (kind "volume") or flips muted (kind "muted") on the chzzk
 * main video from inside the frame, waits a second and reads the same element
 * back, then restores it (volume 1, or the old mute). A pre-roll ad on screen
 * makes the result inconclusive: that element is not the one the user hears.
 */
async function untouchedChzzk(kind) {
  const session = await chzzkSession();
  if (!session) return { verdict: "fail", reason: "no chzzk iframe session attached" };
  if (kind === "muted") {
    const quality = await evalPage(`return document.querySelector(${J(`${CHZZK_TILE} .quality-pill`)})?.textContent || "";`);
    if (!quality || quality.trim() === "대기 중") {
      return { verdict: "inconclusive", reason: `the chzzk tile is not ready (quality pill: ${JSON.stringify(quality)})` };
    }
  }
  const write = kind === "volume" ? "main.volume = 0.5;" : "main.muted = !main.muted;";
  // A pre-roll may still be running; give it a short while to hand over.
  const written = await waitFor(`chzzk main video for the ${kind} write`, 10, () => evalIn(session, `${CHZZK_MAIN_VIDEO}
    if (!main) return null;
    window.__svUntouched = main;
    const before = { volume: main.volume, muted: main.muted };
    ${write}
    return { before, after: { volume: Math.round(main.volume * 1000) / 1000, muted: main.muted } };
  `), 0.5);
  if (!written) {
    const probe = await evalIn(session, CHZZK_PROBE).catch(() => null);
    return {
      verdict: "inconclusive",
      reason: "the chzzk player had only an ad (or no source) for 10s",
      videos: probe?.videos ?? null,
      lastWaitError,
    };
  }
  await sleep(1);
  const read = await evalIn(session, UNTOUCHED_READ).catch(() => null);
  const restore = kind === "volume" ? "tracked.volume = 1;" : `tracked.muted = ${written.before.muted === true};`;
  await evalIn(session, `
    const tracked = window.__svUntouched;
    if (tracked) { ${restore} }
    window.__svUntouched = null;
    return true;
  `).catch(() => {});

  const video = read?.video;
  if (!read?.tracked || !video) {
    return { verdict: "inconclusive", reason: "the chzzk player swapped its video element within the second", written };
  }
  if (video.isKnownAd) {
    return { verdict: "inconclusive", reason: "an ad took over the chzzk video within the second", written, video };
  }
  if (kind === "volume") {
    return Math.abs(video.volume - 0.5) < 0.02
      ? { verdict: "pass", written, video }
      : { verdict: "fail", reason: `the chzzk video volume moved from 0.5 to ${video.volume} within 1s`, written, video };
  }
  return video.muted === written.after.muted
    ? { verdict: "pass", written, video }
    : { verdict: "fail", reason: `the chzzk video was put back to muted=${video.muted} within 1s`, written, video };
}

/**
 * Calls setVolume(10) on YouTube's own player, waits a second and reads the
 * model and the element back, then restores 100. YouTube may scale the element
 * for loudness, so the element only has to have left the 0.5+ range.
 */
async function untouchedYoutube() {
  const session = await youtubeSession();
  if (!session) return { verdict: "fail", reason: "no youtube iframe session attached" };
  const written = await waitFor("youtube player free of ads for setVolume(10)", 10, () => evalIn(session, `
    const player = document.getElementById("movie_player");
    if (!player || typeof player.setVolume !== "function") return { api: false };
    if (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) return null;
    player.setVolume(10);
    return { api: true, model: Number(player.getVolume()) };
  `), 0.5);
  if (!written) return { verdict: "inconclusive", reason: "an ad was on the YouTube player for 10s", lastWaitError };
  if (!written.api) return { verdict: "inconclusive", reason: "#movie_player has no setVolume(), so the player could not be moved from inside" };
  await sleep(1);
  const after = await evalIn(session, YOUTUBE_MODEL_PROBE).catch(() => null);
  const ad = await evalIn(session, YOUTUBE_AD_SHOWING).catch(() => false);
  await evalIn(session, 'document.getElementById("movie_player")?.setVolume?.(100); return true;').catch(() => {});

  if (ad) return { verdict: "inconclusive", reason: "an ad took over the YouTube player within the second", written, after };
  if (!after?.getVolume) return { verdict: "inconclusive", reason: "#movie_player could not be read back", written, after };
  const kept = Math.abs(after.model - 10) <= 1 && after.volume !== null && after.volume < 0.5;
  return kept
    ? { verdict: "pass", written, after }
    : {
      verdict: "fail",
      reason: `one second after setVolume(10) the model read ${after.model} and <video>.volume ${after.volume}`,
      written,
      after,
    };
}

const anyVideo = (probe, predicate) => (probe?.videos || []).some(predicate);

// ------------------------------------------------------------ real input ---

async function rectOf(selector) {
  return evalPage(`
    const el = document.querySelector(${J(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  `);
}

/**
 * Moves the pointer to a resting spot. Blink recomputes :hover from the last
 * move it processed and that recompute is lazy, so a single jump between two
 * spots can leave the old element hovered. A nudge first makes the landing
 * position the second move Chrome sees, which settles the hover state.
 */
async function mouseMove(x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 1, y, buttons: 0 }, pageSession);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 }, pageSession);
}

/**
 * A genuine press/release pair. Synthetic element.click() carries no user
 * activation, so requestFullscreen would be rejected.
 */
async function realClick(selector) {
  const rect = await rectOf(selector);
  if (!rect) throw new Error(`no clickable element for ${selector}`);
  await mouseMove(rect.x, rect.y);
  const base = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 }, pageSession);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, pageSession);
  return rect;
}

async function setRange(selector, value) {
  return evalPage(`
    const el = document.querySelector(${J(selector)});
    if (!el) throw new Error("no range element " + ${J(selector)});
    if (el.disabled) throw new Error("range is disabled: " + ${J(selector)});
    el.value = ${J(String(value))};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  `);
}

// Escape carries the Windows code as its native code too: the browser side
// needs one to leave fullscreen, and 27 has been fine here. Space must NOT
// carry a nativeVirtualKeyCode: with one (32 or the mac kVK_Space 49) Chrome
// for Testing on this mac turns the press into an endless stream of trusted
// keydown events on the viewer body, which keeps the idle timer alive. That
// exists only under CDP; Blink still gets the keydown/keypress without it.
async function pressEscape() {
  const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, pageSession);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, pageSession);
}

async function pressSpace() {
  // `text` makes the keyDown also produce the keypress a real keyboard sends.
  const key = { key: " ", code: "Space", windowsVirtualKeyCode: 32 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: " ", unmodifiedText: " " }, pageSession);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, pageSession);
}

/**
 * Resizes the viewer's emulated viewport (desktop, no touch) and waits for
 * the new width, then lets the viewer's matchMedia listeners settle.
 */
async function setViewport(width, height = 900) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: false,
  }, pageSession);
  await waitFor(`viewport ${width}px`, 3, async () => (await evalPage("return window.innerWidth;")) === width, 0.1);
  await sleep(0.3);
}

/**
 * Re-enters fullscreen with a real click (requestFullscreen needs the user
 * activation a synthetic click does not carry). False means the build refused,
 * which the caller reports as inconclusive rather than a failure.
 */
async function enterFullscreen() {
  const already = await evalPage("return document.fullscreenElement === document.documentElement;");
  if (already === true) return true;
  await realClick("#fullscreen");
  const entered = await waitFor("fullscreen", 3, async () => {
    const value = await evalPage("return document.fullscreenElement === document.documentElement;");
    return value === true;
  }, 0.25);
  return entered === true;
}

// The viewer forwards nothing it does not trust, so the harness records the raw
// frame -> viewer messages itself and reads them back later.
const CAPTURE_HOOK = `
window.__svCaps = [];
window.__svActivity = [];
// Same pings as __svActivity, by kind (pointermove, pointerdown, keydown, focusin).
window.__svActivityKinds = [];
// Proof that the hook belongs to the live document (a reload silently drops it).
window.__svHookInstalls = (window.__svHookInstalls || 0) + 1;
window.addEventListener("message", (e) => {
  const d = e.data;
  if (d && typeof d === "object") {
    if (d.type === "volume-capability") window.__svCaps.push({ origin: e.origin, source: d.source, supported: d.supported, mode: d.mode });
    if (d.source === "stellaview-frame" && d.type === "viewer-activity") {
      window.__svActivity.push(e.origin);
      window.__svActivityKinds.push(String(d.kind || ""));
    }
  }
});
return true;
`;

async function addStream(url) {
  await evalPage(`
    const input = document.querySelector("#viewer-stream-input");
    const form = document.querySelector("#viewer-add-form");
    if (!input || !form) throw new Error("the add form is missing");
    input.value = ${J(url)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
    return true;
  `);
}

async function capsFor(origin, source) {
  const caps = await evalPage("return window.__svCaps || [];");
  return caps.find((cap) => cap.origin === origin && cap.source === source) || null;
}

// ------------------------------------------------------------------- main ---

let extensionId = null;
let chromeVersion = null;
let usedVideo = options.video;

async function main() {
  const binary = discoverChrome();
  if (!binary || !existsSync(binary)) {
    throw new Error(
      "Chrome for Testing was not found. Run harness/chrome/install-chrome.sh once, " +
      "or pass --chrome <path> / set SV_CHROME.",
    );
  }
  log(`chrome binary: ${binary}`);

  const port = options.port || (await freePort());
  profileDir = mkdtempSync(join(tmpdir(), "sv-chrome-profile-"));
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1400,900",
    "about:blank",
  ];
  log(`launching on port ${port}, profile ${profileDir}`);
  chrome = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) log(`chrome: ${text.split("\n").slice(-2).join(" | ").slice(0, 300)}`);
  });
  chrome.on("exit", (code) => log(`chrome exited with code ${code}`));

  const version = await waitFor("devtools endpoint", 30, async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok ? response.json() : null;
  }, 0.3);
  if (!version) throw new Error("the DevTools endpoint never answered");
  chromeVersion = version.Browser || null;
  log(`connected to ${chromeVersion}`);

  const socket = await new Promise((done, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.addEventListener("open", () => done(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("browser websocket failed")), { once: true });
  });
  cdp = new CDP(socket, Math.max(45, options.timeout) * 1000);
  cdp.on(trackEvent);

  const loaded = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION_ROOT });
  extensionId = loaded.id;
  log(`loaded unpacked extension ${extensionId} from ${EXTENSION_ROOT}`);

  const worker = await waitFor("extension service worker", 15, async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find(
      (t) => t.type === "service_worker" && String(t.url).startsWith(`chrome-extension://${extensionId}/`),
    ) || null;
  }, 0.3);
  notes.serviceWorker = worker ? worker.url : "not observed";
  await sleep(1);

  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/viewer.html` });
  const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  pageSession = attached.sessionId;
  await initSession(pageSession);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  }, pageSession);

  await waitFor("viewer document", 20, async () => {
    const ready = await evalPage('return document.readyState === "complete" && !!document.querySelector("#volume-toggle");');
    return ready === true;
  });
  await evalPage(CAPTURE_HOOK);

  await runChecks();
}

async function runChecks() {
  // 1 -------------------------------------------------------------------- //
  await step("viewer-loads", async () => {
    const state = await evalPage(`
      return {
        url: location.href,
        toggle: !!document.querySelector("#volume-toggle"),
        panel: !!document.querySelector("#volume-panel"),
        open: document.body.classList.contains("volume-panel-open"),
        title: document.title,
      };
    `);
    if (!state?.toggle || !state?.panel) {
      fail("viewer-loads", `#volume-toggle=${state?.toggle} #volume-panel=${state?.panel}`, state);
      return;
    }
    if (state.open) {
      fail("viewer-loads", "body already carries volume-panel-open before any click", state);
      return;
    }
    pass("viewer-loads", state);
  });

  // 2 -------------------------------------------------------------------- //
  let tilesReady = false;
  await step("add-streams", async () => {
    await addStream(`https://chzzk.naver.com/video/${usedVideo}`);
    const chzzkTile = await waitFor("chzzk tile", 15, async () => {
      const src = await evalPage(`return document.querySelector(${J(`${CHZZK_TILE} .stream-frame`)})?.src || null;`);
      return src && src.includes(`/video/${usedVideo}?`) ? src : null;
    });
    if (!chzzkTile) {
      const message = await evalPage('return document.querySelector("#viewer-form-message")?.textContent || "";');
      fail("add-streams", `the chzzk tile never appeared (form said: ${message || "nothing"})`);
      return;
    }
    if (!chzzkTile.includes("sv=1")) {
      fail("add-streams", `the chzzk embed URL lacks sv=1: ${chzzkTile}`);
      return;
    }

    let youtubeSrc = null;
    if (options.youtube) {
      await addStream(`https://www.youtube.com/watch?v=${options.youtube}`);
      youtubeSrc = await waitFor("youtube tile", 15, async () => {
        const src = await evalPage(`return document.querySelector(${J(`${YOUTUBE_TILE} .stream-frame`)})?.src || null;`);
        return src && src.includes(`youtube.com/embed/${options.youtube}`) ? src : null;
      });
      if (!youtubeSrc) {
        const message = await evalPage('return document.querySelector("#viewer-form-message")?.textContent || "";');
        fail("add-streams", `the YouTube tile never appeared (form said: ${message || "nothing"})`);
        return;
      }
      if (!youtubeSrc.includes("enablejsapi=1")) {
        fail("add-streams", `the YouTube embed URL lacks enablejsapi=1: ${youtubeSrc}`);
        return;
      }
    }

    const count = await evalPage('return document.querySelectorAll(".stream-tile").length;');
    const expected = options.youtube ? 2 : 1;
    if (count !== expected) {
      fail("add-streams", `expected ${expected} .stream-tile, found ${count}`);
      return;
    }
    tilesReady = true;
    pass("add-streams", { chzzk: chzzkTile, youtube: youtubeSrc, tiles: count });
  });

  if (!tilesReady) {
    for (const name of [
      "chzzk-player-ready", "youtube-player-ready", "untouched-volume-left-alone",
      "volume-panel-open", "chzzk-volume", "youtube-volume", "youtube-capability",
      "multi-audio", "persistence", "vod-activity-relay", "fullscreen-hides-chrome",
      "fullscreen-space-keeps-fullscreen", "touch-controls", "youtube-model-sync",
      "desktop-narrow-layout",
    ]) skip(name, "add-streams did not produce the tiles this check needs");
    return;
  }

  // 3 -------------------------------------------------------------------- //
  let chzzkReady = false;
  await step("chzzk-player-ready", async () => {
    const probeOnce = async () => {
      const session = await chzzkSession();
      if (!session) return null;
      const probe = await evalIn(session, CHZZK_PROBE);
      if (!probe?.svEmbedded) return null;
      if (!(probe.videos || []).length) return null;
      const quality = await evalPage(`return document.querySelector(${J(`${CHZZK_TILE} .quality-pill`)})?.textContent || "";`);
      if (!quality || quality.trim() === "대기 중") return null;
      return { probe, quality };
    };

    let result = await waitFor("chzzk player", options.timeout, probeOnce, 0.5);
    if (!result && !videoWasExplicit && usedVideo === DEFAULT_VIDEO) {
      log(`video ${usedVideo} never became ready, retrying with ${FALLBACK_VIDEO}`);
      await realClick(`${CHZZK_TILE} [data-action="remove"]`).catch(() => {});
      await sleep(0.5);
      usedVideo = FALLBACK_VIDEO;
      await addStream(`https://chzzk.naver.com/video/${usedVideo}`);
      await sleep(1);
      result = await waitFor("chzzk player (fallback)", options.timeout, probeOnce, 0.5);
    }

    if (!result) {
      const session = await chzzkSession().catch(() => null);
      const probe = session ? await evalIn(session, CHZZK_PROBE).catch(() => null) : null;
      fail("chzzk-player-ready", `no ready player within ${options.timeout}s`, { session: !!session, probe, lastWaitError });
      return;
    }
    chzzkReady = true;
    notes.video = usedVideo;
    pass("chzzk-player-ready", {
      video: usedVideo,
      quality: result.quality.trim(),
      svEmbedded: result.probe.svEmbedded,
      videos: result.probe.videos,
    });
  });

  // 4 -------------------------------------------------------------------- //
  let youtubeReady = false;
  if (!options.youtube) {
    skip("youtube-player-ready", "--youtube none");
    skip("youtube-volume", "--youtube none");
    skip("youtube-capability", "--youtube none");
  } else {
    await step("youtube-player-ready", async () => {
      const result = await waitFor("youtube player", 60, async () => {
        const session = await youtubeSession();
        if (!session) return null;
        const probe = await evalIn(session, YOUTUBE_PROBE);
        const ok = anyVideo(probe, (v) => !!v.src || v.readyState >= 1);
        return ok ? probe : null;
      }, 0.5);
      if (!result) {
        const session = await youtubeSession().catch(() => null);
        const probe = session ? await evalIn(session, YOUTUBE_PROBE).catch(() => null) : null;
        fail("youtube-player-ready", "no <video> with a source or readyState >= 1 within 60s", { session: !!session, probe });
        return;
      }
      youtubeReady = true;
      pass("youtube-player-ready", { title: result.title, videos: result.videos });
    });
  }

  // 5 -------------------------------------------------------------------- //
  // No slider has moved yet, so the players' own volume and mute belong to
  // the user: what the player (or the user inside it) sets must stay, and the
  // frames have nothing to report until the viewer sends a set-volume.
  await step("untouched-volume-left-alone", async () => {
    const results = {};

    // (a) volume-capability only follows a set-volume.
    const caps = await evalPage("return window.__svCaps || [];");
    results.noCapabilityYet = caps.length === 0
      ? { verdict: "pass" }
      : { verdict: "fail", reason: `volume-capability arrived before any slider moved: ${JSON.stringify(caps)}`, caps };

    // (b) A volume written inside the chzzk player stays.
    results.chzzkVolume = chzzkReady
      ? await untouchedChzzk("volume")
      : { verdict: "inconclusive", reason: "the chzzk player never became ready" };

    // (c) A setVolume() on YouTube's own player stays.
    if (!options.youtube) results.youtubeVolume = { verdict: "n/a", reason: "--youtube none" };
    else if (!youtubeReady) results.youtubeVolume = { verdict: "inconclusive", reason: "the YouTube player never became ready" };
    else results.youtubeVolume = await untouchedYoutube();

    // (d) A mute flipped inside the chzzk player stays: the frame no longer
    // re-asserts the viewer's mute on volumechange.
    results.chzzkMute = chzzkReady
      ? await untouchedChzzk("muted")
      : { verdict: "inconclusive", reason: "the chzzk player never became ready" };

    const failed = Object.entries(results).filter(([, r]) => r.verdict === "fail");
    const unsure = Object.entries(results).filter(([, r]) => r.verdict === "inconclusive");
    if (failed.length) {
      fail("untouched-volume-left-alone", failed.map(([key, r]) => `${key}: ${r.reason}`).join("; "), results);
      return;
    }
    if (unsure.length) {
      skip("untouched-volume-left-alone", unsure.map(([key, r]) => `${key}: ${r.reason}`).join("; "), results);
      return;
    }
    pass("untouched-volume-left-alone", results);
  });

  // 6 -------------------------------------------------------------------- //
  let panelOpen = false;
  await step("volume-panel-open", async () => {
    await realClick("#volume-toggle");
    const state = await waitFor("volume panel", 5, async () => {
      const value = await evalPage(`
        return {
          open: document.body.classList.contains("volume-panel-open"),
          rows: document.querySelectorAll(".volume-row").length,
          tiles: document.querySelectorAll(".stream-tile").length,
          keys: [...document.querySelectorAll(".volume-row")].map((r) => r.dataset.key),
        };
      `);
      return value?.open && value.rows === value.tiles ? value : null;
    });
    if (!state) {
      const value = await evalPage(`
        return {
          open: document.body.classList.contains("volume-panel-open"),
          rows: document.querySelectorAll(".volume-row").length,
          tiles: document.querySelectorAll(".stream-tile").length,
        };
      `);
      fail("volume-panel-open", `panel state after the click: ${JSON.stringify(value)}`, value);
      return;
    }
    // The panel works either way; only the labels are in question below.
    panelOpen = true;

    // Nothing has been moved, so every row shows the player's own level.
    const values = await evalPage(
      'return [...document.querySelectorAll(".volume-row .volume-value")].map((el) => el.textContent.trim());',
    );
    // "기본" alone until the frame reports its level, then "기본 NN%".
    if (!values?.length || values.length !== state.rows || values.some((text) => !/^기본( \d{1,3}%)?$/.test(text))) {
      fail("volume-panel-open", `untouched rows should read 기본 or 기본 NN%, got ${JSON.stringify(values)}`, { ...state, values });
      return;
    }
    pass("volume-panel-open", { ...state, values });
  });

  // 7 -------------------------------------------------------------------- //
  await step("chzzk-volume", async () => {
    if (!chzzkReady) { skip("chzzk-volume", "the chzzk player never became ready"); return; }
    if (!panelOpen) { skip("chzzk-volume", "the volume panel never opened"); return; }
    await setRange('.volume-row[data-key^="chzzk:"] .volume-range', 30);
    const reached = await waitFor("chzzk volume 0.3", 10, async () => {
      const probe = await chzzkProbe();
      return anyVideo(probe, (v) => Math.abs(v.volume - 0.3) < 0.02) ? probe : null;
    }, 0.4);
    const capability = await waitFor("chzzk volume-capability", 5, () => capsFor("https://chzzk.naver.com", "stellaview"), 0.4);
    notes.chzzkVolumeMode = capability ? capability.mode : null;
    if (!reached) {
      const probe = await chzzkProbe().catch(() => null);
      fail("chzzk-volume", "no <video> in the chzzk frame reached volume 0.3 within 10s", { probe, capability });
      return;
    }
    if (!capability || capability.supported !== true) {
      fail("chzzk-volume", `no supported volume-capability from https://chzzk.naver.com (got ${JSON.stringify(capability)})`, {
        capability, videos: reached.videos,
      });
      return;
    }
    pass("chzzk-volume", { mode: capability.mode, videos: reached.videos });
  });

  // 8 -------------------------------------------------------------------- //
  if (options.youtube) {
    await step("youtube-volume", async () => {
      if (!youtubeReady) { skip("youtube-volume", "the YouTube player never became ready"); return; }
      if (!panelOpen) { skip("youtube-volume", "the volume panel never opened"); return; }
      await setRange('.volume-row[data-key^="youtube:"] .volume-range', 40);
      const reached = await waitFor("youtube volume 0.4", 10, async () => {
        const probe = await youtubeProbe();
        return anyVideo(probe, (v) => Math.abs(v.volume - 0.4) < 0.02) ? probe : null;
      }, 0.4);
      if (!reached) {
        const probe = await youtubeProbe().catch(() => null);
        fail("youtube-volume", "no <video> in the YouTube frame reached volume 0.4 within 10s", { probe });
        return;
      }
      pass("youtube-volume", { videos: reached.videos });
    });

    await step("youtube-capability", async () => {
      if (!youtubeReady) { skip("youtube-capability", "the YouTube player never became ready"); return; }
      const capability = await waitFor(
        "youtube volume-capability",
        8,
        () => capsFor("https://www.youtube.com", "stellaview-youtube"),
        0.4,
      );
      if (!capability) {
        const caps = await evalPage("return window.__svCaps || [];");
        fail(
          "youtube-capability",
          "no volume-capability from https://www.youtube.com with source stellaview-youtube " +
          "(content/youtube-volume-frame.js is not in place yet)",
          { caps },
        );
        return;
      }
      pass("youtube-capability", capability);
    });
  }

  // 9 -------------------------------------------------------------------- //
  await step("multi-audio", async () => {
    if (!chzzkReady) { skip("multi-audio", "the chzzk player never became ready"); return; }
    if (options.youtube && !youtubeReady) { skip("multi-audio", "the YouTube player never became ready"); return; }

    const chzzkAudible = async () => {
      const probe = await chzzkProbe();
      return anyVideo(probe, (v) => v.muted === false) ? probe : null;
    };
    const youtubeAudible = async () => {
      const probe = await youtubeProbe();
      return anyVideo(probe, (v) => v.muted === false && v.volume > 0) ? probe : null;
    };

    await realClick(`${CHZZK_TILE} [data-action="audio"]`);
    if (options.youtube) await realClick(`${YOUTUBE_TILE} [data-action="audio"]`);

    const bothAudible = await waitFor("both tiles audible", 10, async () => {
      const a = await chzzkAudible();
      if (!a) return null;
      if (!options.youtube) return { chzzk: a, youtube: null };
      const b = await youtubeAudible();
      return b ? { chzzk: a, youtube: b } : null;
    }, 0.4);
    if (!bothAudible) {
      fail("multi-audio", "the two tiles were never audible at the same time", {
        chzzk: await chzzkProbe().catch(() => null),
        youtube: options.youtube ? await youtubeProbe().catch(() => null) : null,
      });
      return;
    }

    // Toggling one tile off must not disturb the other.
    await realClick(`${CHZZK_TILE} [data-action="audio"]`);
    const isolated = await waitFor("chzzk muted while YouTube stays audible", 10, async () => {
      const chzzk = await chzzkProbe();
      if (anyVideo(chzzk, (v) => v.muted === false)) return null;
      if (!options.youtube) return { chzzk, youtube: null };
      const youtube = await youtubeAudible();
      return youtube ? { chzzk, youtube } : null;
    }, 0.4);
    if (!isolated) {
      fail("multi-audio", "muting the chzzk tile did not leave the YouTube tile audible", {
        chzzk: await chzzkProbe().catch(() => null),
        youtube: options.youtube ? await youtubeProbe().catch(() => null) : null,
      });
      return;
    }

    await realClick("#mute-all");
    const silent = await waitFor("both tiles silent", 10, async () => {
      const chzzk = await chzzkProbe();
      if (anyVideo(chzzk, (v) => v.muted === false)) return null;
      if (!options.youtube) return { chzzk, youtube: null };
      const youtube = await youtubeProbe();
      const quiet = (youtube.videos || []).every((v) => v.muted === true || v.volume === 0);
      return quiet ? { chzzk, youtube } : null;
    }, 0.4);
    if (!silent) {
      fail("multi-audio", "#mute-all did not silence both tiles", {
        chzzk: await chzzkProbe().catch(() => null),
        youtube: options.youtube ? await youtubeProbe().catch(() => null) : null,
      });
      return;
    }
    pass("multi-audio", { bothAudible: true, isolatedMute: true, muteAll: true });
  });

  // 10 ------------------------------------------------------------------- //
  await step("persistence", async () => {
    if (!chzzkReady) { skip("persistence", "the chzzk player never became ready"); return; }
    log("reloading the viewer to check restore-on-load");
    // The old document stays alive and "complete" for a moment after the
    // reload call, so it is stamped first: without this barrier every probe
    // below could answer from the document that is about to be discarded.
    await evalPage("window.__svPreReload = true; return true;");
    await cdp.send("Page.reload", { ignoreCache: false }, pageSession);
    const back = await waitFor("viewer after reload", 30, async () => {
      const value = await evalPage(`
        return {
          pre: window.__svPreReload === true,
          ready: document.readyState === "complete",
          tiles: document.querySelectorAll(".stream-tile").length,
        };
      `).catch(() => null);
      return value && !value.pre && value.ready && value.tiles === (options.youtube ? 2 : 1) ? value : null;
    }, 0.5);
    if (!back) {
      fail("persistence", "the viewer did not come back with its tiles after the reload");
      return;
    }
    await evalPage(CAPTURE_HOOK);

    const ranges = await waitFor("restored slider values", 20, async () => {
      const value = await evalPage(`
        const read = (prefix) => document.querySelector('.volume-row[data-key^="' + prefix + '"] .volume-range')?.value ?? null;
        return { chzzk: read("chzzk:"), youtube: read("youtube:") };
      `);
      if (value?.chzzk !== "30") return null;
      if (options.youtube && value.youtube !== "40") return null;
      return value;
    }, 0.5);
    if (!ranges) {
      const value = await evalPage(`
        const read = (prefix) => document.querySelector('.volume-row[data-key^="' + prefix + '"] .volume-range')?.value ?? null;
        return { chzzk: read("chzzk:"), youtube: read("youtube:") };
      `).catch(() => null);
      fail("persistence", `the sliders did not restore 30/40 after the reload: ${JSON.stringify(value)}`, value);
      return;
    }

    // No further input from here: the frames must reach the stored volume on
    // their own, through the viewer's restore path.
    const restored = await waitFor("restored frame volumes", 20 + options.timeout, async () => {
      const chzzk = await chzzkProbe();
      if (!anyVideo(chzzk, (v) => Math.abs(v.volume - 0.3) < 0.02)) return null;
      if (!options.youtube) return { chzzk, youtube: null };
      const youtube = await youtubeProbe();
      return anyVideo(youtube, (v) => Math.abs(v.volume - 0.4) < 0.02) ? { chzzk, youtube } : null;
    }, 0.5);
    if (!restored) {
      fail("persistence", "the frames did not return to 0.3 / 0.4 without further input", {
        ranges,
        chzzk: await chzzkProbe().catch(() => null),
        youtube: options.youtube ? await youtubeProbe().catch(() => null) : null,
      });
      return;
    }
    pass("persistence", {
      ranges,
      chzzkVolumes: restored.chzzk.videos.map((v) => v.volume),
      youtubeVolumes: restored.youtube ? restored.youtube.videos.map((v) => v.volume) : null,
    });
  });

  // 11 ------------------------------------------------------------------- //
  await step("vod-activity-relay", async () => {
    if (!chzzkReady) { skip("vod-activity-relay", "the chzzk player never became ready"); return; }
    const rect = await rectOf(CHZZK_TILE);
    if (!rect) { fail("vod-activity-relay", "the chzzk tile has no box to move the pointer over"); return; }

    // The frame-side counter separates "the relay is broken" from "the
    // synthetic pointer never reached the out-of-process frame".
    const session = await chzzkSession();
    if (session) {
      await evalIn(session, `
        window.__svPointerMoves = 0;
        if (!window.__svPointerCounter) {
          window.__svPointerCounter = true;
          document.addEventListener("pointermove", () => { window.__svPointerMoves += 1; }, true);
        }
        return true;
      `).catch(() => {});
    }

    // A first burst warms up the browser's hit-test routing into the freshly
    // reloaded child frame; only the second one is measured.
    const burst = async (steps) => {
      for (let i = 0; i < steps; i += 1) {
        await mouseMove(rect.x + (i % 5) * 4 - 8, rect.y + (i % 3) * 4 - 4);
        await sleep(0.15);
      }
    };
    await burst(3);
    await evalPage("window.__svActivity = []; return true;");
    await burst(7);

    const seen = await waitFor("viewer-activity from chzzk", 3, async () => {
      const origins = await evalPage("return window.__svActivity || [];");
      return origins.includes("https://chzzk.naver.com") ? origins : null;
    }, 0.25);
    if (!seen) {
      const probe = await chzzkProbe().catch(() => null);
      const moves = session ? await evalIn(session, "return window.__svPointerMoves ?? null;").catch(() => null) : null;
      const hook = await evalPage("return window.__svHookInstalls ?? null;").catch(() => null);
      fail(
        "vod-activity-relay",
        "no viewer-activity message from https://chzzk.naver.com within 3s" +
        (moves ? ` (the frame did see ${moves} pointermove events, so the relay itself is silent)` : " (content/frame-activity.js may not match /video/* yet)"),
        { activityRelay: probe?.activityRelay ?? null, href: probe?.href ?? null, framePointerMoves: moves, captureHookInstalls: hook },
      );
      return;
    }
    pass("vod-activity-relay", { messages: seen.length });
  });

  // 12 ------------------------------------------------------------------- //
  // Fullscreen is the original distraction-free view: the top bar, the side
  // panels and the volume panel are gone, the grid fills the screen, and only
  // the tile controls come and go with the pointer.
  let fullscreenRefused = false;
  await step("fullscreen-hides-chrome", async () => {
    // Open the volume panel first: entering fullscreen has to close it.
    const panelIsOpen = () => evalPage('return document.body.classList.contains("volume-panel-open");');
    if ((await panelIsOpen()) !== true) {
      await realClick("#volume-toggle");
      await waitFor("volume panel open before fullscreen", 2, async () => (await panelIsOpen()) === true, 0.15);
    }
    const panelOpenBeforeEntering = (await panelIsOpen()) === true;

    await realClick("#fullscreen");
    const entered = await waitFor("fullscreen", 3, async () => {
      const value = await evalPage("return document.fullscreenElement === document.documentElement;");
      return value === true;
    }, 0.25);
    if (!entered) {
      fullscreenRefused = true;
      skip("fullscreen-hides-chrome", "headless Chrome refused to enter fullscreen, so the view could not be measured");
      skip("fullscreen-space-keeps-fullscreen", "headless Chrome refused to enter fullscreen");
      return;
    }

    const problems = [];
    const settledEntry = await waitFor("chrome hidden on entering fullscreen", 1, async () => {
      const state = await evalPage(FULLSCREEN_STATE);
      return state && fullscreenEntryProblems(state).length === 0 ? state : null;
    }, 0.1);
    const entry = settledEntry || (await evalPage(FULLSCREEN_STATE));
    if (!settledEntry) problems.push(...fullscreenEntryProblems(entry));

    // The #fullscreen click leaves focus on that button unless the viewer
    // drops it, and a focused button turns Space into a click that leaves
    // fullscreen again with the bar out of sight.
    await step("fullscreen-space-keeps-fullscreen", async () => {
      const before = await evalPage(FULLSCREEN_STATE);
      if (!before?.fullscreen) {
        skip("fullscreen-space-keeps-fullscreen", "fullscreen was already gone before Space was pressed", before);
        return;
      }
      await pressSpace();
      await sleep(0.5);
      const after = await evalPage(FULLSCREEN_STATE);
      const detail = { focusBefore: before.activeElement, fullscreenAfter: after?.fullscreen ?? null };
      if (!after?.fullscreen) {
        fail("fullscreen-space-keeps-fullscreen", `pressing Space left fullscreen (focus was on ${before.activeElement})`, detail);
        return;
      }
      pass("fullscreen-space-keeps-fullscreen", detail);
    });

    // A Space that did leave is already reported above; get back in so the
    // auto-hide is still measured.
    if (!(await enterFullscreen())) {
      if (problems.length) {
        fail("fullscreen-hides-chrome", problems.join("; "), { panelOpenBeforeEntering, entry });
      } else {
        skip("fullscreen-hides-chrome", "fullscreen could not be re-entered after the Space press, so the auto-hide was not measured", { entry });
      }
      return;
    }

    // Park the pointer on a tile. A tile is an out-of-process frame, so the
    // viewer only hears about pointer activity there through the frame relay.
    // A player can still relay a late ping of its own after the pointer
    // stops (its UI settling under the cursor), so "idle" is counted from the
    // last ping that reached the viewer, not from the park: 2.6s with nothing
    // arriving must end with the controls hidden. A relay that never goes
    // quiet is reported with the kinds it sent.
    const tileBox = (await rectOf(CHZZK_TILE)) || (await rectOf(".stream-tile"));
    const cx = tileBox ? tileBox.x : 700;
    const cy = tileBox ? tileBox.y : 450;
    const IDLE_CAP_MS = 8000;
    await evalPage("window.__svActivity = []; window.__svActivityKinds = []; return true;");
    await mouseMove(cx - 24, cy - 12);
    const parkedAt = Date.now();
    let lastPingAt = parkedAt;
    let pings = 0;
    let idle = null;
    let idleHidden = false;
    for (;;) {
      await sleep(0.2);
      const count = await evalPage("return (window.__svActivity || []).length;");
      if (count > pings) {
        pings = count;
        lastPingAt = Date.now();
      }
      idle = await evalPage(tileHeaderState(cx - 24, cy - 12));
      idleHidden = !!idle?.controlsHidden && idle.headers.length > 0 && idle.headers.every((h) => h.opacity === "0");
      if (idleHidden) break;
      if (Date.now() - lastPingAt >= 2600 || Date.now() - parkedAt >= IDLE_CAP_MS) break;
    }
    const idleTiming = {
      afterParkMs: Date.now() - parkedAt,
      quietMs: Date.now() - lastPingAt,
      framePings: pings,
      pingKinds: await evalPage("return window.__svActivityKinds || [];").catch(() => null),
    };
    if (!idleHidden) {
      const why = Date.now() - lastPingAt >= 2600
        ? "2.6s after the last activity"
        : `the frames kept relaying activity with the pointer at rest (${pings} pings in ${IDLE_CAP_MS / 1000}s)`;
      problems.push(`the tile controls did not auto-hide: ${why}: ${JSON.stringify({ idle, idleTiming })}`);
    }

    // One move to a fresh point brings them back. The header also needs the
    // tile's :hover, which a pointer inside a cross-process frame may never
    // give the viewer in headless; the class flip is the viewer's own part.
    const tx = cx + 24;
    const ty = cy + 12;
    await mouseMove(tx, ty);
    const woke = await waitFor("tile controls back after one move", 0.7, async () => {
      const state = await evalPage(tileHeaderState(tx, ty));
      return state && !state.controlsHidden ? state : null;
    }, 0.1);
    let shown = null;
    let hoverNote = null;
    if (!woke) {
      const state = await evalPage(tileHeaderState(tx, ty)).catch(() => null);
      problems.push(`one pointer move did not clear fullscreen-controls-hidden within 0.7s: ${JSON.stringify(state)}`);
    } else {
      shown = await waitFor("hovered tile header at opacity 1", 0.5, async () => {
        const state = await evalPage(tileHeaderState(tx, ty));
        return state?.hovered?.opacity === "1" ? state : null;
      }, 0.1);
      if (!shown) {
        const state = await evalPage(tileHeaderState(tx, ty)).catch(() => null);
        if (state?.hovered && state.hovered.hover === false) {
          hoverNote = "the tile under the pointer never matched :hover (cross-process frame in headless), so the class flip alone was accepted";
          log(`fullscreen-hides-chrome: ${hoverNote}`);
        } else {
          problems.push(`the hovered tile's .tile-header did not come back to opacity 1: ${JSON.stringify(state)}`);
        }
      }
    }

    await pressEscape();
    const EXIT_STATE = `
      return {
        released: document.fullscreenElement === null,
        fullscreenView: document.body.classList.contains("fullscreen-view"),
        controlsHidden: document.body.classList.contains("fullscreen-controls-hidden"),
        topRow: document.querySelectorAll(".stream-tile.is-top-row").length,
      };
    `;
    const exited = await waitFor("fullscreen exit", 3, async () => {
      const value = await evalPage(EXIT_STATE);
      return value && value.released && !value.fullscreenView && !value.controlsHidden && value.topRow === 0 ? value : null;
    }, 0.15);
    const exit = exited || (await evalPage(EXIT_STATE).catch(() => null));
    if (!exited) problems.push(`Escape did not leave a clean non-fullscreen state: ${JSON.stringify(exit)}`);

    const detail = { panelOpenBeforeEntering, entry, idle, idleTiming, woke, shown, hoverNote, exit };
    if (problems.length) {
      fail("fullscreen-hides-chrome", problems.join("; "), detail);
      return;
    }
    pass("fullscreen-hides-chrome", detail);
  });
  // A throw inside the step above can leave the Space check without a verdict
  // or the page still in fullscreen; neither may leak into the checks below.
  if (!checks["fullscreen-space-keeps-fullscreen"]) {
    skip("fullscreen-space-keeps-fullscreen", "fullscreen-hides-chrome stopped before the Space press");
  }
  await evalPage("if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); return true;").catch(() => {});

  // 13 ------------------------------------------------------------------- //
  await step("touch-controls", async () => {
    const headerOpacity = `
      const header = document.querySelector(".stream-tile .tile-header");
      if (!header) return null;
      return getComputedStyle(header).opacity;
    `;
    const hoverNoneMatches = () => evalPage('return matchMedia("(hover: none)").matches;');

    // Keep the pointer off every tile: :hover would reveal the header on its own.
    await mouseMove(2, 2);

    // Chrome 153 ignores the "hover" media feature passed to
    // Emulation.setEmulatedMedia (matchMedia keeps reporting hover: hover), so
    // touch emulation is the fallback that really flips the media query.
    let emulation = "setEmulatedMedia";
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "hover", value: "none" }] }, pageSession).catch(() => {});
    if ((await hoverNoneMatches()) !== true) {
      await cdp.send("Emulation.setEmulatedMedia", { features: [] }, pageSession).catch(() => {});
      emulation = "setTouchEmulationEnabled";
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, pageSession).catch(() => {});
    }
    const emulated = await hoverNoneMatches();

    const touch = emulated === true ? await waitFor("tile header shown for hover: none", 0.5, async () => {
      const opacity = await evalPage(headerOpacity);
      return opacity === "1" ? opacity : null;
    }, 0.1) : null;
    const touchOpacity = touch || (await evalPage(headerOpacity));

    // The compact layout needs a narrow viewport and (hover: none) together:
    // a narrow touch screen gets it, a narrow desktop window keeps the
    // original layout (desktop-narrow-layout). Measured while touch is on.
    let compactNarrow = null;
    let compactNarrowState = null;
    if (emulated === true) {
      await setViewport(700);
      compactNarrow = await waitFor("sv-compact under touch at 700px", 1.5, async () => {
        const state = await evalPage(LAYOUT_STATE);
        return state?.compact && state.overflowToggle && state.overflowToggle !== "none" ? state : null;
      }, 0.15);
      compactNarrowState = compactNarrow || (await evalPage(LAYOUT_STATE).catch(() => null));
      await setViewport(1400);
    }

    await cdp.send("Emulation.setEmulatedMedia", { features: [] }, pageSession).catch(() => {});
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, pageSession).catch(() => {});
    await mouseMove(2, 2);
    const pointer = await waitFor("tile header hidden again", 0.5, async () => {
      const opacity = await evalPage(headerOpacity);
      return opacity === "0" ? opacity : null;
    }, 0.1);
    const pointerOpacity = pointer || (await evalPage(headerOpacity));

    let compactGone = null;
    let compactGoneState = null;
    if (emulated === true) {
      compactGone = await waitFor("sv-compact gone after restoring width and hover", 1.5, async () => {
        const state = await evalPage(LAYOUT_STATE);
        return state && !state.compact ? state : null;
      }, 0.15);
      compactGoneState = compactGone || (await evalPage(LAYOUT_STATE).catch(() => null));
    }
    const detail = {
      emulation, hoverNoneMatched: emulated, hoverNone: touchOpacity, hoverHover: pointerOpacity,
      compactTouch700: compactNarrowState, compactRestored: compactGoneState,
    };

    if (emulated !== true) {
      skip("touch-controls", "this Chrome build could not emulate (hover: none), so neither the tile controls nor the compact layout were exercised", detail);
      return;
    }
    if (fullscreenRefused) {
      skip("touch-controls", "fullscreen-hides-chrome was inconclusive, so this check is reported as measured only", detail);
      return;
    }
    if (!touch) {
      fail("touch-controls", `.tile-header stayed at opacity ${touchOpacity} under hover: none`, detail);
      return;
    }
    if (!pointer) {
      fail("touch-controls", `.tile-header stayed at opacity ${pointerOpacity} after hover support came back`, detail);
      return;
    }
    if (!compactNarrow) {
      fail("touch-controls", `a 700px touch viewport did not get the compact layout: ${JSON.stringify(compactNarrowState)}`, detail);
      return;
    }
    if (!compactGone) {
      fail("touch-controls", `sv-compact stayed after the width and hover came back: ${JSON.stringify(compactGoneState)}`, detail);
      return;
    }
    pass("touch-controls", detail);
  });

  await cdp.send("Emulation.setEmulatedMedia", { features: [] }, pageSession).catch(() => {});
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }, pageSession).catch(() => {});
  await setViewport(1400).catch(() => {});

  // 14 ------------------------------------------------------------------- //
  await step("youtube-model-sync", async () => {
    if (!options.youtube) { skip("youtube-model-sync", "--youtube none"); return; }
    if (!youtubeReady) { skip("youtube-model-sync", "the YouTube player never became ready"); return; }
    const session = await youtubeSession();
    if (!session) { fail("youtube-model-sync", "no youtube iframe session attached"); return; }
    const model = () => evalIn(session, YOUTUBE_MODEL_PROBE);

    const before = await model();
    if (!before?.player || !before.getVolume) {
      fail(
        "youtube-model-sync",
        before?.player
          ? "#movie_player has no getVolume(), so the player model cannot be read"
          : "#movie_player is missing in the YouTube frame",
        before,
      );
      return;
    }

    await setRange('.volume-row[data-key^="youtube:"] .volume-range', 40);
    const synced = await waitFor("youtube player model at 40", 3, async () => {
      const state = await model();
      return state?.getVolume && Math.abs(state.model - 40) <= 1 ? state : null;
    }, 0.25);
    if (!synced) {
      fail(
        "youtube-model-sync",
        "#movie_player.getVolume() never came within 1 of 40 after the slider moved",
        { before, after: await model().catch(() => null) },
      );
      return;
    }

    // This is what a drag on YouTube's own slider does: the model moves and
    // drags the element with it. The viewer's value has to win both back.
    await evalIn(session, 'document.getElementById("movie_player").setVolume(10); return true;');
    const repaired = await waitFor("volume restored after setVolume(10)", 3, async () => {
      const state = await model();
      if (!state?.getVolume) return null;
      if (Math.abs(state.model - 40) > 1) return null;
      if (state.volume === null || Math.abs(state.volume - 0.4) > 0.02) return null;
      return state;
    }, 0.25);
    if (!repaired) {
      fail(
        "youtube-model-sync",
        "setVolume(10) inside the frame was not put back to <video>.volume 0.4 and model 40 within 3s",
        { synced, after: await model().catch(() => null) },
      );
      return;
    }
    pass("youtube-model-sync", { afterSlider: synced, afterPlayerWrite: repaired });
  });

  // 15 ------------------------------------------------------------------- //
  // A narrow desktop window (a mouse, so hover works) keeps the original
  // layout: the <=760px sidebar and chat overlays, the drag handle, and every
  // control in the top bar. The compact touch layout is gated on
  // (hover: none) and is covered by touch-controls.
  await step("desktop-narrow-layout", async () => {
    // Chrome resolves a displayed fixed box's `left: auto` to its used px
    // value, so the computed value reads "auto" only while the panel is
    // display: none. The box shows the same thing: anchored to the right edge
    // rather than stretched across the viewport.
    const chatAnchoredRight = (state) => state.chatLeft === "auto" ||
      (!!state.chatBox && state.chatBox.left > 1 && state.chatBox.width < state.width - 1);
    const problemsAt = (state) => {
      if (!state) return ["the viewer answered nothing"];
      const problems = [];
      if (state.compact) problems.push("body has sv-compact");
      if (state.overflowToggle && state.overflowToggle !== "none") problems.push(`#sv-overflow-toggle display is ${state.overflowToggle}`);
      if (state.sidebarPosition !== "fixed") problems.push(`.sidebar position is ${state.sidebarPosition}, expected fixed`);
      if (state.chatPosition !== "fixed") problems.push(`.chat-panel position is ${state.chatPosition}, expected fixed`);
      if (state.chatDisplay === "none") problems.push(".chat-panel stayed hidden, so its box could not be checked");
      else if (!chatAnchoredRight(state)) problems.push(`.chat-panel is a full-width overlay (left ${state.chatLeft}, box ${JSON.stringify(state.chatBox)})`);
      if (!state.dragHandle || state.dragHandle === "none") problems.push(`.drag-handle display is ${state.dragHandle}`);
      if (!state.qualityInTopbar) problems.push("#quality-select is no longer inside .topbar");
      return problems;
    };

    const results = {};
    const problems = [];
    let openedChat = false;
    try {
      for (const width of [700, 740]) {
        await setViewport(width);
        let state = await evalPage(LAYOUT_STATE);
        if (state && state.chatDisplay === "none" && !openedChat && (await rectOf("#chat-toggle"))) {
          // The chat has to be on screen for its box to mean anything.
          await realClick("#chat-toggle");
          openedChat = true;
          state = (await waitFor(`chat panel shown at ${width}px`, 2, async () => {
            const value = await evalPage(LAYOUT_STATE);
            return value && value.chatDisplay !== "none" ? value : null;
          }, 0.15)) || (await evalPage(LAYOUT_STATE));
        }
        results[`w${width}`] = state;
        for (const problem of problemsAt(state)) problems.push(`${width}px: ${problem}`);
      }
    } finally {
      await setViewport(1400);
    }

    const wide = (await waitFor("sidebar back in the flow at 1400px", 2, async () => {
      const value = await evalPage(LAYOUT_STATE);
      return value && value.sidebarPosition !== "fixed" ? value : null;
    }, 0.15)) || (await evalPage(LAYOUT_STATE).catch(() => null));
    results.w1400 = wide;
    if (!wide || wide.sidebarPosition === "fixed") problems.push(`1400px: .sidebar position is ${wide?.sidebarPosition}, expected static`);
    // Put the chat back the way the run left it.
    if (openedChat) await realClick("#chat-toggle").catch(() => {});

    const detail = { ...results, openedChat };
    if (results.w700?.hoverNone || results.w740?.hoverNone) {
      skip("desktop-narrow-layout", "(hover: none) was still emulated, so the desktop layout was not exercised", detail);
      return;
    }
    if (problems.length) {
      fail("desktop-narrow-layout", problems.join("; "), detail);
      return;
    }
    pass("desktop-narrow-layout", detail);
  });
}

// ------------------------------------------------------------------- exit ---

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = String(error?.message || error);
  failures.push(`harness: ${fatal}`);
  log(`FATAL: ${fatal}`);
} finally {
  if (options.keep) log("--keep was given, leaving Chrome running");
  else cleanup();
}

const report = {
  passed: failures.length === 0,
  failures,
  inconclusive,
  checks,
  notes,
  extensionId,
  chromeVersion,
  startedAt,
  durationMs: Date.now() - startedMs,
  options: { ...options, video: usedVideo },
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
log(`report written to ${REPORT_PATH}`);
process.exit(failures.length === 0 ? 0 : 1);
