#!/usr/bin/env node
// Layout probe for the Stream Multiview Chrome extension.
//
// Loads an extension tree (the working tree or any other checkout) into
// Chrome for Testing, adds live CHZZK channels and a YouTube video one at a
// time, and records the geometry of every tile, iframe, player root and video
// element in each layout and fullscreen state, plus a PNG screenshot per
// state. Run it against two trees with the same streams and diff the JSON.
//
// Launch and CDP plumbing is copied from check-extension.mjs so this file is
// self-contained. No npm dependencies (Node 24 global WebSocket and fetch).
//
// Usage:
//   node harness/chrome/layout-probe.mjs [--root <dir>] [--out <dir>]
//        [--channels <id,id>] [--youtube <id|none>] [--timeout 90]
//        [--size 1400x900] [--keep] [--chrome <path>] [--port <n>]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// ---------------------------------------------------------------- options ---

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const root = resolve(flag("root", REPO_ROOT));
const sizeMatch = /^(\d+)x(\d+)$/i.exec(flag("size", "1400x900"));
if (!sizeMatch) throw new Error("--size must look like 1400x900");

const options = {
  root,
  out: resolve(flag("out", join(HERE, "shots", basename(root)))),
  channels: flag("channels", "45e71a76e949e16a34764deb962f9d9f,b044e3a3b9259246bc92e863e7d3f3b8")
    .split(",").map((s) => s.trim()).filter(Boolean),
  youtube: flag("youtube", "dQw4w9WgXcQ"),
  timeout: Number(flag("timeout", "90")),
  width: Number(sizeMatch[1]),
  height: Number(sizeMatch[2]),
  keep: has("keep"),
  chrome: flag("chrome", process.env.SV_CHROME || null),
  port: Number(flag("port", "0")) || 0,
};
if (options.youtube === "none" || options.youtube === "") options.youtube = null;
if (options.channels.length < 2) throw new Error("--channels needs two live channel ids");

const LAYOUTS = ["auto", "1", "2"];
const FULLSCREEN_LAYOUTS = new Set(["auto", "1", "2"]);

// -------------------------------------------------------------- reporting ---

const log = (line) => process.stderr.write(`[probe] ${line}\n`);
const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));
const J = (value) => JSON.stringify(value);

async function waitFor(label, seconds, check, interval = 0.25) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const value = await check();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch { /* retry until the deadline */ }
    if (Date.now() >= deadline) break;
    await sleep(interval);
  }
  log(`timeout after ${seconds}s: ${label}`);
  return null;
}

const records = [];
const events = [];      // inconclusive states, ad-stuck frames, missing frames
const consoleLog = [];  // viewer page errors and warnings
const note = (kind, detail) => { events.push({ kind, detail, at: new Date().toISOString() }); log(`${kind}: ${J(detail)}`); };

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
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
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

// Viewer page errors and warnings only (frames are third-party sites).
function trackConsole(message) {
  if (!pageSession || message.sessionId !== pageSession) return;
  const params = message.params || {};
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(params.type)) {
    const text = (params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    const frame = params.stackTrace?.callFrames?.[0];
    consoleLog.push({ via: "console", level: params.type, text: text.slice(0, 500), url: frame ? `${frame.url}:${frame.lineNumber + 1}` : null });
  } else if (message.method === "Log.entryAdded" && ["error", "warning"].includes(params.entry?.level)) {
    const e = params.entry;
    consoleLog.push({ via: "log", level: e.level, source: e.source, text: String(e.text || "").slice(0, 500), url: e.url || null });
  } else if (message.method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    consoleLog.push({ via: "exception", level: "error", text: String(d.exception?.description || d.text || "").slice(0, 500), url: d.url || null });
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

/** OOPIF session for a tile's iframe: frameId first, URL match as fallback. */
async function frameSessionForKey(key, urlNeedle) {
  try {
    const { root: doc } = await cdp.send("DOM.getDocument", { depth: 1 }, pageSession);
    const selector = `.stream-tile[data-key=${J(key)}] .stream-frame`;
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.nodeId, selector }, pageSession);
    if (nodeId) {
      const { node } = await cdp.send("DOM.describeNode", { nodeId }, pageSession);
      const sessionId = node?.frameId ? sessionByTarget.get(node.frameId) : null;
      if (sessionId) return { sessionId, via: "frameId" };
    }
  } catch { /* fall through to the URL match */ }
  if (!urlNeedle) return { sessionId: null, via: null };
  let found = null;
  for (const [targetId, info] of infoByTarget) {
    if (info.type !== "iframe" || !String(info.url || "").includes(urlNeedle)) continue;
    const sessionId = sessionByTarget.get(targetId);
    if (sessionId) found = sessionId;
  }
  return { sessionId: found, via: found ? "url-fallback" : null };
}

