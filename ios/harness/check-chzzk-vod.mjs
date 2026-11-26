import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  makeChzzkVideo,
  parseStreamInput,
  sanitizeStream,
  streamKey,
  streamToChatUrl,
  streamToOriginalUrl,
  streamToPlayerUrl,
} from "../../src/shared/streams.js";

const repo = new URL("../../", import.meta.url);
const viewerSource = readFileSync(new URL("viewer.js", repo), "utf8");
const chzzkSource = readFileSync(new URL("content/chzzk-main.js", repo), "utf8");

function check(label, value) {
  assert.ok(value, label);
  console.log(`ok: ${label}`);
}

// Public VOD URLs are accepted only at the exact first-party route. Bare
// numbers remain ambiguous and are deliberately not guessed as recordings.
{
  const video = parseStreamInput("https://chzzk.naver.com/video/123456789");
  assert.deepEqual(video, { platform: "chzzk", videoId: "123456789" });
  assert.equal(streamKey(video), "chzzk:video:123456789");
  assert.equal(streamToPlayerUrl(video, { quality: "720p" }), "https://chzzk.naver.com/video/123456789?sv=1&quality=720p&grid=1");
  assert.equal(streamToOriginalUrl(video), "https://chzzk.naver.com/video/123456789");
  assert.equal(streamToChatUrl(video), null);
  check("valid CHZZK VOD URL has an isolated stream identity", true);

  for (const input of [
    "123456789",
    "https://chzzk.naver.com/video/0",
    "https://chzzk.naver.com/video/0123",
    "https://chzzk.naver.com/video/123/extra",
    "https://chzzk.naver.com.evil.example/video/123",
    "https://evil.example/video/123",
  ]) assert.equal(parseStreamInput(input), null, `reject ${input}`);
  assert.equal(sanitizeStream({ platform: "chzzk", videoId: "123", channelId: "a".repeat(32) }), null);
  assert.deepEqual(makeChzzkVideo("123"), { platform: "chzzk", videoId: "123" }, "the explicit constructor may accept a public VOD id");
  check("spoofed hosts and ambiguous VOD ids are rejected", true);
}

// Evaluate the exact viewer implementation with only its immediate state
// dependencies. This catches independent audio regressions without constructing the
// complete UI document.
{
  const match = viewerSource.match(/function setTileAudio\(key, enabled\) \{[\s\S]*?\n\}\n\nfunction setChatVisibility/);
  assert.ok(match, "tile audio source must be found");
  const calls = [];
  const first = { platform: "chzzk", channelId: "a".repeat(32) };
  const second = { platform: "chzzk", videoId: "123456789" };
  const firstKey = streamKey(first);
  const secondKey = streamKey(second);
  const context = vm.createContext({
    streams: [first, second],
    activeAudioKeys: new Set(),
    tiles: new Map([[firstKey, { id: "live" }], [secondKey, { id: "vod" }]]),
    streamKey,
    getStream: (key) => key === firstKey ? first : key === secondKey ? second : null,
    applyAudioState: (tile, stream) => calls.push({ tile: tile.id, key: streamKey(stream) }),
    updateAudioClasses: () => calls.push({ update: true }),
  });
  vm.runInContext(match[0].replace(/\nfunction setChatVisibility$/, ""), context);
  context.setTileAudio(firstKey, true);
  calls.length = 0;
  context.setTileAudio(secondKey, true);
  assert.deepEqual(calls, [{ tile: "vod", key: secondKey }, { update: true }]);
  assert.deepEqual([...context.activeAudioKeys], [firstKey, secondKey]);
  context.setTileAudio(firstKey, false);
  assert.deepEqual([...context.activeAudioKeys], [secondKey]);
  context.setTileAudio("missing", true);
  assert.deepEqual([...context.activeAudioKeys], [secondKey]);
  calls.length = 0;
  context.muteAll();
  assert.equal(context.activeAudioKeys.size, 0);
  assert.deepEqual(calls, [{ tile: "live", key: firstKey }, { tile: "vod", key: secondKey }, { update: true }]);
  check("each tile keeps independent audio and mute-all clears both", true);
}

