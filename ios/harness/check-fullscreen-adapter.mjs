import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  installIOSFullscreenAdapter,
  trustedTileForFullscreenMessage,
} from "../Resources/ios-web/fullscreen-viewer.js";

const frameSource = readFileSync(new URL("../Resources/ios-web/fullscreen-frame.js", import.meta.url), "utf8");

function makeFrameContext(enabled) {
  const messages = [];
  const listeners = new Map();
  const windowListeners = new Map();
  let nativeFullscreenCalls = 0;

  class Element {
    requestFullscreen() {
      nativeFullscreenCalls += 1;
      return Promise.resolve("native");
    }
  }
  class HTMLElement extends Element {}
  class HTMLVideoElement extends HTMLElement {
    webkitEnterFullscreen() {
      nativeFullscreenCalls += 1;
    }
    webkitExitFullscreen() {
      nativeFullscreenCalls += 1;
    }
  }
  class Document {
    exitFullscreen() {
      nativeFullscreenCalls += 1;
      return Promise.resolve("native-exit");
    }
  }
  const document = new Document();
  document.fullscreenElement = null;
  document.addEventListener = (type, listener) => listeners.set(type, listener);
  document.dispatchEvent = (event) => listeners.get(event.type)?.(event);
  const window = {
    self: {},
    top: {},
    parent: { postMessage: (message, origin) => messages.push({ message, origin }) },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
  };
  const context = vm.createContext({
    URL,
    Promise,
    Element,
    HTMLElement,
    HTMLVideoElement,
    Document,
    Event: class Event { constructor(type) { this.type = type; } },
    performance: { now: () => 100 },
    document,
    window,
    globalThis: { __stellaViewIOSFullscreenAdapter: enabled, __stellaViewFullscreenParentOrigin: "https://stream-multiview.invalid" },
  });
  vm.runInContext(frameSource, context);
  return { Element, HTMLVideoElement, document, listeners, windowListeners, messages, nativeCalls: () => nativeFullscreenCalls, parent: window.parent };
}

{
  const test = makeFrameContext(true);
  await new test.Element().requestFullscreen();
  const video = new test.HTMLVideoElement();
  video.webkitEnterFullscreen();
  assert.equal(test.nativeCalls(), 0, "redirected APIs must not invoke a native surface");
  assert.deepEqual(test.messages.map(({ message, origin }) => [message.type, origin]), [
    ["request", "https://stream-multiview.invalid"],
    ["request", "https://stream-multiview.invalid"],
  ]);
  assert.equal(test.document.fullscreenElement, video, "the player frame sees its virtual fullscreen target");
  test.windowListeners.get("message")({
    source: test.parent,
    origin: "https://stream-multiview.invalid",
    data: { source: "stellaview-ios-fullscreen", type: "reset" },
  });
  assert.equal(test.document.fullscreenElement, null, "the wrapper Exit reset clears the frame state");
  await video.requestFullscreen();
  assert.equal(test.document.fullscreenElement, video, "a later player request enters again after wrapper Exit");
  await test.document.exitFullscreen();
  assert.equal(test.document.fullscreenElement, null, "the second player action can return to a virtual non-fullscreen state");
  assert.equal(test.messages.at(-1).message.type, "exit");
  const nativeVideo = new test.HTMLVideoElement();
  test.listeners.get("webkitbeginfullscreen")({ target: nativeVideo });
  assert.equal(test.nativeCalls(), 1, "bypassed native video events must call the saved native exit method");
  assert.equal(test.messages.at(-1).message.type, "request");
  test.listeners.get("pointerdown")({ type: "pointerdown" });
  assert.equal(test.messages.at(-1).message.type, "activity", "a frame tap is relayed without touching playback");
}

{
  const test = makeFrameContext(false);
  await new test.Element().requestFullscreen();
  assert.equal(test.nativeCalls(), 1, "the adapter is inert unless the wrapper opts in");
  assert.equal(test.messages.length, 0);
}

