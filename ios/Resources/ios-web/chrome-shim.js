// chrome.* replacement for the iPad (WKWebView) and Android (WebView) wrappers.
//
// viewer.js expects chrome.storage.local, chrome.runtime.sendMessage,
// chrome.runtime.id and chrome.tabs.create. Storage and network go through
// window.webkit.messageHandlers.stellaViewNative (NativeBridge.swift); the
// background worker's request logic is reused as plain module functions.
import { fetchChzzkMeta, fetchCimeMeta, resolveYoutubeInput } from "../background.js";
import { youtubeClientOrigin } from "../src/shared/streams.js";
import { installIOSFullscreenAdapter } from "./fullscreen-viewer.js";

// Must satisfy streams.js's CHROME_EXTENSION_ID_PATTERN (/^[a-p]{32}$/) so
// youtubeClientOrigin() yields a value; only its equality with the
// "prepare-youtube-player" reply matters here. YouTube tiles use the real
// page origin (location.origin) and the Referer WebKit sends for it.
const RUNTIME_ID = "ipadipadipadipadipadipadipadipad";
// ci.me sends no Access-Control-Allow-Origin, so its API is relayed natively too.
const NATIVE_FETCH_HOSTS = new Set(["api.chzzk.naver.com", "www.youtube.com", "ci.me"]);

// Two transports share one protocol. iOS: WKScriptMessageHandlerWithReply
// (postMessage returns a promise). Android: a WebMessageListener object whose
// replies arrive as "message" events, correlated by request id.
const nativeHandler = globalThis.webkit?.messageHandlers?.stellaViewNative ?? null;
const androidPort =
  !nativeHandler && typeof globalThis.stellaViewNative?.postMessage === "function"
    ? globalThis.stellaViewNative
    : null;
const pendingReplies = new Map();
let nextRequestId = 1;

if (androidPort) {
  androidPort.addEventListener("message", (event) => {
    let reply;
    try {
      reply = JSON.parse(event.data);
    } catch {
      return;
    }
    const pending = pendingReplies.get(reply?.id);
    if (!pending) return;
    pendingReplies.delete(reply.id);
    if (typeof reply.error === "string") pending.reject(new Error(reply.error));
    else pending.resolve(reply.result ?? null);
  });
}

async function callNative(op, payload = {}) {
  if (nativeHandler) return nativeHandler.postMessage({ op, ...payload });
  if (androidPort) {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pendingReplies.set(id, { resolve, reject });
      androidPort.postMessage(JSON.stringify({ id, op, ...payload }));
    });
  }
  throw new Error("네이티브 브리지를 사용할 수 없습니다.");
}

function parseStored(items) {
  const parsed = {};
  for (const [name, value] of Object.entries(items || {})) {
    try {
      parsed[name] = JSON.parse(value);
    } catch {
      // Ignore corrupt entries.
    }
  }
  return parsed;
}

const storageLocal = {
  async get(spec) {
    const reply = await callNative("storage.getAll");
    const stored = parseStored(reply?.items);
    if (spec === undefined || spec === null) return stored;
    if (typeof spec === "string") {
      return spec in stored ? { [spec]: stored[spec] } : {};
    }
    if (Array.isArray(spec)) {
      const result = {};
      for (const name of spec) if (name in stored) result[name] = stored[name];
      return result;
    }
    const result = {};
    for (const [name, fallback] of Object.entries(spec)) {
      result[name] = name in stored ? stored[name] : fallback;
    }
    return result;
  },
  async set(items) {
    const encoded = {};
    for (const [name, value] of Object.entries(items)) encoded[name] = JSON.stringify(value);
    await callNative("storage.set", { items: encoded });
  },
  async remove(keys) {
    await callNative("storage.remove", { keys: Array.isArray(keys) ? keys : [keys] });
  },
};

// background.js calls the global fetch. Requests to CHZZK's API and YouTube
// are cross-origin for this page and blocked by CORS, so they are proxied
// through URLSession; everything else keeps using the browser's fetch.
const browserFetch = globalThis.fetch.bind(globalThis);

function requestHost(input) {
  try {
    const url = typeof input === "string" ? input : input?.url;
    return new URL(url, location.href).hostname.toLowerCase();
  } catch {
    return "";
  }
}

globalThis.fetch = async function stellaViewFetch(input, init = {}) {
  if (!NATIVE_FETCH_HOSTS.has(requestHost(input))) {
    return browserFetch(input, init);
  }
  const url = typeof input === "string" ? input : input.url;
  const headers = {};
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
  }
  if (init.signal?.aborted) {
    throw new DOMException("요청이 중단되었습니다.", "AbortError");
  }
  const request = callNative("fetch", {
    url,
    method: init.method || "GET",
    credentials: init.credentials || input?.credentials || "same-origin",
    headers,
  });
  // background.js bounds requests with an AbortController; honour it so its
  // timeout stays meaningful (the native side has its own, longer timeout).
  const reply = init.signal
    ? await Promise.race([
        request,
        new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("요청이 중단되었습니다.", "AbortError")),
            { once: true },
          );
        }),
      ])
    : await request;
  const status = Number(reply?.status) || 0;
  const body = typeof reply?.body === "string" ? reply.body : "";
  return {
    ok: status >= 200 && status < 300,
    status,
    url: typeof reply?.url === "string" ? reply.url : url,
    headers: new Headers(reply?.headers || {}),
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
};

const runtime = {
  id: RUNTIME_ID,
  getURL(path) {
    return new URL(path, location.href).href;
  },
  async sendMessage(message) {
    try {
      switch (message?.type) {
        case "resolve-youtube":
          return { ok: true, stream: await resolveYoutubeInput(message.input) };
        case "fetch-chzzk-meta":
          return { ok: true, meta: await fetchChzzkMeta(message.channelId) };
        case "fetch-cime-meta":
          return { ok: true, meta: await fetchCimeMeta(message.slug) };
        case "prepare-youtube-player":
          return { ok: true, origin: youtubeClientOrigin(RUNTIME_ID), ruleId: 0 };
        case "prepare-cime-frames":
          // No declarativeNetRequest here; CIME tiles use the direct HLS player.
          return { ok: true, ruleId: 0 };
        case "open-viewer":
          return { ok: true, tabId: 0, reused: true };
        default:
          return null;
      }
    } catch (error) {
      return { ok: false, error: error?.message || "요청을 처리하지 못했습니다." };
    }
  },
};

const tabs = {
  async create({ url } = {}) {
    if (typeof url === "string") await callNative("openURL", { url });
    return { id: 0 };
  },
  async query() {
    return [];
  },
};

globalThis.chrome = { storage: { local: storageLocal }, runtime, tabs };

installIOSFullscreenAdapter();

// "계정" button in the top bar: opens the in-app login screen (Naver, Google)
// so the chzzk/YouTube frames can play member-only or age-restricted streams.
function installAccountButton() {
  const anchor = document.querySelector("#fullscreen");
  if (!anchor || document.querySelector("#sv-account")) return;
  const button = document.createElement("button");
  button.id = "sv-account";
  button.type = "button";
  button.className = "toolbar-button";
  button.textContent = "계정";
  button.title = "치지직, 유튜브 로그인";
  button.addEventListener("click", () => {
    callNative("openLogin").catch(() => {});
  });
  anchor.before(button);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installAccountButton, { once: true });
} else {
  installAccountButton();
}
