#!/usr/bin/env node
// Android verification harness for Stream Multiview.
//
// Drives the WebView of the already-running app through the Chrome DevTools
// Protocol and mirrors ios/Sources/Core/ViewerScenario.swift step for step
// (same selectors, same probes, same pass/fail rules). Prints a JSON report on
// stdout, writes android/harness/report-latest.json and exits 0/1.
//
// Usage (see run.sh, which sets up the adb forward):
//   node cdp-scenario.mjs [--channel <url|id>] [--youtube <id|url|none>]
//                         [--timeout 60] [--port 9222] [--adb /path/to/adb]
//
// --compact runs the narrow-viewport layout check instead of the playback
// scenario: it folds the device (cover screen), verifies the compact chrome and
// writes screenshots to android/harness/shots/, then unfolds again.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- options ---

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const options = {
  channel: flag("channel"),
  youtube: flag("youtube", "dQw4w9WgXcQ"),
  timeout: Number(flag("timeout", "60")),
  port: Number(flag("port", "9222")),
  adb: flag("adb", process.env.ADB || join(homedir(), "Library/Android/sdk/platform-tools/adb")),
  compact: argv.includes("--compact"),
};
if (options.youtube === "none" || options.youtube === "") options.youtube = null;
// Accept a full watch URL as well as a bare id.
if (options.youtube && options.youtube.includes("://")) {
  options.youtube = new URL(options.youtube).searchParams.get("v") || options.youtube.split("/").pop();
}
// A single protocol call should never outlive a whole step's budget. On a
// loaded emulator the renderer can stall for tens of seconds at a time.
const callTimeoutMs = Math.max(30, options.timeout) * 1000;

// ------------------------------------------------------------- reporting ---

const report = { options: { ...options }, startedAt: new Date().toISOString() };
const failures = [];
const inconclusive = [];
const log = (line) => process.stderr.write(`${line}\n`);
const fail = (message) => { failures.push(message); log(`[harness] FAIL: ${message}`); };
const pass = (message) => log(`[harness] ok: ${message}`);
const skip = (message) => { inconclusive.push(message); log(`[harness] inconclusive: ${message}`); };

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function poll(label, seconds, check, interval = 0.5) {
  const deadline = Date.now() + seconds * 1000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await sleep(interval);
  }
  log(`[harness] timeout: ${label}${lastError ? ` (last error: ${lastError})` : ""}`);
  return null;
}

// ------------------------------------------------------------------- adb ---

// `wm size` relayouts every window and can take a minute on a loaded emulator,
// so the timeout is generous and the failure carries the device's own stderr.
async function adb(...args) {
  try {
    return await execFileAsync(options.adb, args, { maxBuffer: 1 << 26, timeout: 180000 });
  } catch (error) {
    const detail = [error.stderr, error.stdout].filter(Boolean).join(" ").trim();
    throw new Error(`adb ${args.join(" ")}: ${error.killed ? "timed out" : error.message}${detail ? ` :: ${detail.slice(0, 200)}` : ""}`);
  }
}

/**
 * Physical id of the display to capture. The fold AVD has two built-in panels
 * and `screencap` without -d grabs whichever is default. dumpsys display is the
 * precise source but its dump times out on a loaded device, so SurfaceFlinger
 * (which answers from its own process) is tried first.
 */
async function innerDisplayId() {
  try {
    const { stdout } = await adb("shell", "dumpsys", "SurfaceFlinger", "--display-id");
    const active = stdout.match(/Display (\d+) \(HWC display 0\)/) || stdout.match(/Display (\d+)/);
    if (active) return active[1];
  } catch { /* fall through */ }
  try {
    const { stdout } = await adb("shell", "dumpsys", "display");
    // displayId=0 is the unfolded inner screen on the Pixel Fold AVD.
    const viewport = stdout.match(/displayId=0,\s*uniqueId='local:(\d+)'/);
    if (viewport) return viewport[1];
    const any = stdout.match(/uniqueId="local:(\d+)"/);
    if (any) return any[1];
  } catch { /* fall through */ }
  return null;
}

// ------------------------------------------------------------------- CDP ---