const selectedTile = { id: "selected" };
const windowA = {};
const frames = [{
  src: "https://chzzk.naver.com/live/channel?sv=1",
  contentWindow: windowA,
  closest: (selector) => selector === ".stream-tile" ? selectedTile : null,
}];
const valid = {
  source: windowA,
  origin: "https://chzzk.naver.com",
  data: { source: "stellaview-ios-fullscreen-frame", type: "request" },
};
assert.equal(trustedTileForFullscreenMessage(valid, frames, "https://stream-multiview.invalid/"), selectedTile);
assert.equal(trustedTileForFullscreenMessage({ ...valid, origin: "https://evil.example" }, frames, "https://stream-multiview.invalid/"), null);
assert.equal(trustedTileForFullscreenMessage({ ...valid, source: {} }, frames, "https://stream-multiview.invalid/"), null);
assert.equal(trustedTileForFullscreenMessage({ ...valid, data: { source: "other", type: "request" } }, frames, "https://stream-multiview.invalid/"), null);

class ClassList {
  #values = new Set();
  add(...names) { names.forEach((name) => this.#values.add(name)); }
  remove(...names) { names.forEach((name) => this.#values.delete(name)); }
  contains(name) { return this.#values.has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.#values.has(name) : Boolean(force);
    if (next) this.#values.add(name); else this.#values.delete(name);
    return next;
  }
}

class FakeNode {
  constructor() {
    this.classList = new ClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.isConnected = true;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { (this.attributes ??= new Map()).set(name, value); }
  querySelectorAll() { return []; }
}

// Exercise the actual iOS parent adapter: fullscreen starts hidden, a verified
// iframe activity signal reveals it, and inactivity hides it again without
// replacing the frame or sending any player command other than cursor state.
{
  const prior = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    adapterEnabled: globalThis.__stellaViewIOSFullscreenAdapter,
  };
  const body = new FakeNode();
  const fullscreenButton = new FakeNode();
  const tile = new FakeNode();
  const secondTile = new FakeNode();
  const frameWindow = { messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } };
  const secondFrameWindow = { messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } };
  const frame = {
    src: "https://chzzk.naver.com/video/123?sv=1",
    contentWindow: frameWindow,
    closest: () => tile,
  };
  const secondFrame = {
    src: "https://chzzk.naver.com/video/456?sv=1",
    contentWindow: secondFrameWindow,
    closest: () => secondTile,
  };
  tile.querySelectorAll = () => [frame];
  secondTile.querySelectorAll = () => [secondFrame];
  let exitButton = null;
  let wakeButton = null;
  let focusVisible = false;
  const documentListeners = new Map();
  const document = {
    body,
    documentElement: new FakeNode(),
    addEventListener(type, listener) { documentListeners.set(type, listener); },
    createElement() { return new FakeNode(); },
    querySelector(selector) {
      if (selector === "#fullscreen") return fullscreenButton;
      if (selector.includes(":focus-visible")) return focusVisible ? fullscreenButton : null;
      return null;
    },
    querySelectorAll(selector) { return selector === "iframe.stream-frame" ? [frame, secondFrame] : []; },
  };
  body.append = (node) => {
    if (node.className === "sv-ios-fullscreen-exit") exitButton = node;
    if (node.className === "sv-ios-fullscreen-wake") wakeButton = node;
  };
  const windowListeners = new Map();
  const timers = [];
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    dispatchEvent() {},
    setTimeout(callback, delay) { timers.push({ callback, delay, cancelled: false }); return timers.length - 1; },
    clearTimeout(id) { if (timers[id]) timers[id].cancelled = true; },
    visualViewport: null,
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = { href: "https://stream-multiview.invalid/" };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.__stellaViewIOSFullscreenAdapter = true;
  try {
    installIOSFullscreenAdapter();
    documentListeners.get("click")({
      target: { closest: (selector) => selector === "#fullscreen" ? fullscreenButton : null },
      preventDefault() {}, stopImmediatePropagation() {},
    });
    assert.equal(body.classList.contains("fullscreen-view"), true);
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), true, "iOS fullscreen opens without persistent chrome");
    assert.equal(frameWindow.messages.at(-1).message.hidden, true);
    windowListeners.get("pointerdown")({ target: wakeButton });
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), true, "wake layer stays in place until the tap completes");
    let wakePrevented = false;
    wakeButton.listeners.get("click")({
      preventDefault() { wakePrevented = true; }, stopImmediatePropagation() {},
    });
    assert.equal(wakePrevented, true, "first tap is consumed before it can pause a player");
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), false);
    timers.at(-1).callback();
    const beforeTileSwitch = secondFrameWindow.messages.length;
    windowListeners.get("message")({
      source: secondFrameWindow,
      origin: "https://chzzk.naver.com",
      data: { source: "stellaview-ios-fullscreen-frame", type: "request" },
      stopImmediatePropagation() {},
    });
    assert.equal(secondFrameWindow.messages.length, beforeTileSwitch + 1, "a tile switch receives the already-hidden control state");
    assert.equal(secondFrameWindow.messages.at(-1).message.hidden, true);
    const beforeOldFrameSwitch = secondFrameWindow.messages.length;
    const beforeNextFrameSwitch = frameWindow.messages.length;
    windowListeners.get("message")({
      source: frameWindow,
      origin: "https://chzzk.naver.com",
      data: { source: "stellaview-ios-fullscreen-frame", type: "request" },
      stopImmediatePropagation() {},
    });
    assert.equal(frameWindow.messages.length, beforeNextFrameSwitch + 1, "the newly-selected tile receives the hidden state");
    assert.equal(frameWindow.messages.at(-1).message.hidden, true);
    assert.equal(
      secondFrameWindow.messages.slice(beforeOldFrameSwitch).some(({ message }) => message.type === "fullscreen-controls" && message.hidden === false),
      true,
      "a switched-out tile is released instead of retaining a hidden cursor",
    );
    const originalFrame = frame;
    windowListeners.get("message")({
      source: frameWindow,
      origin: "https://chzzk.naver.com",
      data: { source: "stellaview-ios-fullscreen-frame", type: "activity" },
      stopImmediatePropagation() {},
    });
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), false, "verified embedded touch reveals controls");
    assert.equal(frameWindow.messages.at(-1).message.hidden, false);
    assert.equal(frame, originalFrame, "control reveal preserves iframe identity");
    assert.equal(timers.at(-1).delay, 1_800);
    // A touch-clicked button may retain :focus, but does not get
    // :focus-visible. It must still be hidden after inactivity.
    timers.at(-1).callback();
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), true, "touch focus does not keep fullscreen chrome visible");
    windowListeners.get("message")({
      source: frameWindow,
      origin: "https://chzzk.naver.com",
      data: { source: "stellaview-ios-fullscreen-frame", type: "activity" },
      stopImmediatePropagation() {},
    });
    focusVisible = true;
    timers.at(-1).callback();
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), false, "keyboard-visible focus keeps controls reachable");
    focusVisible = false;
    timers.at(-1).callback();
    assert.equal(body.classList.contains("fullscreen-controls-hidden"), true, "inactivity hides controls again");
  } finally {
    globalThis.document = prior.document;
    globalThis.window = prior.window;
    globalThis.location = prior.location;
    globalThis.MutationObserver = prior.MutationObserver;
    globalThis.requestAnimationFrame = prior.requestAnimationFrame;
    globalThis.__stellaViewIOSFullscreenAdapter = prior.adapterEnabled;
  }
}

