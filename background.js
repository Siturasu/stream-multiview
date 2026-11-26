import { isSafeCimePlaybackUrl } from "./src/shared/cime-player.js";
import {
  makeChzzkStream,
  makeCimeStream,
  makeYouTubeStream,
  parseStreamInput,
  sanitizeStream,
  youtubeClientOrigin,
} from "./src/shared/streams.js";

export const DEFAULT_SETTINGS = Object.freeze({
  quality: "1080p",
  gridBypass: true,
  chatOpen: true,
  rememberSession: true,
});

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const YOUTUBE_HOSTNAME = "www.youtube.com";
const CHZZK_API_ORIGIN = "https://api.chzzk.naver.com";
const MAX_YOUTUBE_HTML_LENGTH = 4_000_000;
const REQUEST_TIMEOUT_MS = 12_000;
const TEXT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
export const YOUTUBE_EMBED_IDENTITY_RULE_ID = 731_001;
export const CIME_FRAME_EMBED_RULE_ID = 731_003;
export const CIME_CHAT_FRAME_EMBED_RULE_ID = 731_004;
const CIME_ORIGIN = "https://ci.me";
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

class SafeRequestError extends Error {}

export function youtubeEmbedIdentityRule(extensionId) {
  const origin = youtubeClientOrigin(extensionId);
  if (!origin) return null;

  return {
    id: YOUTUBE_EMBED_IDENTITY_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "Referer",
          operation: "set",
          value: `${origin}/`,
        },
      ],
    },
    condition: {
      urlFilter: "|https://www.youtube.com/embed/",
      requestDomains: ["www.youtube.com"],
      initiatorDomains: [extensionId],
      resourceTypes: ["sub_frame"],
    },
  };
}

export async function prepareYoutubePlayer(extensionApi = globalThis.chrome) {
  const rule = youtubeEmbedIdentityRule(extensionApi?.runtime?.id);
  if (!rule || !extensionApi?.declarativeNetRequest?.updateDynamicRules) {
    throw new SafeRequestError("YouTube 플레이어 식별 규칙을 준비하지 못했습니다.");
  }

  await extensionApi.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [YOUTUBE_EMBED_IDENTITY_RULE_ID],
    addRules: [rule],
  });
  return {
    origin: youtubeClientOrigin(extensionApi.runtime.id),
    ruleId: YOUTUBE_EMBED_IDENTITY_RULE_ID,
  };
}

// CIME framing headers, checked 2026-11-27 with curl:
// - player page `/@slug/live` sends `X-Frame-Options: SAMEORIGIN` and no CSP,
//   so only X-Frame-Options is removed and any CSP ci.me adds later stays.
// - chat page `/@slug/live/chat` sends `Content-Security-Policy:
//   frame-ancestors 'self' https://studio.ci.me` (no other directive). DNR can
//   only drop the whole header, so the CSP is removed on this path only.
// Both rules apply only to sub_frame navigations this extension starts itself.
const CIME_SLUG_PATH = "^https://ci\\.me/@[a-z0-9._-]+";
const CIME_QUERY = "(\\?[^#]*)?$";

function cimeFrameRule(id, regexFilter, headers, extensionId) {
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: headers.map((header) => ({ header, operation: "remove" })),
    },
    condition: {
      regexFilter,
      requestDomains: ["ci.me"],
      initiatorDomains: [extensionId],
      resourceTypes: ["sub_frame"],
    },
  };
}

export function cimeFrameEmbedRules(extensionId) {
  if (typeof extensionId !== "string" || !EXTENSION_ID_PATTERN.test(extensionId)) {
    return null;
  }

  return [
    cimeFrameRule(
      CIME_FRAME_EMBED_RULE_ID,
      `${CIME_SLUG_PATH}/live${CIME_QUERY}`,
      ["X-Frame-Options"],
      extensionId,
    ),
    cimeFrameRule(
      CIME_CHAT_FRAME_EMBED_RULE_ID,
      `${CIME_SLUG_PATH}/live/chat${CIME_QUERY}`,
      ["Content-Security-Policy", "X-Frame-Options"],
      extensionId,
    ),
  ];
}

export async function prepareCimeFrames(extensionApi = globalThis.chrome) {
  const rules = cimeFrameEmbedRules(extensionApi?.runtime?.id);
  if (!rules || !extensionApi?.declarativeNetRequest?.updateDynamicRules) {
    throw new SafeRequestError("씨미 플레이어 표시 규칙을 준비하지 못했습니다.");
  }

  await extensionApi.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [CIME_FRAME_EMBED_RULE_ID, CIME_CHAT_FRAME_EMBED_RULE_ID],
    addRules: rules,
  });
  return { ruleId: CIME_FRAME_EMBED_RULE_ID, chatRuleId: CIME_CHAT_FRAME_EMBED_RULE_ID };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function safeErrorResponse(error) {
  return {
    ok: false,
    error:
      error instanceof SafeRequestError
        ? error.message
        : "요청을 처리하지 못했습니다.",
  };
}

