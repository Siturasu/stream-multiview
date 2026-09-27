// Per-tile volume, evaluated against the real frame scripts.
//
// Both scripts must scale a tile without touching mute, must survive the
// iPadOS quirk where `HTMLMediaElement.volume` silently reads back 1, and
// must never build a Web Audio graph around a natively played HLS element
// (its cross-origin segments would taint the graph into silence).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const chzzkSource = fs.readFileSync(path.join(repoRoot, "content", "chzzk-main.js"), "utf8");
const youtubeSource = fs.readFileSync(
  path.join(repoRoot, "content", "youtube-volume-frame.js"),
  "utf8",
);

const viewerOrigin = "https://stream-multiview.invalid";
// Chrome extension ids are 32 letters from a to p.
const chromeViewerOrigin = `chrome-extension://${"abcdefghijklmnop".repeat(2)}`;

function check(label) {
  console.log(`ok: ${label}`);
}

// The volume decision is duplicated because the two frames run in unrelated
// realms. Keep the copies byte-identical so a fix lands in both.
{
  const controller = (source) => {
    const start = source.indexOf("  function createVolumeController(reportMode) {");
    const end = source.indexOf("\n  }\n", source.indexOf("      },\n    };", start));
    assert.ok(start > 0 && end > start, "createVolumeController must be present");
    return source.slice(start, end);
  };
  assert.equal(controller(chzzkSource), controller(youtubeSource));
  check("both frame scripts carry the same volume controller");
}

class ClassList {
  #values = new Set();
  add(...names) { names.forEach((name) => this.#values.add(name)); }
  remove(...names) { names.forEach((name) => this.#values.delete(name)); }
  contains(name) { return this.#values.has(name); }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.classList = new ClassList();
    this.dataset = {};
    this.style = { setProperty() {}, cssText: "" };
    this.parentElement = null;
    this.children = [];
    this.isConnected = true;
    this.listeners = new Map();
    this.attributes = new Map();
  }
  matches(selector) { return selector === "video" && this.tagName === "VIDEO"; }
  closest() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, target: this });
  }
  append() {}
  remove() {}
}

class FakeMediaElement extends FakeElement {
  play() {
    this.paused = false;
    return Promise.resolve();
  }
}

const nativeMediaPlay = FakeMediaElement.prototype.play;

class FakeVideoElement extends FakeMediaElement {
  constructor({ honoursVolume = true, currentSrc = "" } = {}) {
    super("video");
    this.paused = true;
    this.muted = false;
    this.defaultMuted = false;
    this.videoHeight = 0;
    this.currentSrc = currentSrc;
    this.honoursVolume = honoursVolume;
    this.volumeWrites = 0;
    this.storedVolume = 1;
  }
  get volume() { return this.storedVolume; }
  set volume(value) {
    this.volumeWrites += 1;
    // iPadOS keeps 1 here. Notify either way: a controller that answers its
    // own volumechange with another write would spin forever.
    if (this.honoursVolume) this.storedVolume = value;
    this.emit("volumechange");
  }
}

function audioSpy() {
  const log = { contexts: 0, sources: [], gains: [], resumes: 0 };
  log.AudioContext = class FakeAudioContext {
    constructor() {
      log.contexts += 1;
      this.state = "suspended";
      this.destination = { node: "destination" };
      this.attached = [];
    }
    createMediaElementSource(video) {
      // WebKit throws on a second call for the same element.
      if (this.attached.includes(video)) throw new Error("InvalidStateError");
      this.attached.push(video);
      log.sources.push(video);
      return { video, connect: (target) => target };
    }
    createGain() {
      const gain = { gain: { value: 1 }, connect: (target) => target };
      log.gains.push(gain);
      return gain;
    }
    resume() {
      log.resumes += 1;
      this.state = "running";
      return Promise.resolve();
    }
  };
  return log;
}

// The wrapped play() restores a tile's audio only after its play promise
// settles. Let that finish before asserting on mute.
async function settle() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

// Messages are built inside the vm realm; compare them as plain data.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function capabilities(parent) {
  return plain(parent.messages).filter(({ message }) => message.type === "volume-capability");
}