// ------------------------------------------------------------ real input ---

let pointer = null;

async function rectOf(selector) {
  return evalPage(`
    const el = document.querySelector(${J(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  `);
}

async function mouseMove(x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x - 1, y, buttons: 0 }, pageSession);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 }, pageSession);
  pointer = { x, y };
}

async function realClick(selector) {
  const rect = await rectOf(selector);
  if (!rect) throw new Error(`no clickable element for ${selector}`);
  await mouseMove(rect.x, rect.y);
  const base = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 }, pageSession);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 }, pageSession);
  return rect;
}

async function pressEscape() {
  const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, pageSession);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, pageSession);
}

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

// ----------------------------------------------------------------- probes ---

const VIEWER_PROBE = `
const R = (el) => { const r = el.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
const describe = (el) => el ? (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "")) : null;
const box = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const s = getComputedStyle(el);
  return { display: s.display, position: s.position, opacity: s.opacity, visibility: s.visibility, transform: s.transform, zIndex: s.zIndex, pointerEvents: s.pointerEvents, rect: R(el) };
};
const grid = document.querySelector("#stream-grid");
const gs = getComputedStyle(grid);
const tiles = [...grid.querySelectorAll(".stream-tile")].map((tile) => {
  const header = tile.querySelector(".tile-header");
  const gradient = tile.querySelector(".tile-gradient");
  const frame = tile.querySelector(".stream-frame");
  const ts = getComputedStyle(tile);
  const tr = tile.getBoundingClientRect();
  const hs = header ? getComputedStyle(header) : null;
  const gss = gradient ? getComputedStyle(gradient) : null;
  let src = null;
  try { const u = new URL(frame.src); src = u.host + u.pathname; } catch {}
  // What the viewer hit-tests at points inside the tile: anything but the
  // iframe there is an overlay that sits over the video.
  const hits = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([fx, fy]) => {
    const x = Math.round(tr.left + tr.width * fx), y = Math.round(tr.top + tr.height * fy);
    const el = document.elementFromPoint(x, y);
    return { at: [x, y], isFrame: el === frame, el: describe(el) };
  });
  return {
    key: tile.dataset.key,
    rect: R(tile),
    gridColumn: tile.style.gridColumn,
    classList: [...tile.classList],
    border: ts.borderTopWidth,
    header: header ? { rect: R(header), opacity: hs.opacity, top: hs.top, transform: hs.transform, visibility: hs.visibility } : null,
    gradient: gradient ? { rect: R(gradient), opacity: gss.opacity } : null,
    iframe: frame ? { rect: R(frame), clientLeft: frame.clientLeft, clientTop: frame.clientTop, clientWidth: frame.clientWidth, clientHeight: frame.clientHeight, src } : null,
    quality: tile.querySelector(".quality-pill")?.textContent?.trim() ?? null,
    hits,
  };
});
return {
  viewport: { innerWidth, innerHeight, devicePixelRatio, htmlClientWidth: document.documentElement.clientWidth, htmlClientHeight: document.documentElement.clientHeight },
  fullscreen: document.fullscreenElement === document.documentElement,
  fullscreenElement: describe(document.fullscreenElement),
  bodyClass: document.body.className,
  htmlClass: document.documentElement.className,
  hover: { topbar: !!document.querySelector(".topbar:hover"), tile: document.querySelector(".stream-tile:hover")?.dataset.key ?? null },
  layoutValue: document.querySelector("#layout-select")?.value ?? null,
  topbar: box(".topbar"),
  sidebar: box("#sidebar"),
  chatPanel: box("#chat-panel"),
  volumePanel: box("#volume-panel"),
  grid: {
    rect: R(grid),
    gridTemplateColumns: gs.gridTemplateColumns,
    gridTemplateRows: gs.gridTemplateRows,
    trackColumns: grid.style.getPropertyValue("--grid-track-columns"),
    rows: grid.style.getPropertyValue("--grid-rows"),
    gap: gs.gap,
    padding: gs.padding,
  },
  tiles,
};
`;