async function openSocket(url) {
  // Node's global WebSocket is enough here. Some WebView builds reject the
  // handshake when an Origin header is present; the `ws` package (installed
  // locally under android/harness/node_modules) sends none, so try it next.
  try {
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener("error", (event) => reject(new Error(event?.message || "websocket error")), { once: true });
    });
  } catch (error) {
    log(`[harness] global WebSocket failed (${error.message}); trying the ws package`);
    const { default: WS } = await import("ws");
    return await new Promise((resolve, reject) => {
      const socket = new WS(url, { origin: undefined, headers: {} });
      socket.on("open", () => resolve(socket));
      socket.on("error", reject);
    });
  }
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = [];
    const onMessage = (data) => {
      const message = JSON.parse(typeof data === "string" ? data : data.toString());
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.method || ""})`));
        else resolve(message.result || {});
        return;
      }
      if (message.method) for (const listener of this.listeners) listener(message);
    };
    if (typeof socket.addEventListener === "function") socket.addEventListener("message", (event) => onMessage(event.data));
    else socket.on("message", onMessage);
  }

  on(listener) { this.listeners.push(listener); }

  send(method, params = {}, sessionId = null) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A hung Runtime.evaluate means the renderer stopped answering, not
        // that the protocol dropped the reply.
        reject(new Error(`renderer did not answer ${method} within ${callTimeoutMs / 1000}s`));
      }, callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }
}

// State tracked from protocol events: execution contexts per session and the
// URL of every frame, so a probe can be evaluated inside a specific iframe.
const contexts = new Map();   // `${sessionId}:${contextId}` -> context
const frameUrls = new Map();  // `${sessionId}:${frameId}`   -> url
const sessions = new Set();
let cdp = null;
let useUniqueContextId = true;

const sessionKey = (sessionId) => sessionId ?? "";

function trackEvent(message) {
  const sid = sessionKey(message.sessionId);
  const params = message.params || {};
  switch (message.method) {
    case "Runtime.executionContextCreated": {
      const context = params.context;
      contexts.set(`${sid}:${context.id}`, {
        id: context.id,
        uniqueId: context.uniqueId,
        origin: context.origin,
        name: context.name,
        frameId: context.auxData?.frameId,
        isDefault: context.auxData?.isDefault !== false,
        sessionId: message.sessionId ?? null,
      });
      break;
    }
    case "Runtime.executionContextDestroyed":
      contexts.delete(`${sid}:${params.executionContextId}`);
      break;
    case "Runtime.executionContextsCleared":
      for (const key of [...contexts.keys()]) if (key.startsWith(`${sid}:`)) contexts.delete(key);
      break;
    case "Page.frameNavigated":
      frameUrls.set(`${sid}:${params.frame.id}`, params.frame.url);
      break;
    case "Page.frameDetached":
      frameUrls.delete(`${sid}:${params.frameId}`);
      break;
    case "Target.attachedToTarget": {
      // Out-of-process iframes arrive as their own flattened session. Workers
      // (CHZZK spawns blob: workers) auto-attach too and have no Page domain.
      const type = params.targetInfo?.type;
      if (type === "page" || type === "iframe") {
        initSession(params.sessionId).catch((error) => log(`[harness] child session init failed: ${error.message}`));
      } else {
        log(`[harness] ignoring auto-attached ${type} target`);
      }
      break;
    }
    case "Target.detachedFromTarget":
      sessions.delete(params.sessionId);
      break;
    default:
      break;
  }
}

async function initSession(sessionId) {
  sessions.add(sessionId ?? null);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId).catch(() => {});
  // DOM is how an iframe element is mapped to its frame id (see contextForIframe).
  await cdp.send("DOM.enable", {}, sessionId).catch(() => {});
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  await refreshFrames(sessionId).catch(() => {});
}

async function refreshFrames(sessionId) {
  const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
  const sid = sessionKey(sessionId);
  const walk = (node) => {
    frameUrls.set(`${sid}:${node.frame.id}`, node.frame.url);
    for (const child of node.childFrames || []) walk(child);
  };
  walk(frameTree);
}

/** Runs an async function body in a context (null = the viewer main frame). */
async function evaluate(body, context = null) {
  const params = {
    expression: `(async () => {\n${body}\n})()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  };
  if (context) {
    if (useUniqueContextId && context.uniqueId) params.uniqueContextId = context.uniqueId;
    else params.contextId = context.id;
  }
  let result;
  try {
    result = await cdp.send("Runtime.evaluate", params, context?.sessionId ?? null);
  } catch (error) {
    if (context && useUniqueContextId && /uniqueContextId/i.test(error.message)) {
      useUniqueContextId = false;
      return evaluate(body, context);
    }
    throw error;
  }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "evaluate failed");
  }
  const value = result.result?.value;
  return value === undefined ? null : value;
}

const CHZZK_FRAME_SELECTOR = '.stream-tile[data-key^="chzzk:"] .stream-frame';
const YOUTUBE_FRAME_SELECTOR = '.stream-tile[data-key^="youtube:"] .stream-frame';

/**
 * Runs a probe against the CHZZK iframe from the viewer's own main frame.
 *
 * Picking a context by frame URL is wrong here: the viewer is same-origin with
 * its chzzk frames and CHZZK leaves stale/prerender documents carrying the very
 * same URL, so a URL match can land in a document that no iframe references.
 * Reaching through the live element's `contentWindow` can only ever hit the
 * document the tile is actually showing.
 */
async function chzzkFrame(body) {
  return evaluate(`
    const frame = document.querySelector(${JSON.stringify(CHZZK_FRAME_SELECTOR)});
    if (!frame) throw new Error("no chzzk .stream-frame element in the viewer");
    const w = frame.contentWindow;
    if (!w) throw new Error("chzzk .stream-frame has no contentWindow");
    const d = w.document;
    return await (async function (document, window, globalThis, location, performance) {
${body}
    }).call(w, d, w, w, w.location, w.performance);
  `);
}

/**
 * Newest live execution context of the iframe matching `selector`. The frame id
 * comes from the element itself (DOM.describeNode), never from a URL, and
 * destroyed contexts are dropped as their events arrive, so a stale document
 * for the same URL can never be selected.
 */
async function contextForIframe(selector) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  if (!node?.frameId) return null;
  const live = [...contexts.values()].filter((context) => context.isDefault && context.frameId === node.frameId);
  return live[live.length - 1] || null;
}

// ---------------------------------------------------------------- probes ---

// ios/Sources/Core/ChzzkPlaybackEvidence.swift probeScript, verbatim.
const VIDEO_PROBE = `
const identities = globalThis.__svHarnessVideos ||= { entries: new WeakMap(), next: 0 };
const videos = [...document.querySelectorAll("video")].map((v) => {
  const source = v.currentSrc || "";
  let identity = identities.entries.get(v);
  if (!identity || identity.source !== source) {
    identity = { source, id: \`\${performance.timeOrigin}:\${++identities.next}\` };
    identities.entries.set(v, identity);
  }
  let isKnownAd = false;
  let safeSource = "";
  if (source) {
    try {
      const url = new URL(source, location.href);
      isKnownAd = url.hostname === "api.chzzk.naver.com" && url.pathname.startsWith("/service/t/");
      safeSource = url.protocol === "data:" ? "data:[inline media]" :
        \`\${url.protocol}//\${url.host}\${url.pathname}\`.slice(0, 120);
    } catch { safeSource = "unparsed-source"; }
  }
  return {
    id: identity.id, isKnownAd,
    paused: v.paused, muted: v.muted, readyState: v.readyState,
    width: v.videoWidth, height: v.videoHeight,
    currentTime: Math.round(v.currentTime * 10) / 10,
    src: safeSource,
  };
});
`;

const CHZZK_PROBE = `${VIDEO_PROBE}
const root = document.documentElement;
return {
  href: location.href.slice(0, 120),
  svEmbedded: root.classList.contains("sv-embedded"),
  qualityStatus: root.dataset.svQualityStatus || null,
  qualityLabel: root.dataset.svQualityLabel || null,
  qualityMethod: root.dataset.svQualityMethod || null,
  styleInjected: !!document.getElementById("sv-embed-style"),
  playerRoot: !!document.querySelector(".sv-player-root"),
  directHls: !!window.__stellaViewDirectHlsInstalled,
  activityRelay: root.dataset.svActivityRelay || null,
  cookie: document.cookie.includes("sv_probe=1"),
  cookieLax: document.cookie.includes("sv_probe_lax=1"),
  videos,
};
`;

