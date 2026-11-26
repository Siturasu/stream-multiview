const CHZZK_CHANNEL_ID_PATTERN = /^[0-9a-f]{32}$/i;
const CHZZK_VIDEO_ID_PATTERN = /^[1-9][0-9]{0,15}$/;
// CIME (ci.me) channel slugs are lowercase; the API answers 404 for other cases.
const CIME_SLUG_PATTERN = /^[a-z0-9_.-]{1,40}$/;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS_GLOBAL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;
const YOUTUBE_CUSTOM_SEGMENT_PATTERN = /^[\p{L}\p{N}._~-]{1,100}$/u;
const YOUTUBE_HANDLE_PATTERN = /^@[\p{L}\p{N}._-]{3,101}$/u;
const EMBED_DOMAIN_PATTERN = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;

const CHZZK_HOSTS = new Set(["chzzk.naver.com", "www.chzzk.naver.com", "m.chzzk.naver.com"]);
const CIME_HOSTS = new Set(["ci.me", "www.ci.me"]);
const CIME_CHANNEL_TABS = new Set(["live", "vods", "clips", "info", "store", "fan-meeting"]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);
const CHZZK_CHANNEL_TABS = new Set([
  "about",
  "clips",
  "community",
  "info",
  "schedule",
  "videos",
]);
const YOUTUBE_CHANNEL_TABS = new Set([
  "about",
  "community",
  "featured",
  "live",
  "playlists",
  "shorts",
  "streams",
  "videos",
]);

const MAX_INPUT_LENGTH = 2_048;
const MAX_NAME_LENGTH = 120;

function cleanName(name) {
  if (typeof name !== "string") {
    return undefined;
  }

  const cleaned = name
    .normalize("NFKC")
    .replace(CONTROL_CHARACTERS_GLOBAL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);

  return cleaned || undefined;
}

function withName(stream, name) {
  const cleanedName = cleanName(name);
  return cleanedName ? { ...stream, name: cleanedName } : stream;
}

function cleanInput(input) {
  if (typeof input !== "string") {
    return null;
  }

  const cleaned = input.trim();
  if (
    cleaned.length === 0 ||
    cleaned.length > MAX_INPUT_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(cleaned)
  ) {
    return null;
  }

  return cleaned;
}