const FRAME_PROBE = `
const R = (el) => { const r = el.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
const describe = (el) => el ? (el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\\s+/).slice(0, 3).join(".") : "")) : null;
const html = document.documentElement;
const docW = html.clientWidth, docH = html.clientHeight;
const selectors = ["#live_player_layout", "#player_layout", ".sv-player-root", "#movie_player"];
let root = null, matched = null;
for (const s of selectors) { const el = document.querySelector(s); if (el) { root = el; matched = s; break; } }
let playerRoot = null;
if (root) {
  const s = getComputedStyle(root);
  playerRoot = {
    selector: matched, isSvRoot: root.classList.contains("sv-player-root"), rect: R(root),
    position: s.position, top: s.top, left: s.left, width: s.width, height: s.height, display: s.display, zIndex: s.zIndex,
    offsetX: root.style.getPropertyValue("--sv-player-offset-x") || null, offsetY: root.style.getPropertyValue("--sv-player-offset-y") || null,
  };
}
const videos = [...document.querySelectorAll("video")].map((v) => {
  const s = getComputedStyle(v);
  const source = v.currentSrc || "";
  let kind = "", isKnownAd = false;
  if (source) {
    try {
      const u = new URL(source, location.href);
      isKnownAd = u.hostname === "api.chzzk.naver.com" && u.pathname.startsWith("/service/t/");
      kind = u.protocol === "blob:" ? "blob:" : u.protocol === "data:" ? "data:" : u.host;
    } catch { kind = "unparsed"; }
  }
  return {
    rect: R(v), videoWidth: v.videoWidth, videoHeight: v.videoHeight,
    objectFit: s.objectFit, objectPosition: s.objectPosition, display: s.display, visibility: s.visibility, opacity: s.opacity,
    srcKind: kind, isKnownAd, paused: v.paused, muted: v.muted, volume: Math.round(v.volume * 1000) / 1000,
    readyState: v.readyState, currentTime: Math.round(v.currentTime * 10) / 10, inPlayerRoot: root ? root.contains(v) : false,
  };
});
// Sample points across the frame: anything outside the player root is site
// chrome (header, sidebar, chat) leaking into the tile.
const hits = [[0.5, 0.5], [0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98], [0.5, 0.03], [0.5, 0.97], [0.03, 0.5], [0.97, 0.5]].map(([fx, fy]) => {
  const x = Math.round(docW * fx), y = Math.round(docH * fy);
  const el = document.elementFromPoint(x, y);
  return { at: [x, y], inRoot: !!(root && el && root.contains(el)), el: describe(el) };
});
return {
  url: (location.host + location.pathname).slice(0, 120),
  htmlClass: html.className.slice(0, 200),
  docSize: { w: docW, h: docH },
  inner: { w: innerWidth, h: innerHeight },
  scroll: { x: scrollX, y: scrollY },
  qualityStatus: html.dataset.svQualityStatus || null,
  shellHidden: document.querySelectorAll(".sv-shell-hidden").length,
  playerRoot, videos, hits,
};
`;

// ---------------------------------------------------------------- derived ---

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
const rectNear = (a, b, tol = 2) => !!a && !!b && near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.w, b.w, tol) && near(a.h, b.h, tol);
const round1 = (n) => Math.round(n * 10) / 10;