const YOUTUBE_PROBE = `
const v = document.querySelector("video");
const errorNode = document.querySelector(".ytp-error, .ytp-error-content-wrap-reason, #player-unavailable, .ytp-error-content");
return {
  href: location.href.slice(0, 140),
  title: document.title,
  error: errorNode ? errorNode.textContent.trim().slice(0, 200) : null,
  cookie: document.cookie.includes("sv_probe=1"),
  cookieLax: document.cookie.includes("sv_probe_lax=1"),
  video: v ? { paused: v.paused, muted: v.muted, readyState: v.readyState, volume: v.volume, currentTime: Math.round(v.currentTime * 10) / 10 } : null,
};
`;

const CHZZK_TILE_QUERY = `
const tile = [...document.querySelectorAll('.stream-tile')].find((t) => (t.dataset.key || '').startsWith('chzzk:'));
if (!tile) return null;
return { ready: tile.dataset.playerReady || '', quality: tile.querySelector('.quality-pill')?.textContent || '', key: tile.dataset.key || '' };
`;

// Copied from android/app/src/main/java/dev/siturasu/streammultiview/ViewerWebViewController.kt
// (REFRESH_AFTER_LOGIN_JS). Kept byte-identical so the harness exercises the
// exact path MainActivity runs after an in-app login.
const REFRESH_AFTER_LOGIN_JS = `
(() => {
  const buttons = document.querySelectorAll('.tile-actions button[data-action="reload"]');
  buttons.forEach((button) => {
    const tile = button.closest('.stream-tile');
    if (tile?.dataset.key?.startsWith('youtube:')) {
      const frame = tile.querySelector('.stream-frame');
      if (frame) frame.src = frame.src;
    } else {
      button.click();
    }
  });
  const chat = document.querySelector('#chat-frame');
  const chatSource = chat?.getAttribute('src');
  if (chatSource && chatSource !== 'about:blank') chat.src = chatSource;
  return buttons.length;
})()
`;

// ChzzkPlaybackEvidence.contentVideos / .progress in JS.
const videosOf = (probe) => (probe && Array.isArray(probe.videos) ? probe.videos : []);
const contentVideos = (probe, requireAudio = false) =>
  videosOf(probe).filter((v) =>
    v.isKnownAd === false && !!v.id && !!v.src && (v.width || 0) > 0 &&
    (v.readyState || 0) >= 2 && v.paused === false && (!requireAudio || v.muted === false));

function progressBetween(first, second, requireAudio = false) {
  const previous = contentVideos(first, requireAudio);
  for (const video of contentVideos(second, requireAudio)) {
    const baseline = previous.find((item) => item.id === video.id);
    if (!baseline) continue;
    const advanced = Math.round((video.currentTime - baseline.currentTime) * 10) / 10;
    if (advanced >= 1) return { videoId: video.id, advancedSeconds: advanced, first: baseline, second: video };
  }
  return null;
}

/** Waits through pre/mid-roll ads and requires progress in the same source. */
async function waitForContentProgress(probeFrame, { requireAudio = false, reportKey }) {
  const deadline = Date.now() + options.timeout * 1000;
  let previous = null;
  let lastProbe = null;
  let knownAdObserved = false;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const probe = await probeFrame(CHZZK_PROBE);
      lastProbe = probe;
      knownAdObserved = knownAdObserved || videosOf(probe).some((v) => v.isKnownAd === true);
      const evidence = progressBetween(previous, probe, requireAudio);
      if (evidence) {
        report[reportKey] = { status: "passed", knownAdObserved, evidence };
        pass(`${reportKey}: content advanced ${evidence.advancedSeconds}s in the same video/source`);
        return { passed: true, probe };
      }
      previous = probe;
    } catch (error) {
      previous = null;
      lastError = String(error?.message || error);
    }
    await sleep(2);
  }
  report[reportKey] = {
    status: "failed", knownAdObserved, timeoutSeconds: options.timeout,
    lastProbe: lastProbe ?? "unreachable", ...(lastError ? { lastError } : {}),
  };
  fail(`${reportKey}: no same-source content progress${requireAudio ? " with audio enabled" : ""} within ${options.timeout}s (known ad observed: ${knownAdObserved})`);
  return { passed: false, probe: lastProbe };
}

/** Frame-tree URLs of the tiles' iframes, for diagnosing a frame that failed to load. */
async function streamFrameUrls() {
  for (const sessionId of [...sessions]) await refreshFrames(sessionId).catch(() => {});
  return [...frameUrls.values()].filter((url) => url && url !== "about:blank").map((url) => url.slice(0, 140));
}

// -------------------------------------------------------------- scenario ---