function runChzzkFrame({ videos = [], audio = audioSpy() } = {}) {
  // Each page-world execution owns its DOM prototypes; reset the play wrapper
  // the previous run installed on the shared test double.
  FakeMediaElement.prototype.play = nativeMediaPlay;
  const windowListeners = new Map();
  const parent = {
    messages: [],
    postMessage(message, origin) { this.messages.push({ message, origin }); },
  };
  const root = new FakeElement("html");
  let mutationCallback = null;
  const document = {
    documentElement: root,
    body: new FakeElement("body"),
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === "video" ? videos : []; },
    addEventListener() {},
    createElement(tagName) { return new FakeElement(tagName); },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Promise,
    Set,
    Object,
    JSON,
    Element: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    HTMLVideoElement: FakeVideoElement,
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
    AudioContext: audio.AudioContext,
    document,
    localStorage: { setItem() {} },
    location: {
      search: "?sv=1&grid=1",
      pathname: "/live/abcdef",
      href: "https://chzzk.naver.com/live/abcdef?sv=1&grid=1",
    },
    window: {
      self: {},
      top: {},
      parent,
      addEventListener(type, listener) { windowListeners.set(type, listener); },
      setTimeout() { return 1; },
      clearTimeout() {},
    },
    __stellaViewViewerOrigin: viewerOrigin,
  });
  vm.runInContext(chzzkSource, context, { filename: "content/chzzk-main.js" });
  return {
    parent,
    audio,
    videos,
    send(data, { origin = viewerOrigin, source = parent } = {}) {
      windowListeners.get("message")?.({ source, origin, data });
    },
    addVideo(video) {
      videos.push(video);
      mutationCallback?.([{ addedNodes: [video] }]);
    },
  };
}

function runYouTubeFrame({
  videos = [],
  audio = audioSpy(),
  pathname = "/embed/abcdef",
  search = "",
  origin = viewerOrigin,
  player = null,
} = {}) {
  const windowListeners = new Map();
  const parent = {
    messages: [],
    postMessage(message, target) { this.messages.push({ message, origin: target }); },
  };
  const root = new FakeElement("html");
  let mutationCallback = null;
  const document = {
    documentElement: root,
    body: new FakeElement("body"),
    querySelectorAll(selector) { return selector === "video" ? videos : []; },
    // YouTube's player object is optional: an embed still tearing down, or a
    // build without it, must not break the element path.
    getElementById(id) { return id === "movie_player" ? player : null; },
    addEventListener() {},
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Promise,
    Set,
    Object,
    Element: FakeElement,
    HTMLMediaElement: FakeMediaElement,
    HTMLVideoElement: FakeVideoElement,
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
    },
    AudioContext: audio.AudioContext,
    document,
    location: { hostname: "www.youtube.com", pathname, search },
    window: {
      self: {},
      top: {},
      parent,
      addEventListener(type, listener) { windowListeners.set(type, listener); },
    },
    __stellaViewViewerOrigin: origin,
  });
  vm.runInContext(youtubeSource, context, { filename: "content/youtube-volume-frame.js" });
  return {
    parent,
    audio,
    videos,
    send(data, { origin: messageOrigin = viewerOrigin, source = parent } = {}) {
      windowListeners.get("message")?.({ source: source, origin: messageOrigin, data });
    },
    addVideo(video) {
      videos.push(video);
      mutationCallback?.([{ addedNodes: [video] }]);
    },
  };
}

const setVolume = (volume) => ({ source: "stellaview", type: "set-volume", volume });

// (a) A cooperative element needs nothing but the setter, and mute stays
// under the separate set-muted command.
{
  const video = new FakeVideoElement({ currentSrc: "https://chzzk.naver.com/live.m3u8" });
  const frame = runChzzkFrame({ videos: [video] });
  assert.equal(capabilities(frame.parent).length, 0, "an untouched tile reports no capability");
  assert.equal(video.volumeWrites, 0, "the 1.0 default must not write to the element");

  frame.send(setVolume(0.4));
  assert.equal(video.volume, 0.4);
  assert.deepEqual(capabilities(frame.parent), [
    { message: { source: "stellaview", type: "volume-capability", supported: true, mode: "element" }, origin: viewerOrigin },
  ]);
  assert.equal(frame.audio.contexts, 0, "a working setter must not open an AudioContext");

  const writes = video.volumeWrites;
  video.emit("volumechange");
  assert.equal(video.volumeWrites, writes, "a settled element is not rewritten");
  // The site restores its own stored volume on the element.
  video.storedVolume = 1;
  video.emit("volumechange");
  assert.equal(video.volume, 0.4, "drift is corrected");
  assert.equal(capabilities(frame.parent).length, 1, "an unchanged mode is reported once");
  check("element mode: the honoured setter wins and drift is re-applied");
}