// The wrapper stylesheet is a cascade partner of viewer.css, not a fork of it.
// Hiding the toolbar #fullscreen button is only correct while the adapter's own
// fullscreen is on, and the top-row header/gradient offsets stay in viewer.css
// where .is-top-row keeps them on the right tiles.
{
  const overrides = readFileSync(new URL("../Resources/ios-web/ios-overrides.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const hides = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/;
  let scoped = 0;
  for (const chunk of overrides.split("}")) {
    if (!chunk.includes("{")) continue;
    const parts = chunk.split("{");
    const selector = parts.at(-2);
    const declarations = parts.at(-1);
    if (!selector.includes("#fullscreen") || !hides.test(declarations)) continue;
    assert.ok(
      selector.includes("sv-ios-app-fullscreen") || selector.includes("sv-ios-tile-fullscreen"),
      `a rule hiding #fullscreen must be scoped to an adapter fullscreen class: ${selector.trim()}`,
    );
    scoped += 1;
  }
  assert.ok(scoped > 0, "ios-overrides.css should still hide the redundant toolbar #fullscreen button");
  for (const owned of [".tile-header", ".tile-gradient"]) {
    assert.ok(!overrides.includes(owned), `${owned} offsets belong to viewer.css, scoped by .is-top-row`);
  }
  console.log("ok: ios-overrides.css hides #fullscreen only under sv-ios-*-fullscreen and leaves tile header offsets to viewer.css");
}

console.log("fullscreen adapter frame redirect, source/origin, and reveal/hide checks passed");