async function run() {
  // 1. Attach to the viewer page target.
  const targets = await (await fetch(`http://127.0.0.1:${options.port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page" && (t.url || "").includes("/__stellaview/viewer.html"));
  if (!target) {
    fail(`no viewer page target (saw: ${targets.map((t) => t.url).join(", ") || "nothing"})`);
    return;
  }
  report["target"] = { id: target.id, url: target.url, title: target.title };
  cdp = new CDP(await openSocket(target.webSocketDebuggerUrl));
  cdp.on(trackEvent);
  await initSession(null);

  // Start from a clean composition, then reload so nothing from a previous run
  // (or a manual session) leaks into the checks.
  const cleared = await evaluate(`
    await chrome.storage.local.remove(['selectedStreams', 'settings']);
    return 'cleared';
  `).catch((error) => `failed: ${error.message}`);
  report["storageCleared"] = cleared;
  await cdp.send("Page.reload", { ignoreCache: false });
  await sleep(1);

  // 2. Viewer document rendered (modules resolved, viewer.js ran).
  const memberCount = await poll("viewer render", options.timeout, async () => {
    const count = await evaluate("return document.querySelectorAll('.viewer-member').length;");
    return count > 0 ? count : null;
  });
  report["memberButtons"] = memberCount ?? 0;
  if (!memberCount) {
    fail("viewer did not render member library");
    return;
  }
  pass(`viewer rendered with ${memberCount} member buttons`);

  // The compact-layout check is a separate, opt-in scenario: it folds the
  // device and looks at chrome geometry, not at playback.
  if (options.compact) {
    await compactLayoutCheck();
    return;
  }

  // Marker for step 9: any full document reload clears it.
  const environment = await evaluate(`
    window.__svRunMarker = window.__svRunMarker || ('run-' + Date.now());
    return { marker: window.__svRunMarker, ua: navigator.userAgent, bridge: typeof stellaViewNative, chrome: typeof chrome, href: location.href };
  `);
  report["environment"] = environment;
  log(`[harness] UA: ${environment.ua}`);
  log(`[harness] typeof stellaViewNative: ${environment.bridge}`);
  if (environment.bridge !== "object") fail(`stellaViewNative bridge missing (typeof ${environment.bridge})`);

  const states = await poll("member status fetch", options.timeout, () => evaluate(`
    const states = [...document.querySelectorAll('.viewer-member-state')].map((e) => e.textContent.trim());
    return states.length && states.every((s) => s !== '…') ? states : null;
  `));
  report["memberStates"] = states ?? "timeout";
  if (!states) fail("member statuses were not fetched (native fetch bridge)");
  else pass(`member statuses: ${states.join(", ")}`);

  // 3. Script-readable probe cookies. They only prove third-party cookie
  //    visibility, not HttpOnly login. CDP needs an explicit sameSite value,
  //    so the "no attribute" iOS case is expressed as None+Secure.
  const cookieResults = [];
  const expires = Math.floor(Date.now() / 1000) + 3600;
  for (const domain of [".naver.com", ".youtube.com"]) {
    for (const [name, sameSite] of [["sv_probe", "None"], ["sv_probe_lax", "Lax"]]) {
      const outcome = await cdp.send("Network.setCookie", {
        name, value: "1", domain, path: "/", secure: true, sameSite, expires,
      }).then((result) => ({ domain, name, sameSite, success: result.success !== false }))
        .catch((error) => ({ domain, name, sameSite, success: false, error: error.message }));
      cookieResults.push(outcome);
    }
  }
  report["probeCookies"] = cookieResults;
  const cookieFailures = cookieResults.filter((c) => !c.success);
  if (cookieFailures.length) fail(`probe cookies rejected: ${JSON.stringify(cookieFailures)}`);
  else pass(`seeded ${cookieResults.length} probe cookies on .naver.com and .youtube.com`);

  // 4. Add a CHZZK stream. An explicit --channel goes through the add form; a
  //    VOD or a LIVE member exercises playback, an OFF member does not.
  let playbackExpected = false;
  if (options.channel) {
    await evaluate(`
      document.querySelector('#viewer-stream-input').value = ${JSON.stringify(options.channel)};
      document.querySelector('#viewer-add-form').requestSubmit();
      return 'submitted';
    `);
    report["chzzkTarget"] = { channel: options.channel };
    playbackExpected = true;
  } else {
    const chosen = await evaluate(`
      const members = [...document.querySelectorAll('.viewer-member')];
      const state = (b) => b.querySelector('.viewer-member-state')?.textContent.trim() || '';
      const button = members.find((b) => state(b) === 'LIVE') || members.find((b) => state(b) === 'OFF');
      if (!button) return null;
      button.click();
      return { name: button.querySelector('strong')?.textContent || '', live: state(button) === 'LIVE' };
    `).catch(() => null);
    report["chzzkTarget"] = chosen ?? "none";
    playbackExpected = chosen?.live === true;
    if (!chosen) fail("no CHZZK member button to click");
    else if (!playbackExpected) skip("no live CHZZK member; playback, quality and unmute checks are inconclusive");
  }

  const tileReady = await poll("chzzk tile handshake", options.timeout, async () => {
    const tile = await evaluate(CHZZK_TILE_QUERY);
    return tile?.ready === "1" ? tile : null;
  });
  report["chzzkTile"] = (await evaluate(CHZZK_TILE_QUERY).catch(() => null)) ?? "missing";
  if (!tileReady) fail("chzzk tile never reported player-ready");
  else pass(`chzzk tile handshake complete: ${JSON.stringify(tileReady)}`);

  // 5. Inside the chzzk iframe: no mobile redirect, injection, cookies, playback.
  const chzzkFrameUrl = await chzzkFrame("return location.href;").catch((error) => `unreachable: ${error.message}`);
  report["chzzkFrameUrl"] = chzzkFrameUrl;
  if (chzzkFrameUrl.startsWith("unreachable")) {
    fail(`the chzzk tile's iframe document is not reachable: ${chzzkFrameUrl}`);
  } else {
    const isVod = chzzkFrameUrl.includes("/video/");
    let probe = null;
    if (playbackExpected) {
      // Reuse the last sample the playback wait took: it already carries the
      // injection/cookie/quality evidence, and re-probing a stalled renderer
      // would throw away data the harness holds.
      probe = (await waitForContentProgress(chzzkFrame, { reportKey: "chzzkContentPlayback" })).probe;
    }
    if (!probe) probe = await chzzkFrame(CHZZK_PROBE).catch(() => null);
    report["chzzkFrame"] = probe ?? "unreachable";

    if (!probe) {
      fail("could not evaluate inside the chzzk frame");
    } else {
      if (probe.href.startsWith("https://chzzk.naver.com/")) pass("chzzk frame stayed on the desktop host");
      else fail(`chzzk frame navigated away (mobile redirect?): ${probe.href}`);
      if (probe.svEmbedded) pass("chzzk-main.js ran inside the iframe"); else fail("chzzk-main.js did not mark the frame (sv-embedded missing)");
      if (probe.styleInjected) pass("chzzk-embed.css injected"); else fail("chzzk-embed.css missing (#sv-embed-style)");
      // frame-activity.js only matches /live/ frames; a recording has no relay.
      if (isVod) log("[harness] frame-activity relay not expected for a VOD frame");
      else if (probe.activityRelay === "ready") pass("frame-activity.js ran in the frame");
      else fail("frame-activity.js did not run (data-sv-activity-relay missing)");
      if (probe.cookie) pass("sv_probe (SameSite=None) reached the chzzk frame"); else fail("third-party probe cookie did not reach the chzzk frame");
      if (probe.cookieLax) pass("sv_probe_lax (SameSite=Lax) reached the chzzk frame"); else fail("SameSite=Lax cookie did not reach the chzzk frame: login cookies would not apply");
      if (probe.qualityMethod === "preference") pass("quality preference written");
      else fail(`quality preference could not be written (method: ${probe.qualityMethod})`);

      report["chzzkQuality"] = { status: probe.qualityStatus, label: probe.qualityLabel, method: probe.qualityMethod };
      if (playbackExpected) {
        const status = probe.qualityStatus || "";
        if (status === "selected" || status === "already") pass(`quality ${status}: ${probe.qualityLabel}`);
        else if (status === "fallback") {
          const height = Number.parseInt(String(probe.qualityLabel || "").replace("p", ""), 10) || 0;
          if (height >= 720) pass(`quality fell back to ${probe.qualityLabel}`);
          else fail(`quality fell back below 720p: ${probe.qualityLabel}`);
        } else fail(`quality was never confirmed (status: ${status || "none"})`);
      }
    }

    const sourced = contentVideos(probe).length > 0 || videosOf(probe).some((v) => v.src);
    if (!sourced) {
      skip("no chzzk video element with a source; playback and unmute checks are inconclusive");
    } else {
      // 5b. Unmute through the viewer's audio button (postMessage -> content script).
      await evaluate(`
        const tile = [...document.querySelectorAll('.stream-tile')].find((t) => (t.dataset.key || '').startsWith('chzzk:'));
        tile?.querySelector('[data-action="audio"]')?.click();
        return 'ok';
      `).catch(() => null);
      const afterUnmute = await waitForContentProgress(chzzkFrame, { requireAudio: true, reportKey: "chzzkContentAfterUnmute" });
      report["chzzkAfterUnmute"] = afterUnmute.passed
        ? contentVideos(afterUnmute.probe, true).map((v) => ({ src: v.src, muted: v.muted, paused: v.paused, currentTime: v.currentTime }))
        : "no content progress with audio enabled";

      // 6. Volume panel: the chzzk row's slider must drive the frame's volume.
      const sliderSet = await evaluate(`
        document.querySelector('#volume-toggle')?.click();
        const row = document.querySelector('.volume-row[data-key^="chzzk:"]');
        const range = row?.querySelector('input.volume-range');
        if (!range) return null;
        range.value = '30';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        return { panelOpen: document.body.classList.contains('volume-panel-open'), disabled: range.disabled };
      `).catch(() => null);
      await sleep(1.5);
      const frameVolume = await chzzkFrame(`
        const video = [...document.querySelectorAll('video')].find((v) => v.currentSrc);
        return video ? { volume: video.volume, muted: video.muted, paused: video.paused } : null;
      `).catch(() => null);
      const rowState = await evaluate(`
        const row = document.querySelector('.volume-row[data-key^="chzzk:"]');
        const range = row?.querySelector('input.volume-range');
        if (!range) return null;
        const result = { disabled: range.disabled, value: range.value, hint: row.querySelector('.volume-hint')?.textContent || '' };
        range.value = '100';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#volume-toggle')?.click();
        return result;
      `).catch(() => null);
      report["volumePanelChzzk"] = { slider: sliderSet ?? "missing", frame: frameVolume ?? "unreachable", row: rowState ?? "missing" };
      const observed = typeof frameVolume?.volume === "number" ? frameVolume.volume : -1;
      if (!sliderSet) fail("volume panel has no row for the chzzk tile");
      else if (Math.abs(observed - 0.3) < 0.02) pass("volume slider set the chzzk frame volume to 0.3");
      else if (rowState?.disabled === true) fail("chzzk frame reported volume unsupported (slider disabled)");
      else fail(`chzzk frame volume is ${observed} after moving the slider to 30`);
    }
  }

  // 7. YouTube tile: the Referer from the https base URL must satisfy YouTube.
  if (options.youtube) {
    const watchUrl = `https://www.youtube.com/watch?v=${options.youtube}`;
    await evaluate(`
      document.querySelector('#viewer-stream-input').value = ${JSON.stringify(watchUrl)};
      document.querySelector('#viewer-add-form').requestSubmit();
      return 'submitted';
    `).catch((error) => fail(`youtube input rejected: ${error.message}`));
    const youtubeTile = await poll("youtube tile", options.timeout, () =>
      evaluate("return document.querySelector('.stream-tile[data-key^=\"youtube:\"] .platform-pill.youtube') ? 'ok' : null;"));
    if (!youtubeTile) fail("youtube tile was not created");
    await sleep(2);

    const youtubeContext = await poll("youtube embed frame", options.timeout, () => contextForIframe(YOUTUBE_FRAME_SELECTOR));
    if (!youtubeContext) {
      // A frame that failed to load sits on chrome-error://chromewebdata/;
      // saying so is the difference between an app bug and a dead network.
      const frames = await streamFrameUrls();
      report["youtubeFrameUrls"] = frames;
      const errored = frames.find((url) => url.startsWith("chrome-error:"));
      if (errored) fail(`youtube embed frame failed to load (frame is on ${errored}); tile iframe never reached www.youtube.com/embed/`);
      else fail(`no youtube embed frame context was created (frames: ${frames.join(", ")})`);
    } else {
      // Cross-origin, so the same-origin contentWindow path is unavailable: the
      // context is re-resolved from the element's frame id on every probe.
      const youtubeFrame = async (body) => {
        const context = await contextForIframe(YOUTUBE_FRAME_SELECTOR);
        if (!context) throw new Error("youtube embed frame has no live execution context");
        return evaluate(body, context);
      };
      const started = await poll("youtube playback", options.timeout, async () => {
        const sample = await youtubeFrame(YOUTUBE_PROBE);
        if (sample?.error) return sample;
        return (sample?.video?.currentTime || 0) > 0 ? sample : null;
      }, 1);
      const probe = await youtubeFrame(YOUTUBE_PROBE).catch(() => null);
      report["youtubeFrame"] = probe ?? "unreachable";
      if (probe?.error) {
        fail(`youtube player error: ${probe.error}`);
      } else if (started) {
        // An embedded player can cut to an ad or rebuffer mid-check, which
        // resets the element; accept any of three 2-second windows.
        let advanced = 0;
        let previous = probe?.video?.currentTime || 0;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await sleep(2);
          const sample = await youtubeFrame(YOUTUBE_PROBE).catch(() => null);
          const now = sample?.video?.currentTime || 0;
          advanced = Math.round((now - previous) * 10) / 10;
          previous = now;
          if (advanced >= 1) break;
        }
        report["youtubeAdvancedSeconds"] = advanced;
        if (advanced >= 1) pass(`youtube video is playing (advanced ${advanced}s in 2s)`);
        else fail(`youtube video stalled (last window advanced ${advanced}s)`);
      } else {
        fail("youtube video did not start");
      }
      if (probe?.cookie) pass("third-party cookie reached the youtube frame");
      else fail("third-party probe cookie did not reach the youtube frame");

      const ytSlider = await evaluate(`
        document.querySelector('#volume-toggle')?.click();
        const row = document.querySelector('.volume-row[data-key^="youtube:"]');
        const range = row?.querySelector('input.volume-range');
        if (!range) return null;
        range.value = '40';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
        return { disabled: range.disabled };
      `).catch(() => null);
      await sleep(1.5);
      const ytVolume = await youtubeFrame(`
        const video = document.querySelector('video');
        return video ? { volume: video.volume, muted: video.muted } : null;
      `).catch(() => null);
      await evaluate(`
        const range = document.querySelector('.volume-row[data-key^="youtube:"] input.volume-range');
        if (range) { range.value = '100'; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true })); }
        document.querySelector('#volume-toggle')?.click();
        return 'ok';
      `).catch(() => null);
      report["volumePanelYouTube"] = { slider: ytSlider ?? "missing", frame: ytVolume ?? "unreachable" };
      const ytObserved = typeof ytVolume?.volume === "number" ? ytVolume.volume : -1;
      if (!ytSlider) fail("volume panel has no row for the youtube tile");
      else if (Math.abs(ytObserved - 0.4) < 0.02) pass("volume slider set the youtube frame volume to 0.4");
      else fail(`youtube frame volume is ${ytObserved} after moving the slider to 40`);
    }
  }

  // 8. Login refresh: MainActivity runs REFRESH_AFTER_LOGIN_JS after an in-app
  //    login. The tiles (and their keys) must survive it.
  try {
    const before = await evaluate(`
      const tiles = [...document.querySelectorAll('.stream-tile')];
      const chat = document.querySelector('#chat-frame');
      globalThis.__svHarnessLogin = {
        body: document.body, tiles, marker: window.__svRunMarker,
        keys: tiles.map((tile) => tile.dataset.key),
        chatSource: chat?.getAttribute('src') || null,
      };
      return { tileCount: tiles.length, keys: tiles.map((tile) => tile.dataset.key) };
    `);
    // The controller's JS is an IIFE; `return` must stay on the same line as
    // its value or ASI turns the whole call into dead code.
    const reloadButtons = await evaluate(`return ${REFRESH_AFTER_LOGIN_JS.trim()};`);
    await sleep(2);
    const after = await evaluate(`
      const previous = globalThis.__svHarnessLogin;
      if (!previous) return { sameDocument: false };
      const tiles = [...document.querySelectorAll('.stream-tile')];
      return {
        sameDocument: document.body === previous.body && window.__svRunMarker === previous.marker,
        sameTiles: tiles.length > 0 && tiles.length === previous.tiles.length && tiles.every((tile, i) => tile === previous.tiles[i]),
        sameKeys: JSON.stringify(tiles.map((tile) => tile.dataset.key)) === JSON.stringify(previous.keys),
        sameChat: (document.querySelector('#chat-frame')?.getAttribute('src') || null) === previous.chatSource,
        tileCount: tiles.length,
        keys: tiles.map((tile) => tile.dataset.key),
      };
    `);
    report["loginRefresh"] = { before, reloadButtons, after };
    const checks = ["sameDocument", "sameTiles", "sameKeys", "sameChat"];
    if (reloadButtons !== before.tileCount) fail(`REFRESH_AFTER_LOGIN_JS saw ${reloadButtons} reload buttons for ${before.tileCount} tiles`);
    if (checks.every((name) => after[name] === true)) pass(`login refresh kept ${after.tileCount} tiles and their keys`);
    else fail(`login refresh changed the composition: ${JSON.stringify(after)}`);
  } catch (error) {
    fail(`login refresh check failed: ${error.message}`);
  }

  // 9. Window-size resilience (a DeX / fold-posture proxy). Resizing must not
  //    recreate the document: the activity handles the configuration change.
  const viewportState = "return { marker: window.__svRunMarker, tiles: [...document.querySelectorAll('.stream-tile')].map((t) => t.dataset.key), width: innerWidth, height: innerHeight };";
  try {
    const beforeResize = await evaluate(viewportState);
    let resized;
    try {
      await adb("shell", "wm", "size", "1400x900");
      await sleep(3);
      resized = await evaluate(viewportState).catch((error) => ({ error: error.message }));
    } finally {
      // Never leave the device on an override size for the next run.
      await adb("shell", "wm", "size", "reset").catch((error) => log(`[harness] wm size reset failed: ${error.message}`));
    }
    await sleep(3);
    const restored = await evaluate(viewportState).catch((error) => ({ error: error.message }));
    report["windowResize"] = { before: beforeResize, resized, restored };
    const sameDocument = resized.marker === beforeResize.marker && restored.marker === beforeResize.marker;
    const sameTiles = JSON.stringify(resized.tiles) === JSON.stringify(beforeResize.tiles) &&
      JSON.stringify(restored.tiles) === JSON.stringify(beforeResize.tiles);
    const relaidOut = resized.width !== beforeResize.width || resized.height !== beforeResize.height;
    if (!sameDocument) fail(`window resize reloaded the viewer document (marker ${beforeResize.marker} -> ${resized.marker} -> ${restored.marker})`);
    else if (!sameTiles) fail(`window resize lost tiles: ${JSON.stringify(resized.tiles)} / ${JSON.stringify(restored.tiles)}`);
    else if (!relaidOut) skip(`window resize did not change the viewport (${beforeResize.width}x${beforeResize.height}); resilience not exercised`);
    else pass(`window resize kept the same document and ${restored.tiles.length} tiles`);
  } catch (error) {
    fail(`window resize check failed: ${error.message}`);
  }
}