function safeHttpsUrl(input) {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
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

function decodedPathSegments(url) {
  try {
    return url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function canonicalYoutubeSegment(segment) {
  return encodeURIComponent(segment)
    .replace(/%40/gi, "@")
    .replace(/%2E/gi, ".")
    .replace(/%5F/gi, "_")
    .replace(/%2D/gi, "-")
    .replace(/%7E/gi, "~");
}

function makeYoutubeResolutionStream(segments, name) {
  let resolutionPath = null;

  if (
    (segments.length === 1 ||
      (segments.length === 2 && YOUTUBE_CHANNEL_TABS.has(segments[1].toLowerCase()))) &&
    YOUTUBE_HANDLE_PATTERN.test(segments[0])
  ) {
    resolutionPath = `/${canonicalYoutubeSegment(segments[0])}/live`;
  } else if (
    (segments.length === 2 ||
      (segments.length === 3 && YOUTUBE_CHANNEL_TABS.has(segments[2].toLowerCase()))) &&
    ["c", "user", "custom"].includes(segments[0].toLowerCase()) &&
    YOUTUBE_CUSTOM_SEGMENT_PATTERN.test(segments[1])
  ) {
    resolutionPath = `/${segments[0].toLowerCase()}/${canonicalYoutubeSegment(
      segments[1],
    )}/live`;
  }

  if (!resolutionPath) {
    return null;
  }

  return withName(
    {
      platform: "youtube",
      needsResolution: true,
      sourceUrl: `https://www.youtube.com${resolutionPath}`,
    },
    name,
  );
}

function parseChzzkUrl(url) {
  if (!CHZZK_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  const segments = decodedPathSegments(url);
  if (!segments) {
    return null;
  }

  if (segments.length === 2 && segments[0].toLowerCase() === "video") {
    return makeChzzkVideo(segments[1]);
  }

  let channelId = null;
  if (segments.length === 1 && CHZZK_CHANNEL_ID_PATTERN.test(segments[0])) {
    [channelId] = segments;
  } else if (
    segments.length === 2 &&
    ["live", "channel"].includes(segments[0].toLowerCase()) &&
    CHZZK_CHANNEL_ID_PATTERN.test(segments[1])
  ) {
    channelId = segments[1];
  } else if (
    segments.length === 2 &&
    CHZZK_CHANNEL_ID_PATTERN.test(segments[0]) &&
    CHZZK_CHANNEL_TABS.has(segments[1].toLowerCase())
  ) {
    channelId = segments[0];
  }

  return channelId ? makeChzzkStream(channelId) : null;
}

function parseCimeUrl(url) {
  if (!CIME_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }

  const segments = decodedPathSegments(url);
  if (
    !segments ||
    segments.length < 1 ||
    segments.length > 2 ||
    !segments[0].startsWith("@") ||
    (segments.length === 2 && !CIME_CHANNEL_TABS.has(segments[1].toLowerCase()))
  ) {
    return null;
  }
  return makeCimeStream(segments[0].slice(1));
}

function parseYoutubeUrl(url) {
  const hostname = url.hostname.toLowerCase();
  const segments = decodedPathSegments(url);
  if (!segments) {
    return null;
  }

  if (hostname === "youtu.be") {
    return segments.length === 1 ? makeYouTubeStream(segments[0]) : null;
  }

  if (!YOUTUBE_HOSTS.has(hostname)) {
    return null;
  }

  if (segments.length === 1 && segments[0].toLowerCase() === "watch") {
    return makeYouTubeStream(url.searchParams.get("v"));
  }

  if (
    segments.length === 2 &&
    ["embed", "live", "shorts"].includes(segments[0].toLowerCase())
  ) {
    return makeYouTubeStream(segments[1]);
  }

  if (
    (segments.length === 2 ||
      (segments.length === 3 && YOUTUBE_CHANNEL_TABS.has(segments[2].toLowerCase()))) &&
    segments[0].toLowerCase() === "channel"
  ) {
    return makeYouTubeStream(segments[1]);
  }

  return makeYoutubeResolutionStream(segments);
}

/**
 * Build a normalized CHZZK stream from a public channel id.
 * Invalid ids return null instead of being interpolated into a URL.
 */
export function makeChzzkStream(channelId, name) {
  if (
    typeof channelId !== "string" ||
    !CHZZK_CHANNEL_ID_PATTERN.test(channelId.trim())
  ) {
    return null;
  }

  return withName(
    {
      platform: "chzzk",
      channelId: channelId.trim().toLowerCase(),
    },
    name,
  );
}

/** CHZZK recordings have numeric video ids, distinct from live channel ids. */
export function makeChzzkVideo(videoId, name) {
  if (typeof videoId !== "string" || !CHZZK_VIDEO_ID_PATTERN.test(videoId.trim())) return null;
  return withName({ platform: "chzzk", videoId: videoId.trim() }, name);
}

/**
 * Build a normalized CIME (ci.me) stream from a channel slug.
 */
export function makeCimeStream(slug, name) {
  if (typeof slug !== "string") {
    return null;
  }
  const normalized = slug.trim().replace(/^@/, "").toLowerCase();
  // "." and ".." match the pattern but would be normalized away inside an API
  // URL path and so reach a different endpoint.
  if (!CIME_SLUG_PATTERN.test(normalized) || normalized === "." || normalized === "..") {
    return null;
  }
  return withName({ platform: "cime", slug: normalized }, name);
}

/**
 * Build a normalized YouTube video or UC channel stream.
 */
export function makeYouTubeStream(videoOrChannel, name) {
  if (typeof videoOrChannel !== "string") {
    return null;
  }

  const id = videoOrChannel.trim();
  if (YOUTUBE_CHANNEL_ID_PATTERN.test(id)) {
    return withName({ platform: "youtube", channelId: id }, name);
  }
  if (YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
    return withName({ platform: "youtube", videoId: id }, name);
  }
  return null;
}

/**
 * Parse only first-party viewer/channel URLs and bare public ids.
 * Media manifests, CDN URLs, alternate protocols, and look-alike hosts are
 * deliberately rejected.
 */
export function parseStreamInput(input) {
  const cleaned = cleanInput(input);
  if (!cleaned) {
    return null;
  }

  if (CHZZK_CHANNEL_ID_PATTERN.test(cleaned)) {
    return makeChzzkStream(cleaned);
  }
  if (
    YOUTUBE_CHANNEL_ID_PATTERN.test(cleaned) ||
    YOUTUBE_VIDEO_ID_PATTERN.test(cleaned)
  ) {
    return makeYouTubeStream(cleaned);
  }
  if (YOUTUBE_HANDLE_PATTERN.test(cleaned)) {
    return makeYoutubeResolutionStream([cleaned]);
  }

  const url = safeHttpsUrl(cleaned);
  if (!url) {
    return null;
  }

  return parseChzzkUrl(url) || parseCimeUrl(url) || parseYoutubeUrl(url);
}

/**
 * Strip unknown fields and revalidate all identifiers before storage/use.
 */
export function sanitizeStream(stream) {
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
    return null;
  }

  const platform =
    typeof stream.platform === "string" ? stream.platform.toLowerCase() : "";

  if (platform === "chzzk") {
    if (stream.videoId !== undefined) {
      if (stream.channelId !== undefined) return null;
      return makeChzzkVideo(stream.videoId, stream.name);
    }
    return makeChzzkStream(stream.channelId, stream.name);
  }

  if (platform === "cime") {
    return makeCimeStream(stream.slug, stream.name);
  }

  if (platform !== "youtube") {
    return null;
  }

  if (stream.needsResolution === true) {
    const parsed = parseStreamInput(stream.sourceUrl);
    if (
      !parsed ||
      parsed.platform !== "youtube" ||
      parsed.needsResolution !== true
    ) {
      return null;
    }
    return withName(parsed, stream.name);
  }

  const hasVideoId =
    typeof stream.videoId === "string" &&
    YOUTUBE_VIDEO_ID_PATTERN.test(stream.videoId.trim());
  const hasChannelId =
    typeof stream.channelId === "string" &&
    YOUTUBE_CHANNEL_ID_PATTERN.test(stream.channelId.trim());

  if (hasVideoId === hasChannelId) {
    return null;
  }

  return makeYouTubeStream(
    hasVideoId ? stream.videoId.trim() : stream.channelId.trim(),
    stream.name,
  );
}

export function streamKey(stream) {
  const safeStream = sanitizeStream(stream);
  if (!safeStream) {
    return null;
  }

  if (safeStream.platform === "chzzk") {
    return safeStream.videoId ? `chzzk:video:${safeStream.videoId}` : `chzzk:${safeStream.channelId}`;
  }
  if (safeStream.platform === "cime") {
    return `cime:${safeStream.slug}`;
  }
  if (safeStream.needsResolution) {
    return `youtube:resolve:${safeStream.sourceUrl}`;
  }
  if (safeStream.videoId) {
    return `youtube:video:${safeStream.videoId}`;
  }
  return `youtube:channel:${safeStream.channelId}`;
}

function playerBoolean(value, defaultValue = true) {
  return value === undefined ? defaultValue : value !== false;
}

function playerQuality(value) {
  if (
    typeof value === "string" &&
    /^(?:auto|144p|240p|360p|480p|720p|1080p|1440p|2160p)$/.test(value)
  ) {
    return value;
  }
  return "1080p";
}

function playerOrigin(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  if (EXTENSION_ORIGIN_PATTERN.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    ) {
      return url.origin;
    }
  } catch {
    // Invalid or opaque origins are omitted.
  }
  return null;
}

/**
 * Build the stable HTTPS-shaped application identity YouTube requires when an
 * embedded player is loaded from an environment without an HTTP Referer.
 */
export function youtubeClientOrigin(extensionId) {
  if (
    typeof extensionId !== "string" ||
    !CHROME_EXTENSION_ID_PATTERN.test(extensionId)
  ) {
    return null;
  }
  return `https://stellaview-local.${extensionId}`;
}

export function streamToPlayerUrl(stream, options = {}) {
  const safeStream = sanitizeStream(stream);
  if (!safeStream || safeStream.needsResolution) {
    return null;
  }

  if (safeStream.platform === "chzzk") {
    const url = new URL(
      safeStream.videoId
        ? `https://chzzk.naver.com/video/${safeStream.videoId}`
        : `https://chzzk.naver.com/live/${safeStream.channelId}`,
    );
    url.searchParams.set("sv", "1");
    url.searchParams.set("quality", playerQuality(options?.quality));
    url.searchParams.set("grid", options?.gridBypass === false ? "0" : "1");
    return url.href;
  }

  if (safeStream.platform === "cime") {
    const url = new URL(`https://ci.me/@${safeStream.slug}/live`);
    url.searchParams.set("sv", "1");
    return url.href;
  }

  const url = safeStream.videoId
    ? new URL(`https://www.youtube.com/embed/${safeStream.videoId}`)
    : new URL("https://www.youtube.com/embed/live_stream");

  if (safeStream.channelId) {
    url.searchParams.set("channel", safeStream.channelId);
  }
  url.searchParams.set("autoplay", playerBoolean(options?.autoplay) ? "1" : "0");
  url.searchParams.set("mute", playerBoolean(options?.mute) ? "1" : "0");
  url.searchParams.set("playsinline", "1");
  url.searchParams.set("enablejsapi", "1");
  url.searchParams.set("sv", "1");
  const origin = playerOrigin(options?.origin);
  if (origin) url.searchParams.set("origin", origin);
  return url.href;
}

export function streamToChatUrl(stream, options = {}) {
  const safeStream = sanitizeStream(stream);
  if (!safeStream || safeStream.needsResolution) {
    return null;
  }

  if (safeStream.platform === "chzzk") {
    if (safeStream.videoId) return null;
    return `https://chzzk.naver.com/live/${safeStream.channelId}/chat`;
  }
  if (safeStream.platform === "cime") {
    return `https://ci.me/@${safeStream.slug}/live/chat`;
  }
  if (!safeStream.videoId) {
    return null;
  }

  const url = new URL("https://www.youtube.com/live_chat");
  url.searchParams.set("v", safeStream.videoId);
  if (typeof options?.embedDomain === "string" && EMBED_DOMAIN_PATTERN.test(options.embedDomain)) {
    url.searchParams.set("embed_domain", options.embedDomain.toLowerCase());
  }
  return url.href;
}

export function streamToOriginalUrl(stream) {
  const safeStream = sanitizeStream(stream);
  if (!safeStream) {
    return null;
  }

  if (safeStream.platform === "chzzk") {
    return safeStream.videoId
      ? `https://chzzk.naver.com/video/${safeStream.videoId}`
      : `https://chzzk.naver.com/live/${safeStream.channelId}`;
  }
  if (safeStream.platform === "cime") {
    return `https://ci.me/@${safeStream.slug}/live`;
  }
  if (safeStream.needsResolution) {
    return safeStream.sourceUrl;
  }
  if (safeStream.videoId) {
    return `https://www.youtube.com/watch?v=${safeStream.videoId}`;
  }
  return `https://www.youtube.com/channel/${safeStream.channelId}/live`;
}