function containBox(rect, vw, vh) {
  if (!rect || !vw || !vh || !rect.w || !rect.h) return null;
  const scale = Math.min(rect.w / vw, rect.h / vh);
  const w = vw * scale, h = vh * scale;
  return { x: round1(rect.x + (rect.w - w) / 2), y: round1(rect.y + (rect.h - h) / 2), w: round1(w), h: round1(h), aspect: round1((w / h) * 1000) / 1000 };
}

function renderedBox(rect, vw, vh, fit) {
  if (!rect || !vw || !vh) return null;
  if (fit === "fill") return { ...rect, aspect: round1((rect.w / rect.h) * 1000) / 1000 };
  let scale;
  if (fit === "cover") scale = Math.max(rect.w / vw, rect.h / vh);
  else if (fit === "none") scale = 1;
  else if (fit === "scale-down") scale = Math.min(1, rect.w / vw, rect.h / vh);
  else scale = Math.min(rect.w / vw, rect.h / vh);
  const w = vw * scale, h = vh * scale;
  return { x: round1(rect.x + (rect.w - w) / 2), y: round1(rect.y + (rect.h - h) / 2), w: round1(w), h: round1(h), aspect: round1((w / h) * 1000) / 1000 };
}

/** The video that is on screen: the largest visible one, content over ads. */
function primaryVideo(videos) {
  const visible = (videos || []).filter((v) => v.rect.w > 0 && v.rect.h > 0 && v.display !== "none" && v.visibility !== "hidden");
  const pool = visible.length ? visible : (videos || []);
  return [...pool].sort((a, b) => {
    const score = (v) => (v.videoWidth > 0 ? 2 : 0) + (v.opacity !== "0" ? 1 : 0);
    return score(b) - score(a) || b.rect.w * b.rect.h - a.rect.w * a.rect.h;
  })[0] || null;
}

function derive(tile, frame) {
  const out = { iframeCoversTile: null, playerRootCoversFrame: null, videoCoversFrame: null, stretched: false, cropped: false, adOnScreen: null, siteChromeHits: null };
  const tileInner = tile.rect && tile.border
    ? { x: tile.rect.x + parseFloat(tile.border), y: tile.rect.y + parseFloat(tile.border), w: tile.rect.w - 2 * parseFloat(tile.border), h: tile.rect.h - 2 * parseFloat(tile.border) }
    : tile.rect;
  out.iframeCoversTile = tile.iframe ? rectNear(tile.iframe.rect, tile.rect) || rectNear(tile.iframe.rect, tileInner) : false;
  if (!frame) return out;
  const frameBox = { x: 0, y: 0, w: frame.docSize.w, h: frame.docSize.h };
  out.playerRootCoversFrame = frame.playerRoot ? rectNear(frame.playerRoot.rect, frameBox) : false;
  for (const v of frame.videos) {
    v.expectedContentBox = containBox(v.rect, v.videoWidth, v.videoHeight);
    v.renderedBox = renderedBox(v.rect, v.videoWidth, v.videoHeight, v.objectFit);
    const elAspect = v.rect.h ? v.rect.w / v.rect.h : 0;
    const vidAspect = v.videoHeight ? v.videoWidth / v.videoHeight : 0;
    const mismatch = elAspect && vidAspect ? Math.abs(elAspect / vidAspect - 1) > 0.02 : false;
    v.stretched = !["contain", "none", "scale-down"].includes(v.objectFit) && v.objectFit !== "cover" && mismatch;
    v.cropped = v.objectFit === "cover" && mismatch;
    v.coversFrame = rectNear(v.rect, frameBox);
    // The contain box in viewer coordinates, so it can be checked against the tile.
    if (v.expectedContentBox && tile.iframe) {
      const ox = tile.iframe.rect.x + (tile.iframe.clientLeft || 0);
      const oy = tile.iframe.rect.y + (tile.iframe.clientTop || 0);
      v.contentBoxInViewer = { x: round1(ox + v.expectedContentBox.x), y: round1(oy + v.expectedContentBox.y), w: v.expectedContentBox.w, h: v.expectedContentBox.h };
    }
  }
  const main = primaryVideo(frame.videos);
  out.primaryVideoIndex = main ? frame.videos.indexOf(main) : null;
  out.videoCoversFrame = main ? main.coversFrame : false;
  out.stretched = frame.videos.some((v) => v.stretched && v.rect.w > 0);
  out.cropped = frame.videos.some((v) => v.cropped && v.rect.w > 0);
  out.adOnScreen = main ? main.isKnownAd : null;
  // Only CHZZK has site chrome to isolate. The YouTube embed draws its own
  // overlay next to #movie_player, which is not a leak.
  out.siteChromeHits = String(frame.url).startsWith("chzzk.naver.com")
    ? frame.hits.filter((h) => !h.inRoot).map((h) => `${h.at.join(",")}:${h.el}`)
    : null;
  return out;
}