// ------------------------------------------------------- compact layout ---
// Optional check (--compact) for the narrow-viewport layout: fold the device
// onto the cover screen, verify the compact chrome is usable and fully inside
// the viewport, then unfold and verify the wide layout comes back. Screenshots
// go to android/harness/shots/ (git-ignored) for a human to look at.

const SHOTS = join(HERE, "shots");
const COMPACT_MAX_WIDTH = 720;

async function shot(name) {
  try {
    mkdirSync(SHOTS, { recursive: true });
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    (report["shots"] ||= []).push(file);
    return file;
  } catch (error) {
    (report["shots"] ||= []).push(`${name}: failed: ${error.message}`);
    return null;
  }
}

async function setFolded(folded) {
  await adb("emu", folded ? "fold" : "unfold");
  await sleep(3);
}

/** Bounding rects of every visible top-bar control, plus the viewport size. */
const TOPBAR_RECTS = `
const label = (el) => el.id || el.getAttribute('aria-label') || el.className || el.tagName;
const controls = [...document.querySelectorAll('.topbar button, .topbar select, .topbar .brand')]
  .filter((el) => el.getClientRects().length > 0);
return {
  width: window.innerWidth,
  height: window.innerHeight,
  compact: document.body.classList.contains('sv-compact'),
  matches: window.matchMedia('(max-width: ${COMPACT_MAX_WIDTH}px)').matches,
  controls: controls.map((el) => {
    const r = el.getBoundingClientRect();
    return { label: label(el), x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }),
};
`;

