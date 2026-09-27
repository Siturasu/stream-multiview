import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.join(here, "../Resources/ios-web/session-access-frame.js"),
  "utf8",
);

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.style = { cssText: "" };
    this.isConnected = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
  }

  setAttribute() {}

  append(...children) {
    for (const child of children) {
      child.parent = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
    }
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    const listener = this.listeners.get("click");
    if (!listener) return;
    this.owner.activation = true;
    try {
      listener({ type: "click" });
    } finally {
      this.owner.activation = false;
    }
  }

  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
    }
    this.isConnected = false;
  }
}

function fixture({ direct = true, loggedIn = false, hasAccess = false, httpOK = true, code = 200, networkError = false } = {}) {
  const state = {
    activation: false,
    fetches: 0,
    accessRequests: 0,
    reloads: 0,
    messages: [],
    loggedIn,
  };
  const top = {};
  const window = {
    self: {},
    top,
    parent: direct ? top : {},
  };
  window.parent.postMessage = (message, origin) => state.messages.push({ message, origin });
  if (direct) top.postMessage = window.parent.postMessage;

  const body = new FakeElement("body");
  body.owner = state;
  body.isConnected = true;
  const documentElement = new FakeElement("html");
  documentElement.owner = state;
  documentElement.isConnected = true;
  const document = {
    readyState: "complete",
    body,
    documentElement,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      element.owner = state;
      return element;
    },
    hasStorageAccess: async () => hasAccess,
    requestStorageAccess() {
      state.accessRequests += 1;
      if (!state.activation) throw new Error("requestStorageAccess was not called during click activation");
      return Promise.resolve();
    },
  };
  const location = {
    hostname: "chzzk.naver.com",
    pathname: "/live/channel-id",
    reload() { state.reloads += 1; },
  };
  const context = {
    window,
    document,
    location,
    fetch: async (url, options) => {
      require(url === "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus", "status request must use the CHZZK NNG user API");
      require(options.credentials === "include", "status request must carry this WebKit page's credentials");
      state.fetches += 1;
      if (networkError) throw new TypeError("fetch failed");
      return { ok: httpOK, async json() { return { code, content: { loggedIn: state.loggedIn } }; } };
    },
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    __stellaViewManagedFrame: true,
    __stellaViewViewerOrigin: "https://stream-multiview.invalid",
    __stellaViewChzzkStatusURL: "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus",
  };
  vm.runInNewContext(source, context, { filename: "session-access-frame.js" });
  return { state, body };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function require(condition, message) {
  if (!condition) throw new Error(message);
}

{
  const { state, body } = fixture({ direct: false });
  await settle();
  require(state.fetches === 0, "nested frame performed an auth status request");
  require(body.children.length === 0, "nested frame installed a session panel");
}

{
  const { state, body } = fixture({ loggedIn: false });
  await settle();
  const panel = body.children[0];
  require(panel?.className === "sv-session-panel", "signed-out frame did not show the compact panel");
  require(panel.style.cssText.includes("left:12px") && panel.style.cssText.includes("bottom:12px"), "panel is not anchored compactly");
  require(!panel.style.cssText.includes("inset:0"), "panel blocks the full playback frame");
  const actions = panel.children[2];
  const later = actions.children[0];
  later.click();
  require(body.children.length === 0, "later button did not dismiss the panel for this frame");
  require(state.reloads === 0, "dismissing the panel reloaded playback");
}

{
  const { state, body } = fixture({ loggedIn: true, hasAccess: false });
  await settle();
  require(body.children.length === 0, "authenticated playback was covered by a panel");
  require(state.messages.some(({ message }) => message.loggedIn === true), "authenticated status was not reported as a boolean");
}

{
  const { state, body } = fixture({ loggedIn: false, hasAccess: false });
  await settle();
  // The status response changes after the user completes first-party login.
  let signedIn = false;
  const contextFetchWas = state.fetches;
  const panel = body.children[0];
  const connect = panel.children[2].children[1];
  require(connect.textContent === "방송에 연결", "connect action copy regressed");
  // Replace the fixture's fetch outcome without exposing any account data.
  signedIn = true;
  state.loggedIn = signedIn;
  require(contextFetchWas === 1, "initial status request did not run exactly once");
  connect.click();
  await settle();
  require(state.accessRequests === 1, "storage access was not requested exactly once from the user click");
  require(state.reloads === 1, "successful connection did not reload the iframe");
  require(
    state.messages.some(({ message }) => message.loggedIn === true && message.hasStorageAccess === true),
    "successful connection did not report boolean auth evidence",
  );
}

console.log("PASS session access frame regression");

for (const options of [
  { httpOK: false },
  { code: 500 },
  { loggedIn: undefined, code: 500 },
  { loggedIn: "true" },
  { networkError: true },
]) {
  const { state, body } = fixture(options);
  await settle();
  require(state.messages.some(({message}) => message.loggedIn === null && message.reason === "status-unavailable"), "failed/invalid response was misreported as signed out");
  require(!state.messages.some(({message}) => message.loggedIn === true), "invalid response was reported as signed in");
  require(body.children[0].children[1].textContent.includes("확인하지 못했습니다"), "initial request failure incorrectly asks for another login");
  const connect = body.children[0].children[2].children[1];
  connect.click();
  await settle();
  require(state.reloads === 0, "failed status request reloaded playback");
  require(body.children[0].children[1].textContent.includes("확인하지 못했습니다"), "failed status check incorrectly asks the user to sign in again");
}
console.log("PASS HTTP/network/schema failures stay unknown and allow retry");