// (b) iPadOS ignores the setter. An MSE-fed element can still be scaled by a
// gain node, exactly one graph per element.
{
  const video = new FakeVideoElement({ honoursVolume: false, currentSrc: "blob:https://chzzk.naver.com/one" });
  const frame = runChzzkFrame({ videos: [video] });
  frame.send(setVolume(0.3));
  assert.equal(frame.audio.contexts, 1, "one AudioContext per frame");
  assert.deepEqual(frame.audio.sources, [video], "createMediaElementSource runs once per element");
  assert.equal(frame.audio.gains.at(-1).gain.value, 0.3);
  assert.ok(frame.audio.resumes >= 1, "the context is resumed");
  assert.deepEqual(capabilities(frame.parent).at(-1), {
    message: { source: "stellaview", type: "volume-capability", supported: true, mode: "webaudio" },
    origin: viewerOrigin,
  });

  const writes = video.volumeWrites;
  video.emit("volumechange");
  video.emit("loadedmetadata");
  assert.equal(video.volumeWrites, writes, "a known-deaf setter is not written again");
  assert.deepEqual(frame.audio.sources, [video], "no second source node for the same element");

  frame.send(setVolume(0.6));
  assert.equal(frame.audio.gains.at(-1).gain.value, 0.6, "a new request moves the gain");
  assert.deepEqual(frame.audio.sources, [video]);
  assert.equal(capabilities(frame.parent).length, 1, "the mode is reported once while it holds");

  // A second tile element, e.g. after a quality switch.
  const second = new FakeVideoElement({ honoursVolume: false, currentSrc: "blob:https://chzzk.naver.com/two" });
  frame.addVideo(second);
  assert.deepEqual(frame.audio.sources, [video, second]);
  assert.equal(frame.audio.contexts, 1, "the frame reuses its AudioContext");
  assert.equal(frame.audio.gains.at(-1).gain.value, 0.6);
  check("webaudio mode: MSE elements get one gain graph each at the requested level");
}

// (c) Native HLS. createMediaElementSource would produce a tainted, silent
// graph, so the frame reports that volume is unavailable instead.
{
  for (const currentSrc of ["data:application/vnd.apple.mpegurl,%23EXTM3U", "https://livecloud.pstatic.net/live.m3u8"]) {
    const video = new FakeVideoElement({ honoursVolume: false, currentSrc });
    const frame = runChzzkFrame({ videos: [video] });
    frame.send(setVolume(0.25));
    assert.equal(frame.audio.contexts, 0, `no AudioContext for ${currentSrc}`);
    assert.deepEqual(capabilities(frame.parent).at(-1), {
      message: { source: "stellaview", type: "volume-capability", supported: false, mode: "none" },
      origin: viewerOrigin,
    });
    const writes = video.volumeWrites;
    video.emit("volumechange");
    assert.equal(video.volumeWrites, writes, "an unsupported element is not written in a loop");
  }
  check("none mode: a cross-origin native HLS element is left alone");
}

// (d) The capability answer waits for a real element, and a later element
// inherits the last request.
{
  const frame = runChzzkFrame();
  frame.send(setVolume(0.5));
  assert.equal(capabilities(frame.parent).length, 0, "with no video there is nothing to report yet");

  const late = new FakeVideoElement({ currentSrc: "https://chzzk.naver.com/live.m3u8" });
  frame.addVideo(late);
  assert.equal(late.volume, 0.5, "a video created later gets the last requested volume");
  assert.deepEqual(capabilities(frame.parent).at(-1)?.message, {
    source: "stellaview",
    type: "volume-capability",
    supported: true,
    mode: "element",
  });
  check("capability is deferred until a video exists, and new videos inherit the request");
}

// (e) Only the real parent at the configured viewer origin may command a tile.
{
  const video = new FakeVideoElement({ currentSrc: "https://chzzk.naver.com/live.m3u8" });
  const frame = runChzzkFrame({ videos: [video] });
  await settle();
  frame.send(setVolume(0.2), { origin: "https://evil.example" });
  frame.send(setVolume(0.2), { source: {} });
  frame.send({ source: "other", type: "set-volume", volume: 0.2 });
  frame.send({ source: "stellaview", type: "set-volume", volume: "0.2" });
  frame.send({ source: "stellaview", type: "set-volume", volume: Number.NaN });
  assert.equal(video.volumeWrites, 0);
  assert.equal(capabilities(frame.parent).length, 0);
  assert.equal(video.volume, 1);

  // set-muted keeps working next to volume, and mute is not volume.
  frame.send({ source: "stellaview", type: "set-muted", muted: false });
  assert.equal(video.muted, false, "set-muted still owns mute");
  frame.send(setVolume(0));
  assert.equal(video.volume, 0);
  assert.equal(video.muted, false, "a zero volume must not mute the element");
  check("spoofed origins, spoofed senders and malformed volumes are ignored");
}