class ClassList {
  #values = new Set();
  add(...names) { names.forEach((name) => this.#values.add(name)); }
  remove(...names) { names.forEach((name) => this.#values.delete(name)); }
  contains(name) { return this.#values.has(name); }
}

class Element {
  constructor() {
    this.classList = new ClassList();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.parentElement = null;
    this.children = [];
    this.isConnected = true;
  }
  matches() { return false; }
  closest() { return null; }
  querySelectorAll() { return []; }
  setAttribute(name, value) { (this.attributes ??= new Map()).set(name, value); }
  addEventListener(type, listener) { (this.listeners ??= new Map()).set(type, listener); }
  emit(type) { this.listeners?.get(type)?.({ target: this }); }
  append() {}
}

class HTMLMediaElement extends Element {
  play() {
    this.playSnapshots.push({
      playsInline: this.playsInline,
      muted: this.muted,
      defaultMuted: this.defaultMuted,
      playsinline: this.attributes?.get("playsinline"),
      webkitPlaysinline: this.attributes?.get("webkit-playsinline"),
    });
    this.paused = false;
    return this.playCompletion ?? Promise.resolve();
  }
}

class HTMLVideoElement extends HTMLMediaElement {
  constructor() {
    super();
    this.paused = true;
    this.muted = false;
    this.defaultMuted = false;
    this.videoHeight = 0;
    this.playSnapshots = [];
  }
}

const nativeMediaPlay = HTMLMediaElement.prototype.play;

function runChzzkFrame({ search = "", managed = false, videos = [] } = {}) {
  // Each page-world execution has its own DOM prototypes. Reset the shared
  // test double to model that isolation instead of stacking prior wrappers.
  HTMLMediaElement.prototype.play = nativeMediaPlay;
  const windowListeners = new Map();
  const documentListeners = new Map();
  const parent = { messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } };
  const root = new Element();
  const document = {
    documentElement: root,
    body: new Element(),
    querySelector(selector) {
      if (selector === ".sv-player-root video") return null;
      return null;
    },
    querySelectorAll(selector) { return selector === "video" ? videos : []; },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    createElement() { return new Element(); },
  };
  const MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Promise,
    Set,
    Object,
    JSON,
    Element,
    HTMLMediaElement,
    HTMLVideoElement,
    MutationObserver,
    document,
    localStorage: { setItem() {} },
    location: { search, pathname: "/video/123456789", href: `https://chzzk.naver.com/video/123456789${search}` },
    window: {
      self: {},
      top: {},
      parent,
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      setTimeout() { return 1; },
      clearTimeout() {},
    },
    __stellaViewManagedFrame: managed,
    __stellaViewViewerOrigin: "https://chzzk.naver.com",
  });
  vm.runInContext(chzzkSource, context, { filename: "content/chzzk-main.js" });
  return { document, parent, root, videos, dispatchMessage: (event) => windowListeners.get("message")?.(event) };
}

// A VOD redirect can lose `sv=1`; only the wrapper's explicit managed-frame
// marker may keep the native player code active in that case.
{
  const unmanaged = runChzzkFrame();
  assert.equal(unmanaged.root.classList.contains("sv-embedded"), false);
  const managed = runChzzkFrame({ managed: true });
  assert.equal(managed.root.classList.contains("sv-embedded"), true);
  check("sv-less VOD navigation activates only a managed native frame", true);
}

// The exact content script is evaluated before `play()`: a freshly-created
// VOD video is inline and muted before the player sees its original method.
{
  const tracked = new HTMLVideoElement();
  const frame = runChzzkFrame({ search: "?sv=1", videos: [tracked] });
  await Promise.resolve();
  tracked.emit("playing");
  const fresh = new HTMLVideoElement();
  fresh.play();
  assert.deepEqual(fresh.playSnapshots[0], {
    playsInline: true,
    muted: true,
    defaultMuted: true,
    playsinline: "",
    webkitPlaysinline: "",
  });

  // A non-parent or wrong-origin command cannot alter audio. The configured
  // wrapper origin and parent WindowProxy are both required.
  tracked.muted = false;
  tracked.defaultMuted = false;
  frame.dispatchMessage({
    source: {}, origin: "https://chzzk.naver.com",
    data: { source: "stellaview", type: "set-muted", muted: false },
  });
  assert.equal(tracked.muted, false, "spoofed WindowProxy is ignored");
  frame.dispatchMessage({
    source: frame.parent, origin: "https://evil.example",
    data: { source: "stellaview", type: "set-muted", muted: false },
  });
  assert.equal(tracked.muted, false, "spoofed origin is ignored");
  frame.dispatchMessage({
    source: frame.parent, origin: "https://chzzk.naver.com",
    data: { source: "stellaview", type: "set-muted", muted: false },
  });
  assert.equal(tracked.muted, false, "valid parent can unmute");
  assert.equal(tracked.defaultMuted, false, "valid parent updates default audio state");
  tracked.muted = true;
  tracked.defaultMuted = true;
  tracked.emit("volumechange");
  assert.equal(tracked.muted, false, "site volumechange cannot replace the selected audio state");
  assert.equal(tracked.defaultMuted, false);
  tracked.paused = true;
  const startsBeforeMute = tracked.playSnapshots.length;
  frame.dispatchMessage({
    source: frame.parent, origin: "https://chzzk.naver.com",
    data: { source: "stellaview", type: "set-muted", muted: false },
  });
  tracked.emit("resize");
  tracked.emit("loadedmetadata");
  assert.equal(tracked.playSnapshots.length, startsBeforeMute, "audio and layout updates preserve a paused video");
  let finishPlay;
  tracked.playCompletion = new Promise((resolve) => { finishPlay = resolve; });
  const restarted = tracked.play();
  assert.equal(tracked.playSnapshots.at(-1).muted, true, "even an audio-enabled tile restarts muted so it cannot interrupt another player");
  tracked.emit("play");
  assert.equal(tracked.muted, true, "play event is too early to restore audio");
  tracked.emit("playing");
  assert.equal(tracked.muted, true, "playing event may precede WebKit media admission");
  finishPlay();
  await restarted;
  assert.equal(tracked.muted, false, "audio selection is restored after play completion");
  assert.equal(tracked.defaultMuted, false);
  tracked.paused = true;
  tracked.playCompletion = Promise.reject(new Error("interrupted"));
  await assert.rejects(tracked.play(), /interrupted/);
  assert.equal(tracked.muted, true, "failed restart stays muted without forcing playback");
  check("audio-enabled video restarts muted and restores audio only after play completes", true);
  check("new VOD videos are inline before play and parent audio policy resists spoofing/site changes", true);
}

console.log("CHZZK VOD parsing, independent audio, muted restart, and frame policy checks passed");