function checkTopbar(state, phase) {
  const problems = [];
  // 0.5px of tolerance: a fractional device-pixel-ratio layout rounds edges.
  for (const control of state.controls) {
    if (control.width < 1 || control.height < 1) problems.push(`${control.label} has no size`);
    if (control.x < -0.5 || control.y < -0.5) problems.push(`${control.label} starts off-screen (${control.x.toFixed(1)}, ${control.y.toFixed(1)})`);
    if (control.right > state.width + 0.5) problems.push(`${control.label} runs past the right edge (${control.right.toFixed(1)} > ${state.width})`);
    if (control.bottom > state.height + 0.5) problems.push(`${control.label} runs past the bottom edge (${control.bottom.toFixed(1)} > ${state.height})`);
  }
  for (let i = 0; i < state.controls.length; i += 1) {
    for (let j = i + 1; j < state.controls.length; j += 1) {
      const a = state.controls[i];
      const b = state.controls[j];
      const overlapX = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (overlapX > 0.5 && overlapY > 0.5) problems.push(`${a.label} overlaps ${b.label}`);
    }
  }
  if (problems.length) fail(`${phase} top bar: ${problems.join("; ")}`);
  else pass(`${phase} top bar: ${state.controls.length} controls inside ${state.width}x${state.height} with no overlap`);
  return problems;
}