async function setInstallDefaults(extensionApi) {
  const stored = await extensionApi.storage.local.get([
    "settings",
    "selectedStreams",
  ]);
  const defaults = {};

  if (!Object.prototype.hasOwnProperty.call(stored, "settings")) {
    defaults.settings = { ...DEFAULT_SETTINGS };
  }
  if (!Object.prototype.hasOwnProperty.call(stored, "selectedStreams")) {
    defaults.selectedStreams = [];
  }

  if (Object.keys(defaults).length > 0) {
    await extensionApi.storage.local.set(defaults);
  }
}

function strictYoutubeUrl(input) {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== YOUTUBE_HOSTNAME ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function youtubeResolutionSource(stream) {
  const sourceUrl = strictYoutubeUrl(stream.sourceUrl);
  if (!sourceUrl || sourceUrl.search !== "" || sourceUrl.hash !== "") {
    return null;
  }

  const parsed = parseStreamInput(sourceUrl.href);
  if (
    !parsed ||
    parsed.platform !== "youtube" ||
    parsed.needsResolution !== true ||
    parsed.sourceUrl !== sourceUrl.href
  ) {
    return null;
  }

  return sourceUrl;
}

function htmlAttribute(tag, attributeName) {
  const expression = new RegExp(
    `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  );
  const match = expression.exec(tag);
  return match ? match[1] ?? match[2] : null;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&#0*47;/gi, "/")
    .replace(/&#x0*2f;/gi, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/gi, '"');
}

function videoStreamFromUrlCandidate(candidate) {
  if (typeof candidate !== "string" || candidate.length > 2_048) {
    return null;
  }

  try {
    const url = new URL(decodeHtmlAttribute(candidate), YOUTUBE_ORIGIN);
    if (!strictYoutubeUrl(url.href)) {
      return null;
    }
    const parsed = parseStreamInput(url.href);
    return parsed?.platform === "youtube" && parsed.videoId ? parsed : null;
  } catch {
    return null;
  }
}

function videoStreamFromYoutubeHtml(html) {
  for (const match of html.matchAll(/<(?:link|meta)\b[^>]{0,2000}>/gi)) {
    const tag = match[0];
    const rel = htmlAttribute(tag, "rel")?.toLowerCase();
    const property = htmlAttribute(tag, "property")?.toLowerCase();
    const itemprop = htmlAttribute(tag, "itemprop")?.toLowerCase();

    if (rel?.split(/\s+/u).includes("canonical")) {
      const stream = videoStreamFromUrlCandidate(htmlAttribute(tag, "href"));
      if (stream) {
        return stream;
      }
    }

    if (property === "og:url") {
      const stream = videoStreamFromUrlCandidate(htmlAttribute(tag, "content"));
      if (stream) {
        return stream;
      }
    }

    if (itemprop === "videoid") {
      const stream = makeYouTubeStream(htmlAttribute(tag, "content"));
      if (stream?.videoId) {
        return stream;
      }
    }
  }

  const canonicalExpression =
    /"(?:canonicalUrl|urlCanonical)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of html.matchAll(canonicalExpression)) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      const stream = videoStreamFromUrlCandidate(decoded);
      if (stream) {
        return stream;
      }
    } catch {
      // Keep checking other first-party canonical candidates.
    }
  }

  const videoDetails =
    /"videoDetails"\s*:\s*\{[\s\S]{0,3000}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/.exec(
      html,
    );
  return videoDetails ? makeYouTubeStream(videoDetails[1]) : null;
}

function normalizeYoutubeInput(input) {
  if (typeof input === "string") {
    return parseStreamInput(input);
  }
  return sanitizeStream(input);
}

export async function resolveYoutubeInput(input) {
  const requestedStream = normalizeYoutubeInput(input);
  if (!requestedStream || requestedStream.platform !== "youtube") {
    throw new SafeRequestError("지원되는 YouTube 주소를 입력해 주세요.");
  }

  if (!requestedStream.needsResolution) {
    return requestedStream;
  }

  const sourceUrl = youtubeResolutionSource(requestedStream);
  if (!sourceUrl) {
    throw new SafeRequestError("허용되지 않은 YouTube 채널 주소입니다.");
  }

  let response;
  try {
    response = await fetchWithTimeout(sourceUrl.href, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "text/html" },
    });
  } catch {
    throw new SafeRequestError("YouTube 채널을 확인하지 못했습니다.");
  }

  const finalUrl = strictYoutubeUrl(response.url);
  if (!finalUrl) {
    throw new SafeRequestError("YouTube 외부로 이동된 주소는 열 수 없습니다.");
  }
  if (!response.ok) {
    throw new SafeRequestError("YouTube 채널을 확인하지 못했습니다.");
  }

  const redirectedStream = parseStreamInput(finalUrl.href);
  if (redirectedStream?.platform === "youtube" && redirectedStream.videoId) {
    return makeYouTubeStream(redirectedStream.videoId, requestedStream.name);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_YOUTUBE_HTML_LENGTH
  ) {
    throw new SafeRequestError("YouTube 응답이 너무 큽니다.");
  }

  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType && !contentType.includes("text/html")) {
    throw new SafeRequestError("YouTube 채널 응답 형식이 올바르지 않습니다.");
  }

  const html = await response.text();
  if (html.length > MAX_YOUTUBE_HTML_LENGTH) {
    throw new SafeRequestError("YouTube 응답이 너무 큽니다.");
  }

  const resolvedStream = videoStreamFromYoutubeHtml(html);
  if (!resolvedStream?.videoId) {
    throw new SafeRequestError("현재 진행 중인 YouTube 방송을 찾지 못했습니다.");
  }

  return makeYouTubeStream(resolvedStream.videoId, requestedStream.name);
}

async function fetchChzzkJson(url) {
  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new SafeRequestError("CHZZK 방송 정보를 불러오지 못했습니다.");
  }

  if (!response.ok) {
    throw new SafeRequestError("CHZZK 방송 정보를 불러오지 못했습니다.");
  }

  try {
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || !payload.content) {
      throw new Error("Missing content");
    }
    return payload.content;
  } catch (error) {
    if (error instanceof SafeRequestError) {
      throw error;
    }
    throw new SafeRequestError("CHZZK 방송 정보 형식이 올바르지 않습니다.");
  }
}

function safeText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .normalize("NFKC")
    .replace(TEXT_CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function hostnameIs(hostname, root) {
  return hostname === root || hostname.endsWith(`.${root}`);
}

function safeImageUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) {
    return null;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !["pstatic.net", "naver.net", "naver.com", "ci.me"].some((root) =>
        hostnameIs(hostname, root),
      )
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeViewerCount(value) {
  const viewers = Number(value);
  if (!Number.isFinite(viewers) || viewers < 0) {
    return null;
  }
  return Math.min(Math.floor(viewers), Number.MAX_SAFE_INTEGER);
}

function channelOpenFallback(channel) {
  const openLive = channel?.openLive;
  if (typeof openLive === "boolean") {
    return openLive;
  }
  if (typeof openLive === "string") {
    return openLive.toUpperCase() === "OPEN";
  }
  if (openLive && typeof openLive === "object") {
    if (typeof openLive.open === "boolean") {
      return openLive.open;
    }
    if (typeof openLive.status === "string") {
      return openLive.status.toUpperCase() === "OPEN";
    }
    // CHZZK uses a non-null openLive record only while a channel is live.
    return true;
  }
  return false;
}

async function fetchChzzkLiveStatus(channelId) {
  for (const version of ["v3.1", "v3"]) {
    try {
      return await fetchChzzkJson(
        `${CHZZK_API_ORIGIN}/polling/${version}/channels/${channelId}/live-status`,
      );
    } catch {
      // Polling can reject chrome-extension origins. The channel response still
      // provides openLive, so failure here must not hide the member list.
    }
  }
  return null;
}

export async function fetchChzzkMeta(channelId) {
  const stream = makeChzzkStream(channelId);
  if (!stream) {
    throw new SafeRequestError("올바른 CHZZK 채널 ID가 아닙니다.");
  }

  const channelUrl = `${CHZZK_API_ORIGIN}/service/v1/channels/${stream.channelId}`;
  const [channel, liveStatus] = await Promise.all([
    fetchChzzkJson(channelUrl),
    fetchChzzkLiveStatus(stream.channelId),
  ]);

  const name = safeText(channel.channelName, 100);
  if (!name) {
    throw new SafeRequestError("CHZZK 채널 이름을 확인하지 못했습니다.");
  }

  const polledStatus = safeText(liveStatus?.status, 16).toUpperCase();
  const open = polledStatus === "OPEN"
    ? true
    : ["CLOSE", "CLOSED"].includes(polledStatus)
      ? false
      : channelOpenFallback(channel);

  return {
    name,
    image: safeImageUrl(channel.channelImageUrl),
    open,
    title: safeText(liveStatus?.liveTitle, 200),
    viewers: safeViewerCount(liveStatus?.concurrentUserCount),
    category: safeText(
      liveStatus?.liveCategoryValue || liveStatus?.liveCategory,
      100,
    ),
  };
}

async function fetchCimeJson(path) {
  let response;
  try {
    response = await fetchWithTimeout(`${CIME_ORIGIN}${path}`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new SafeRequestError("씨미 방송 정보를 불러오지 못했습니다.");
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new SafeRequestError("씨미 방송 정보를 불러오지 못했습니다.");
  }
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" ? payload.data ?? null : null;
  } catch {
    throw new SafeRequestError("씨미 방송 정보 형식이 올바르지 않습니다.");
  }
}

export async function fetchCimeMeta(slug) {
  const stream = makeCimeStream(slug);
  if (!stream) {
    throw new SafeRequestError("올바른 씨미 채널 주소가 아닙니다.");
  }

  const path = `/api/app/channels/${encodeURIComponent(stream.slug)}`;
  // The live endpoint answers even while offline and still carries the fixed
  // channel playback URL, so always ask for it alongside the channel. A failed
  // live request (timeout, 5xx) is reported as liveUnavailable so the viewer
  // can tell it from a channel that simply has no playback URL.
  let liveFailed = false;
  const [channel, live] = await Promise.all([
    fetchCimeJson(path),
    fetchCimeJson(`${path}/live`).catch(() => {
      liveFailed = true;
      return null;
    }),
  ]);
  if (!channel || typeof channel !== "object") {
    throw new SafeRequestError("씨미 채널을 찾지 못했습니다.");
  }
  const safeLive = live && typeof live === "object" ? live : null;
  const open = channel.isLive === true && safeLive?.state === "ACTIVE";
  const playbackUrl = safeLive?.playback?.url;

  const meta = {
    name: safeText(channel.name, 100) || stream.slug,
    image: safeImageUrl(channel.imageUrl),
    open,
    title: open ? safeText(safeLive?.title, 200) : "",
    viewers: open ? safeViewerCount(safeLive?.curViewerCnt) : null,
    category: open ? safeText(safeLive?.category?.name, 100) : "",
    playback: isSafeCimePlaybackUrl(playbackUrl) ? new URL(playbackUrl).href : null,
  };
  if (liveFailed) meta.liveUnavailable = true;
  return meta;
}

let viewerOpenOperation = null;

async function doOpenViewer(extensionApi) {
  const viewerUrl = extensionApi.runtime.getURL("viewer.html");
  // Open a fresh viewer for each submitted composition. Reusing by URL would
  // require the broad `tabs` permission and could leave a running viewer on an
  // older storage snapshot.
  const tab = await extensionApi.tabs.create({ url: viewerUrl, active: true });
  return { tabId: tab.id, reused: false };
}

export function openViewer(extensionApi = globalThis.chrome) {
  if (!extensionApi?.tabs || !extensionApi?.runtime) {
    return Promise.reject(new SafeRequestError("뷰어 탭을 열 수 없습니다."));
  }

  if (!viewerOpenOperation) {
    viewerOpenOperation = doOpenViewer(extensionApi).finally(() => {
      viewerOpenOperation = null;
    });
  }
  return viewerOpenOperation;
}

async function handleMessage(message, extensionApi) {
  switch (message.type) {
    case "resolve-youtube":
      return { ok: true, stream: await resolveYoutubeInput(message.input) };
    case "fetch-chzzk-meta":
      return { ok: true, meta: await fetchChzzkMeta(message.channelId) };
    case "fetch-cime-meta":
      return { ok: true, meta: await fetchCimeMeta(message.slug) };
    case "open-viewer":
      return { ok: true, ...(await openViewer(extensionApi)) };
    case "prepare-youtube-player":
      return { ok: true, ...(await prepareYoutubePlayer(extensionApi)) };
    case "prepare-cime-frames":
      return { ok: true, ...(await prepareCimeFrames(extensionApi)) };
    default:
      return null;
  }
}

const extensionApi = globalThis.chrome;

if (extensionApi?.runtime?.onInstalled && extensionApi?.storage?.local) {
  extensionApi.runtime.onInstalled.addListener(() => {
    void Promise.all([
      setInstallDefaults(extensionApi),
      prepareYoutubePlayer(extensionApi),
      prepareCimeFrames(extensionApi),
    ]).catch((error) => {
      console.error("Failed to initialize extension defaults", error);
    });
  });
}

if (extensionApi?.declarativeNetRequest?.updateDynamicRules) {
  void prepareYoutubePlayer(extensionApi).catch((error) => {
    console.error("Failed to initialize YouTube player identity", error);
  });
  void prepareCimeFrames(extensionApi).catch((error) => {
    console.error("Failed to initialize CIME frame rule", error);
  });
}

if (extensionApi?.runtime?.onMessage) {
  extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      !message ||
      typeof message !== "object" ||
      ![
        "resolve-youtube",
        "fetch-chzzk-meta",
        "fetch-cime-meta",
        "open-viewer",
        "prepare-youtube-player",
        "prepare-cime-frames",
      ].includes(message.type)
    ) {
      return false;
    }

    void handleMessage(message, extensionApi)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse(safeErrorResponse(error)));
    return true;
  });
}