// ---------------------------------------------------------------- measure ---

async function measure() {
  const viewer = await evalPage(VIEWER_PROBE);
  for (const tile of viewer.tiles) {
    let needle = null;
    if (tile.iframe?.src) needle = tile.iframe.src;
    const { sessionId, via } = await frameSessionForKey(tile.key, needle);
    tile.frameSessionVia = via;
    tile.frame = null;
    if (sessionId) {
      try {
        tile.frame = await evalIn(sessionId, FRAME_PROBE);
      } catch (error) {
        tile.frameError = String(error?.message || error).slice(0, 200);
      }
    } else {
      tile.frameError = "no OOPIF session for this tile";
    }
    tile.derived = derive(tile, tile.frame);
  }
  return viewer;
}

async function screenshot(label) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, pageSession);
  const file = join(options.out, `${label}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

async function record(label, state, { shot = true } = {}) {
  const measurement = await measure();
  const file = shot ? await screenshot(label) : null;
  const entry = {
    label,
    tiles: measurement.tiles.length,
    layout: measurement.layoutValue,
    state,
    pointer,
    screenshot: file ? basename(file) : null,
    measurement,
  };
  records.push(entry);
  printRows(entry);
  return entry;
}

// ------------------------------------------------------------------ table ---

const dim = (r) => (r ? `${Math.round(r.w)}x${Math.round(r.h)}` : "-");
const tableRows = [];
function printRows(entry) {
  for (const tile of entry.measurement.tiles) {
    const f = tile.frame;
    const d = tile.derived || {};
    const v = f && d.primaryVideoIndex !== null && d.primaryVideoIndex !== undefined ? f.videos[d.primaryVideoIndex] : null;
    const flags = [
      d.iframeCoversTile ? "ifr=tile" : "IFR!=TILE",
      f ? (d.playerRootCoversFrame ? "root=frame" : "ROOT!=FRAME") : "noframe",
      v ? (d.videoCoversFrame ? "vid=frame" : "VID!=FRAME") : "novideo",
      d.stretched ? "STRETCHED" : "",
      d.cropped ? "CROPPED" : "",
      d.adOnScreen ? "AD" : "",
      d.siteChromeHits?.length ? `LEAK${d.siteChromeHits.length}` : "",
      tile.hits?.some((h) => !h.isFrame) ? `ovl:${tile.hits.filter((h) => !h.isFrame).map((h) => h.el).join("+")}` : "",
    ].filter(Boolean).join(" ");
    const row = [
      entry.label,
      tile.key,
      dim(tile.rect),
      dim(tile.iframe?.rect),
      dim(f?.playerRoot?.rect),
      dim(v?.rect),
      v ? `${v.videoWidth}x${v.videoHeight}` : "-",
      v?.objectFit || "-",
      flags,
    ];
    tableRows.push(row);
    process.stdout.write(`${row.join(" | ")}\n`);
  }
}

// ------------------------------------------------------------------- flow ---

async function tileKeys() {
  return evalPage('return [...document.querySelectorAll("#stream-grid .stream-tile")].map((t) => t.dataset.key);');
}

async function frameVideoState(key) {
  const src = await evalPage(`
    const f = document.querySelector(${J(`.stream-tile[data-key=${J(key)}] .stream-frame`)});
    if (!f) return null;
    try { const u = new URL(f.src); return u.host + u.pathname; } catch { return null; }
  `);
  const { sessionId } = await frameSessionForKey(key, src);
  if (!sessionId) return null;
  return evalIn(sessionId, `
    return [...document.querySelectorAll("video")].map((v) => {
      let ad = false;
      try { const u = new URL(v.currentSrc || "", location.href); ad = u.hostname === "api.chzzk.naver.com" && u.pathname.startsWith("/service/t/"); } catch {}
      return { w: v.videoWidth, h: v.videoHeight, rs: v.readyState, ad, visible: v.getBoundingClientRect().width > 0 };
    });
  `);
}

async function addAndWait(url, index) {
  const before = new Set(await tileKeys());
  await addStream(url);
  const key = await waitFor(`tile for ${url}`, 15, async () => {
    const keys = await tileKeys();
    return keys.find((k) => !before.has(k)) || null;
  });
  if (!key) {
    const message = await evalPage('return document.querySelector("#viewer-form-message")?.textContent || "";');
    note("tile-missing", { url, formMessage: message });
    return null;
  }
  log(`tile ${key} added`);
  const withVideo = await waitFor(`video in ${key}`, 25, async () => {
    const videos = await frameVideoState(key);
    return videos && videos.some((v) => v.w > 0) ? videos : null;
  }, 0.5);
  if (!withVideo) {
    const videos = await frameVideoState(key).catch(() => null);
    note("video-not-ready-after-25s", { key, videos });
  }
  await record(`add${index}-${index}tiles-auto-normal`, "after-add");
  return key;
}

async function setLayout(value) {
  await evalPage(`
    const el = document.querySelector("#layout-select");
    el.value = ${J(value)};
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  `);
  await sleep(0.4);
}

async function fullscreenCycle(prefix) {
  let entered = false;
  try {
    await realClick("#fullscreen");
    entered = await waitFor("fullscreen", 3, async () => {
      const value = await evalPage("return document.fullscreenElement === document.documentElement;");
      return value === true;
    }, 0.1);
  } catch (error) {
    note("fullscreen-click-failed", { prefix, error: String(error?.message || error) });
  }
  if (!entered) {
    note("fullscreen-refused", { prefix });
    return;
  }
  await record(`${prefix}-fullscreen-0s`, "fullscreen-0s");
  await sleep(3);
  await record(`${prefix}-fullscreen-3s`, "fullscreen-3s");
  await mouseMove(700, 450);
  await sleep(0.3);
  await record(`${prefix}-fullscreen-moved`, "fullscreen-moved");
  // One more idle stretch with the pointer resting over the grid, which shows
  // whether the chrome hides again once the pointer has left the bar.
  await sleep(3);
  await record(`${prefix}-fullscreen-moved-3s`, "fullscreen-moved-3s");
  await pressEscape();
  const exited = await waitFor("fullscreen exit", 3, async () => {
    const value = await evalPage("return document.fullscreenElement === null && !document.body.classList.contains('fullscreen-view');");
    return value === true;
  }, 0.15);
  if (!exited) {
    note("fullscreen-exit-failed", { prefix, state: await evalPage("return { fs: !!document.fullscreenElement, body: document.body.className };").catch(() => null) });
    // Leave fullscreen anyway so the next layout starts clean.
    await evalPage("if (document.fullscreenElement) await document.exitFullscreen().catch(() => {}); return true;").catch(() => {});
    await sleep(0.5);
  }
  await sleep(0.4);
  await record(`${prefix}-exited`, "exited");
}

let extensionId = null;
let chromeVersion = null;

async function main() {
  const binary = discoverChrome();
  if (!binary || !existsSync(binary)) {
    throw new Error("Chrome for Testing was not found. Run harness/chrome/install-chrome.sh once, or pass --chrome <path>.");
  }
  if (!existsSync(join(options.root, "manifest.json"))) throw new Error(`no manifest.json under ${options.root}`);
  mkdirSync(options.out, { recursive: true });
  log(`root ${options.root} -> out ${options.out}`);

  const port = options.port || (await freePort());
  profileDir = mkdtempSync(join(tmpdir(), "sv-probe-profile-"));
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${options.width},${options.height}`,
    "about:blank",
  ];
  chrome = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  chrome.stderr.on("data", () => {});
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
  cdp = new CDP(socket, 30_000);
  cdp.on(trackEvent);
  cdp.on(trackConsole);

  const loaded = await cdp.send("Extensions.loadUnpacked", { path: options.root });
  const worker = await waitFor("extension service worker", 15, async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const workers = targetInfos.filter((t) => t.type === "service_worker" && String(t.url).startsWith("chrome-extension://"));
    // Chrome for Testing runs a component extension worker of its own, so
    // only the worker under the id loadUnpacked returned counts.
    return workers.find((t) => new URL(t.url).host === loaded.id) || null;
  }, 0.3);
  extensionId = worker ? new URL(worker.url).host : loaded.id;
  log(`extension ${extensionId} (loadUnpacked said ${loaded.id})`);
  await sleep(1);

  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/viewer.html` });
  const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  pageSession = attached.sessionId;
  await initSession(pageSession);
  await cdp.send("Log.enable", {}, pageSession).catch(() => {});
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false,
  }, pageSession);

  const ready = await waitFor("viewer #stream-grid", 20, async () => {
    const value = await evalPage('return document.readyState === "complete" && !!document.querySelector("#stream-grid");');
    return value === true;
  });
  if (!ready) throw new Error("viewer.html never showed #stream-grid");
  await sleep(0.5);

  const [chzzkA, chzzkB] = options.channels;
  const plan = [`https://chzzk.naver.com/live/${chzzkA}`];
  if (options.youtube) plan.push(`https://www.youtube.com/watch?v=${options.youtube}`);
  plan.push(`https://chzzk.naver.com/live/${chzzkB}`);
  const keys = [];
  for (const [i, url] of plan.entries()) keys.push(await addAndWait(url, i + 1));

  // Give pre-roll ads and slow players the full timeout to hand over to the
  // actual content before the layout matrix is measured.
  const settled = await waitFor("all frames showing non-ad video", options.timeout, async () => {
    const states = await Promise.all(keys.filter(Boolean).map(async (key) => [key, await frameVideoState(key).catch(() => null)]));
    const ok = states.every(([, videos]) => videos && videos.some((v) => v.w > 0 && v.rs >= 2 && !v.ad && v.visible));
    return ok ? states : null;
  }, 1);
  if (!settled) {
    const states = await Promise.all(keys.filter(Boolean).map(async (key) => ({ key, videos: await frameVideoState(key).catch(() => null) })));
    note("frames-not-settled", states);
  }
  // Park the pointer outside the tiles so hover does not reveal headers.
  await mouseMove(2, options.height - 2);
  await sleep(0.4);

  for (const layout of LAYOUTS) {
    await setLayout(layout);
    const tiles = (await tileKeys()).length;
    const prefix = `${tiles}tiles-${layout}`;
    await record(`${prefix}-normal`, "normal");
    if (FULLSCREEN_LAYOUTS.has(layout)) await fullscreenCycle(prefix);
    await mouseMove(2, options.height - 2);
    await sleep(0.3);
  }
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = String(error?.stack || error?.message || error);
  log(`FATAL: ${fatal}`);
} finally {
  if (options.keep) log("--keep was given, leaving Chrome running");
  else cleanup();
}

// measurements.json is the plain record array; run.json holds the run
// metadata, inconclusive events and the viewer console errors/warnings.
const run = { root: options.root, options, chromeVersion, extensionId, fatal, events, console: consoleLog, records: records.length };
if (existsSync(options.out)) {
  writeFileSync(join(options.out, "measurements.json"), `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(join(options.out, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  log(`wrote ${join(options.out, "measurements.json")} (${records.length} records) and run.json (${consoleLog.length} console entries, ${events.length} events)`);
}
process.exit(fatal ? 1 : 0);