async function compactLayoutCheck() {
  report["compact"] = {};

  // 1. Fold onto the cover screen and wait for the layout to switch.
  await setFolded(true);
  const folded = await poll("compact layout after fold", options.timeout, async () => {
    const state = await evaluate(TOPBAR_RECTS);
    return state.compact && state.matches ? state : null;
  });
  if (!folded) {
    const state = await evaluate(TOPBAR_RECTS).catch(() => null);
    report["compact"].folded = state;
    fail(`folding did not activate the compact layout (${JSON.stringify(state && { width: state.width, compact: state.compact })})`);
    await shot("folded-initial");
    await setFolded(false);
    return;
  }
  report["compact"].folded = { width: folded.width, height: folded.height, controls: folded.controls };
  pass(`folded viewport ${folded.width}x${folded.height} with body.sv-compact`);
  checkTopbar(folded, "folded");

  // 2. The moved controls must be inside the popover, not the bar.
  const moved = await evaluate(`
    const inPopover = (id) => Boolean(document.querySelector('#sv-overflow ' + id));
    return {
      overflowToggle: Boolean(document.querySelector('#sv-overflow-toggle')),
      quality: inPopover('#quality-select'),
      layout: inPopover('#layout-select'),
      muteAll: inPopover('#mute-all'),
      chat: inPopover('#chat-toggle'),
      sidebarClosed: document.body.classList.contains('sidebar-hidden'),
      chatClosed: document.body.classList.contains('chat-hidden'),
    };
  `);
  report["compact"].moved = moved;
  const missing = Object.entries(moved).filter(([, value]) => value !== true).map(([name]) => name);
  if (missing.length) fail(`compact chrome incomplete: ${missing.join(", ")}`);
  else pass("화질/배치/모두 음소거/채팅 moved into 더보기; drawer and chat start closed");
  await shot("folded-initial");

  // 3. Sidebar drawer over the grid.
  const drawer = await evaluate(`
    document.querySelector('#sidebar-toggle').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = document.querySelector('#sidebar');
    const r = el.getBoundingClientRect();
    const scrim = document.querySelector('#sv-scrim');
    return {
      open: !document.body.classList.contains('sidebar-hidden'),
      x: r.x, right: r.right, width: r.width, viewport: window.innerWidth,
      overlay: getComputedStyle(el).position,
      scrimVisible: scrim ? getComputedStyle(scrim).display !== 'none' : false,
    };
  `);
  report["compact"].drawer = drawer;
  await shot("folded-drawer");
  if (!drawer.open || drawer.overlay !== "fixed" || drawer.right > drawer.viewport + 0.5 || !drawer.scrimVisible) {
    fail(`sidebar drawer wrong: ${JSON.stringify(drawer)}`);
  } else {
    pass(`sidebar drawer overlays the grid (${Math.round(drawer.width)}px wide, backdrop shown)`);
  }
  await evaluate("document.querySelector('#sv-scrim').click(); return 'closed';");

  // 4. 더보기 popover.
  const popover = await evaluate(`
    document.querySelector('#sv-overflow-toggle').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const panel = document.querySelector('#sv-overflow');
    const r = panel.getBoundingClientRect();
    const items = [...panel.querySelectorAll('button, select')].map((el) => {
      const b = el.getBoundingClientRect();
      return { label: el.id || el.textContent.trim(), height: b.height, right: b.right, x: b.x };
    });
    return {
      open: document.body.classList.contains('sv-overflow-open'),
      display: getComputedStyle(panel).display,
      x: r.x, right: r.right, bottom: r.bottom,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      items,
    };
  `);
  report["compact"].popover = popover;
  await shot("folded-overflow");
  const smallItems = popover.items.filter((item) => item.height < 40);
  if (!popover.open || popover.display === "none" || popover.x < -0.5 || popover.right > popover.viewport.width + 0.5) {
    fail(`더보기 popover wrong: ${JSON.stringify({ open: popover.open, display: popover.display, x: popover.x, right: popover.right })}`);
  } else if (smallItems.length) {
    fail(`더보기 items below a 40px touch target: ${JSON.stringify(smallItems)}`);
  } else {
    pass(`더보기 popover shows ${popover.items.length} controls, all at least 40px tall`);
  }
  await evaluate("document.querySelector('#sv-overflow-toggle').click(); return 'closed';");

  // 5. A real tile and its controls (a VOD keeps the check deterministic).
  if (options.channel) {
    await evaluate(`
      document.querySelector('#viewer-stream-input').value = ${JSON.stringify(options.channel)};
      document.querySelector('#viewer-add-form').requestSubmit();
      return 'submitted';
    `);
    const tile = await poll("compact tile", options.timeout, () => evaluate(`
      const el = document.querySelector('.stream-tile');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const actions = [...el.querySelectorAll('.tile-actions button')].map((b) => {
        const a = b.getBoundingClientRect();
        return { label: b.textContent.trim() || b.getAttribute('aria-label'), height: a.height, x: a.x, right: a.right, bottom: a.bottom, visible: getComputedStyle(b).opacity !== '0' };
      });
      return { key: el.dataset.key, width: r.width, height: r.height, actions, viewport: { width: window.innerWidth, height: window.innerHeight } };
    `));
    report["compact"].tile = tile;
    // The viewer is same-origin with its chzzk frames, so the screenshot can
    // wait for the embed to actually settle instead of a fixed delay.
    const playing = await poll("folded tile playback", options.timeout, () => evaluate(`
      const frame = document.querySelector('.stream-tile .stream-frame');
      const doc = frame && frame.contentDocument;
      const video = doc && doc.querySelector('video');
      if (!video || !doc.documentElement.classList.contains('sv-embedded')) return null;
      return video.currentTime > 0.5 ? Math.round(video.currentTime * 100) / 100 : null;
    `));
    report["compact"].tilePlayback = playing ?? "not observed";
    await shot("folded-vod-tile");
    if (!tile) {
      fail("no tile appeared after adding the stream while folded");
    } else {
      const problems = tile.actions.filter((a) => a.height < 40 || a.x < -0.5 || a.right > tile.viewport.width + 0.5 || !a.visible);
      if (!tile.actions.length) fail("the tile has no visible control buttons while folded");
      else if (problems.length) fail(`tile controls unusable while folded: ${JSON.stringify(problems)}`);
      else pass(`tile ${tile.key} shows ${tile.actions.length} controls, all at least 40px tall and on-screen`);
    }
  } else {
    skip("no --channel given, so the folded tile controls were not checked");
  }

  // 6. Volume panel.
  const volume = await evaluate(`
    document.querySelector('#volume-toggle').click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const panel = document.querySelector('#volume-panel');
    const r = panel.getBoundingClientRect();
    return {
      open: document.body.classList.contains('volume-panel-open'),
      x: r.x, right: r.right, top: r.top, height: r.height,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  `);
  report["compact"].volume = volume;
  await shot("folded-volume");
  if (!volume.open || volume.x < -0.5 || volume.right > volume.viewport.width + 0.5 || volume.height > volume.viewport.height * 0.62) {
    fail(`volume panel wrong while folded: ${JSON.stringify(volume)}`);
  } else {
    pass(`volume panel spans the folded width (${Math.round(volume.right - volume.x)}px, ${Math.round(volume.height)}px tall)`);
  }
  await evaluate("document.querySelector('#volume-panel-close').click(); return 'closed';");

  // 7. Unfolding must restore the wide layout and put the controls back.
  await setFolded(false);
  const wide = await poll("wide layout after unfold", options.timeout, async () => {
    const state = await evaluate(TOPBAR_RECTS);
    return !state.compact && !state.matches ? state : null;
  });
  if (!wide) {
    fail("unfolding did not leave the compact layout");
    await shot("unfolded");
    return;
  }
  report["compact"].unfolded = { width: wide.width, height: wide.height, controls: wide.controls };
  checkTopbar(wide, "unfolded");
  const restored = await evaluate(`
    const bar = document.querySelector('.topbar');
    const inBar = (id) => Boolean(bar.querySelector(id));
    return {
      quality: inBar('#quality-select'),
      layout: inBar('#layout-select'),
      muteAll: inBar('#mute-all'),
      chat: inBar('#chat-toggle'),
      overflowHidden: getComputedStyle(document.querySelector('#sv-overflow-toggle')).display === 'none',
      sidebarOpen: !document.body.classList.contains('sidebar-hidden'),
      sidebarPosition: getComputedStyle(document.querySelector('#sidebar')).position,
    };
  `);
  report["compact"].restored = restored;
  await shot("unfolded");
  const notRestored = Object.entries(restored).filter(([, value]) => value !== true && value !== "static").map(([name]) => name);
  if (notRestored.length) fail(`wide layout not restored: ${notRestored.join(", ")} (${JSON.stringify(restored)})`);
  else pass("unfolded layout restored: controls back in the top bar, sidebar docked open");
}