// (f) The YouTube embed frame answers only its own parent, under its own
// message source name.
{
  const video = new FakeVideoElement({ currentSrc: "https://r1---sn.googlevideo.com/videoplayback" });
  const frame = runYouTubeFrame({ videos: [video] });
  frame.send(setVolume(0.7), { origin: "https://evil.example" });
  frame.send(setVolume(0.7), { source: {} });
  assert.equal(video.volumeWrites, 0, "only the wrapper document may set a YouTube tile's volume");

  frame.send(setVolume(0.7));
  assert.equal(video.volume, 0.7);
  assert.deepEqual(plain(frame.parent.messages), [
    {
      message: { source: "stellaview-youtube", type: "volume-capability", supported: true, mode: "element" },
      origin: viewerOrigin,
    },
  ]);

  // The IFrame API writing the same value back is not a fight.
  const writes = video.volumeWrites;
  video.emit("volumechange");
  assert.equal(video.volumeWrites, writes);

  const late = new FakeVideoElement({ honoursVolume: false, currentSrc: "blob:https://www.youtube.com/late" });
  frame.addVideo(late);
  assert.deepEqual(frame.audio.sources, [late], "an MSE element still falls back to a gain node");
  assert.equal(frame.audio.gains.at(-1).gain.value, 0.7);
  assert.equal(frame.parent.messages.at(-1).message.mode, "webaudio");
  check("youtube frame: parent-only commands, stellaview-youtube replies");
}

// The gates keep the script out of every other document. Without an injected
// viewer origin the frame is a plain third-party embed unless the viewer's own
// sv=1 marker is on the URL.
{
  for (const options of [
    { pathname: "/watch" },
    { origin: null },
    { origin: null, search: "?autoplay=1" },
  ]) {
    const video = new FakeVideoElement({ currentSrc: "https://r1---sn.googlevideo.com/videoplayback" });
    const frame = runYouTubeFrame({ videos: [video], ...options });
    frame.send(setVolume(0.7));
    frame.send(setVolume(0.7), { origin: chromeViewerOrigin });
    assert.equal(video.volumeWrites, 0);
    assert.equal(frame.parent.messages.length, 0);
  }
  check("youtube frame stays inert outside /embed/ and without an injected parent origin");
}

// (g) Chrome runs the same file as a MAIN-world content script: no origin is
// injected, the viewer marks its own frames with sv=1, and the commanding
// parent must look like a chrome-extension:// viewer.
{
  const video = new FakeVideoElement({ currentSrc: "https://r1---sn.googlevideo.com/videoplayback" });
  const frame = runYouTubeFrame({ videos: [video], origin: null, search: "?sv=1" });

  frame.send(setVolume(0.7), { origin: "https://evil.example" });
  assert.equal(video.volumeWrites, 0, "a stranger cannot command a Chrome tile");
  assert.equal(frame.parent.messages.length, 0, "and gets no capability reply");

  frame.send(setVolume(0.7), { origin: chromeViewerOrigin });
  assert.equal(video.volume, 0.7);
  assert.deepEqual(plain(frame.parent.messages), [
    {
      message: { source: "stellaview-youtube", type: "volume-capability", supported: true, mode: "element" },
      origin: chromeViewerOrigin,
    },
  ]);
  check("youtube frame on Chrome: sv=1 plus a chrome-extension parent origin");
}

// (h) The panel is the single source of truth. YouTube's own volume model has
// to follow the applied element volume, or its slider shows one number while
// the sound plays another, and a drag on that slider moves only the model.
{
  const video = new FakeVideoElement({ currentSrc: "https://r1---sn.googlevideo.com/videoplayback" });
  const player = {
    volume: 100,
    writes: [],
    getVolume() { return this.volume; },
    setVolume(value) {
      this.writes.push(value);
      this.volume = value;
      // The real player pushes its model onto the media element, so every
      // model write feeds a volumechange back into the frame script.
      video.volume = value / 100;
    },
  };
  const frame = runYouTubeFrame({ videos: [video], player });

  frame.send(setVolume(0.4));
  assert.equal(video.volume, 0.4);
  assert.deepEqual(player.writes, [40], "the player model is mirrored to the requested volume");

  // Already in agreement: nothing more is written, so no volumechange loop.
  video.emit("volumechange");
  assert.deepEqual(player.writes, [40], "a model already at the target is left alone");

  // A drag on YouTube's own slider: the model moves and the element with it.
  player.volume = 10;
  video.storedVolume = 0.1;
  video.emit("volumechange");
  assert.equal(video.volume, 0.4, "an in-player drag is put back to the panel value");
  assert.deepEqual(player.writes, [40, 40], "and the model is put back with it");

  // A frame without the player object still applies the element volume.
  const bare = new FakeVideoElement({ currentSrc: "https://r1---sn.googlevideo.com/videoplayback" });
  const bareFrame = runYouTubeFrame({ videos: [bare] });
  bareFrame.send(setVolume(0.4));
  assert.equal(bare.volume, 0.4, "a missing #movie_player must not break the element path");
  check("youtube frame: the panel value drives both the element and the player model");
}

console.log("PASS per-tile volume: element/webaudio/none modes, deferred capability, origin policy");