// ---------------------------------------------------------------- finish ---

async function screenshot() {
  try {
    const displayId = await innerDisplayId();
    report["screenshotDisplayId"] = displayId ?? "unknown (captured the default display)";
    const command = displayId ? `screencap -d ${displayId} -p` : "screencap -p";
    const { stdout } = await execFileAsync(options.adb, ["exec-out", command], {
      encoding: "buffer", maxBuffer: 1 << 28, timeout: 120000,
    });
    if (!stdout.length) throw new Error("screencap produced no data");
    const file = join(HERE, "last-run.png");
    writeFileSync(file, stdout);
    report["screenshot"] = file;
  } catch (error) {
    report["screenshot"] = `failed: ${error.message}`;
  }
}

async function finish() {
  await screenshot();
  report["finishedAt"] = new Date().toISOString();
  report["inconclusive"] = inconclusive;
  report["failures"] = failures;
  report["passed"] = failures.length === 0;
  const text = JSON.stringify(report, null, 2);
  writeFileSync(join(HERE, "report-latest.json"), `${text}\n`);
  process.stdout.write(`${text}\n`);
  log(`[harness] ${report["passed"] ? "PASSED" : `FAILED (${failures.length})`}; ${inconclusive.length} inconclusive`);
  process.exit(report["passed"] ? 0 : 1);
}

try {
  await run();
} catch (error) {
  fail(`harness aborted: ${error?.stack || error}`);
}
await finish();
