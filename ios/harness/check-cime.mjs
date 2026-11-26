import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  makeCimeStream,
  parseStreamInput,
  sanitizeStream,
  streamKey,
  streamToChatUrl,
  streamToOriginalUrl,
  streamToPlayerUrl,
} from "../../src/shared/streams.js";
import {
  FEATURED_CHANNELS,
  PRESET_GROUP_ORDER,
  STELLIVE_MEMBERS,
  presetStream,
} from "../../src/shared/members.js";
import { cimeDirectPlayerDocument, isSafeCimePlaybackUrl } from "../../src/shared/cime-player.js";

const repo = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");

function check(label, value) {
  assert.ok(value, label);
  console.log(`ok: ${label}`);
}

// 1. streams.js: CIME parsing, mirrored from the 0.1.19 reference tests.
{
  const expected = { platform: "cime", slug: "hebi" };
  for (const input of [
    "https://ci.me/@hebi/live",
    "https://ci.me/@Hebi",
    "https://www.ci.me/@hebi/vods",
  ]) assert.deepEqual(parseStreamInput(input), expected, input);
  for (const input of [
    "https://ci.me/hebi",
    "https://ci.me.evil.example/@hebi/live",
    "http://ci.me/@hebi/live",
    "https://ci.me/@hebi/live/chat/extra",
    "https://ci.me/@he%2Fbi/live",
  ]) assert.equal(parseStreamInput(input), null, input);
  assert.equal(streamKey(expected), "cime:hebi");
  assert.equal(streamToPlayerUrl(expected), "https://ci.me/@hebi/live?sv=1");
  assert.equal(streamToChatUrl(expected), "https://ci.me/@hebi/live/chat");
  assert.equal(streamToOriginalUrl(expected), "https://ci.me/@hebi/live");
  assert.equal(sanitizeStream({ platform: "cime", slug: "../x" }), null);
  check("CIME URLs parse to a cime stream with the expected key and URLs", true);

  // "." and ".." would be normalized away inside the API path.
  for (const slug of [".", "..", "@.", "@..", " .. "]) {
    assert.equal(makeCimeStream(slug), null, JSON.stringify(slug));
    assert.equal(sanitizeStream({ platform: "cime", slug }), null, JSON.stringify(slug));
  }
  assert.equal(parseStreamInput("https://ci.me/@../live"), null);
  assert.equal(parseStreamInput("https://ci.me/@%2e%2e/live"), null);
  assert.deepEqual(makeCimeStream(".a"), { platform: "cime", slug: ".a" });
  assert.deepEqual(makeCimeStream("a..b"), { platform: "cime", slug: "a..b" });
  check("CIME slugs \".\" and \"..\" are rejected while \".a\" is kept", true);

  const channelId = "49d2c3cf8f0b2843d934ec15e82bb54c";
  assert.deepEqual(parseStreamInput(`https://m.chzzk.naver.com/live/${channelId}`), { platform: "chzzk", channelId });
  assert.deepEqual(parseStreamInput("https://chzzk.naver.com/video/123456789"), { platform: "chzzk", videoId: "123456789" });
  check("CHZZK mobile live and VOD URLs still parse", true);
}

// 2. members.js: ABYSS members, group order and the CIME featured channel.
{
  const abyss = STELLIVE_MEMBERS.filter((member) => member.group === "ABYSS")
    .map(({ id, channelId }) => ({ id, channelId }));
  assert.deepEqual(abyss, [
    { id: "hiyori", channelId: "49d2c3cf8f0b2843d934ec15e82bb54c" },
    { id: "meri", channelId: "792acf9ca28b42918710327e14b06b68" },
    { id: "rang", channelId: "c657aa3592260a2b59669a72ec151936" },
    { id: "toa", channelId: "2299fad4bebb504b0978e1ec08b2f7d3" },
  ]);
  const ids = STELLIVE_MEMBERS.map((member) => member.id);
  const channelIds = STELLIVE_MEMBERS.map((member) => member.channelId);
  assert.equal(new Set(ids).size, ids.length, "member ids are unique");
  assert.equal(new Set(channelIds).size, channelIds.length, "member channel ids are unique");
  check("STELLIVE_MEMBERS has the four ABYSS members without duplicates", true);

  assert.deepEqual(PRESET_GROUP_ORDER, ["EVERYS", "UNIVERSE", "CLICHÉ", "ABYSS", "함께 보기"]);
  check("preset groups are ordered EVERYS, UNIVERSE, CLICHÉ, ABYSS, 함께 보기", true);

  const cimePreset = FEATURED_CHANNELS.find((preset) => preset.id === "heavy-cime");
  assert.ok(cimePreset, "heavy-cime preset exists");
  assert.equal(cimePreset.platform, "cime");
  assert.equal(cimePreset.channelId, "hebi");
  assert.deepEqual(presetStream(cimePreset), { platform: "cime", slug: "hebi", name: "헤비 (씨미)" });
  check("heavy-cime preset builds a cime stream for hebi", true);
}

// 3. cime-player.js: playback URL guard and the srcdoc document.
{
  const good = "https://x.ap-northeast-2.playback.live-video.net/a.m3u8";
  assert.equal(isSafeCimePlaybackUrl(good), true);
  for (const bad of [
    "http://x.ap-northeast-2.playback.live-video.net/a.m3u8",
    "https://live-video.net.evil.example/a.m3u8",
    "https://evil.example/live-video.net/a.m3u8",
    "https://user:pass@x.playback.live-video.net/a.m3u8",
    "https://x.playback.live-video.net:8443/a.m3u8",
    "https://.live-video.net/a.m3u8",
    "",
    null,
    `https://x.playback.live-video.net/${"a".repeat(2100)}`,
  ]) assert.equal(isSafeCimePlaybackUrl(bad), false, String(bad).slice(0, 80));
  check("isSafeCimePlaybackUrl accepts only https IVS hosts without credentials or ports", true);

  const origin = "https://chzzk.naver.com";
  const doc = cimeDirectPlayerDocument({ playbackUrl: good, viewerOrigin: origin });
  assert.equal(typeof doc, "string");
  assert.ok(doc.includes(JSON.stringify(good)), "playback URL is embedded as a JSON string");
  assert.ok(doc.includes(JSON.stringify(origin)), "viewer origin is embedded as a JSON string");
  const videoTag = doc.match(/<video\b[^>]*>/)?.[0] ?? "";
  for (const attribute of ["autoplay", "muted", "playsinline", "webkit-playsinline"]) {
    assert.match(videoTag, new RegExp(`\\s${attribute}(\\s|>|=)`), `video has ${attribute}`);
  }
  for (const token of ["set-muted", "set-volume", "teardown", "player-ready", "quality", "volume-capability", "cime-player-state"]) {
    assert.ok(doc.includes(token), `document handles ${token}`);
  }
  check("player document embeds values safely and speaks the frame protocol", true);

  // Volume capability: probed once per source at loadedmetadata with 0.5
  // (a request for 1 proves nothing on iPadOS, which ignores the setter and
  // reads back 1), never announced up front, and sticky once unsupported.
  const script = doc.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
  assert.equal(script.split('"volume-capability"').length - 1, 1, "one capability report site");
  assert.match(script, /const VOLUME_PROBE_LEVEL = 0\.5;/);
  assert.match(script, /const VOLUME_TOLERANCE = 0\.01;/);
  assert.match(script, /addEventListener\("loadedmetadata", \(\) => \{[\s\S]{0,60}probeVolume\(\);/);
  assert.match(script, /requestedVolume = data\.volume;\s*applyVolume\(\);/);

  // Run the player script against fake elements: "ignoring" drops volume
  // writes (iPadOS, reads back 1), "normal" keeps them (macOS).
  function simulate(volumeMode) {
    const posts = [];
    const listeners = new Map();
    let messageHandler = null;
    let volume = 1;
    let mode = volumeMode;
    const noop = () => {};
    const video = {
      currentSrc: "",
      readyState: 0,
      muted: false,
      paused: false,
      currentTime: 0,
      videoHeight: 0,
      get volume() { return volume; },
      set volume(value) { if (mode === "normal") volume = value; },
      set src(value) { this.currentSrc = value; },
      load: noop,
      pause: noop,
      play: () => Promise.resolve(),
      removeAttribute: noop,
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    };
    const element = () => ({ hidden: true, classList: { add: noop, remove: noop }, addEventListener: noop });
    const elements = { video, notice: element(), fullscreen: element() };
    const parent = { postMessage: (data, target) => posts.push({ data, target }) };
    const context = {
      document: {
        getElementById: (id) => elements[id],
        addEventListener: noop,
        documentElement: { requestFullscreen: noop },
        fullscreenElement: null,
      },
      window: { parent, addEventListener: (type, fn) => { if (type === "message") messageHandler = fn; } },
      setInterval: () => 1,
      clearInterval: noop,
      setTimeout: () => 1,
      clearTimeout: noop,
      Date,
      Number,
      Math,
    };
    vm.runInNewContext(script, context);
    const fire = (type) => (listeners.get(type) ?? []).forEach((fn) => fn());
    return {
      video,
      setMode: (next) => { mode = next; },
      // JSON copy: objects from the vm context have another realm's prototypes.
      capabilities: () => JSON.parse(JSON.stringify(posts.filter((post) => post.data.type === "volume-capability").map((post) => post.data))),
      send: (data) => messageHandler({ source: parent, origin, data: { source: "stellaview", ...data } }),
      metadata(src) {
        if (src) video.currentSrc = src;
        video.readyState = 1;
        fire("loadedmetadata");
      },
    };
  }

  const ipad = simulate("ignoring");
  ipad.send({ type: "set-volume", volume: 1 });
  assert.deepEqual(ipad.capabilities(), [], "nothing is reported before metadata");
  ipad.metadata();
  assert.deepEqual(ipad.capabilities(), [{ source: "stellaview", type: "volume-capability", supported: false, mode: "none" }]);
  ipad.send({ type: "set-volume", volume: 1 });
  ipad.send({ type: "set-volume", volume: 0.4 });
  ipad.send({ type: "set-volume", volume: 1 });
  ipad.metadata();
  assert.equal(ipad.capabilities().length, 1, "unsupported stays unsupported for the same source");
  check("setter-ignoring video: no report before metadata, one false after, a 1.0 request keeps it false", true);

  const mac = simulate("normal");
  mac.send({ type: "set-volume", volume: 0.4 });
  assert.deepEqual(mac.capabilities(), []);
  mac.metadata();
  assert.deepEqual(mac.capabilities(), [{ source: "stellaview", type: "volume-capability", supported: true, mode: "element" }]);
  assert.equal(mac.video.volume, 0.4, "the probe restores the requested level");
  mac.send({ type: "set-volume", volume: 1 });
  mac.send({ type: "set-volume", volume: 0.25 });
  assert.equal(mac.video.volume, 0.25);
  assert.equal(mac.capabilities().length, 1, "no repeated reports");
  check("volume-keeping video: one true after metadata, probe restores the requested level", true);

  const fresh = simulate("normal");
  fresh.metadata();
  assert.equal(fresh.video.volume, 1, "without a request the probe restores 1");
  check("probe without a request leaves the element at 1", true);

  const switching = simulate("ignoring");
  switching.metadata();
  switching.setMode("normal");
  switching.send({ type: "set-volume", volume: 1 });
  assert.equal(switching.capabilities().length, 1, "same source stays false");
  switching.metadata("https://y.ap-northeast-2.playback.live-video.net/b.m3u8");
  assert.deepEqual(switching.capabilities().map((data) => data.supported), [false, true]);
  check("a new currentSrc is probed again and may report a change", true);

  // Fullscreen button: 44px, labelled, dims but stays visible, toggles the
  // Fullscreen API with every failure swallowed.
  const button = doc.match(/<button id="fullscreen"[^>]*>[^<]*<\/button>/)?.[0] ?? "";
  assert.match(button, /aria-label="전체 화면"/);
  assert.match(button, />⛶</);
  const buttonCss = doc.match(/#fullscreen \{[^}]*\}/)?.[0] ?? "";
  assert.match(buttonCss, /width: 44px; height: 44px;/);
  assert.match(buttonCss, /right: \d+px; bottom: \d+px;/);
  const idleOpacity = Number(doc.match(/#fullscreen\.is-idle \{ opacity: ([0-9.]+); \}/)?.[1]);
  assert.ok(idleOpacity > 0 && idleOpacity < 1, "idle button dims without disappearing");
  assert.match(script, /const CONTROL_IDLE_MS = 1800;/);
  const toggle = script.match(/function toggleFullscreen\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(toggle, /try \{[\s\S]*document\.fullscreenElement\s*\?\s*document\.exitFullscreen\(\)\s*:\s*document\.documentElement\.requestFullscreen\(\)/);
  assert.match(toggle, /result\.catch\(\(\) => \{\}\)/);
  assert.match(toggle, /\} catch \{\}/);
  check("player has a 44px fullscreen button that dims, toggles fullscreen and ignores failures", true);

  const hostile = `${good}?x=</script><script>alert(1)</script>`;
  assert.equal(isSafeCimePlaybackUrl(hostile), true, "hostile query still passes the host guard");
  const hostileDoc = cimeDirectPlayerDocument({ playbackUrl: hostile, viewerOrigin: origin });
  assert.equal(typeof hostileDoc, "string");
  assert.equal(hostileDoc.split("</script").length - 1, 1, "only the closing script tag remains");
  check("a </script> inside the playback URL cannot break out of the script", true);

  for (const input of [
    { playbackUrl: "http://x.playback.live-video.net/a.m3u8", viewerOrigin: origin },
    { playbackUrl: "https://evil.example/a.m3u8", viewerOrigin: origin },
    { playbackUrl: good, viewerOrigin: "https://chzzk.naver.com/" },
    { playbackUrl: good, viewerOrigin: "javascript:alert(1)" },
    { playbackUrl: good, viewerOrigin: "" },
    { playbackUrl: good },
    {},
  ]) assert.equal(cimeDirectPlayerDocument(input), null, JSON.stringify(input));
  check("cimeDirectPlayerDocument returns null for invalid input", true);
}

// 4. background.js: imports without chrome and builds CIME meta from stubbed fetch.
{
  assert.equal(globalThis.chrome, undefined);
  const { fetchCimeMeta } = await import("../../background.js");
  check("background.js imports without a chrome global", typeof fetchCimeMeta === "function");

  const { cimeFrameEmbedRules, CIME_FRAME_EMBED_RULE_ID, CIME_CHAT_FRAME_EMBED_RULE_ID } =
    await import("../../background.js");
  assert.equal(cimeFrameEmbedRules("not-an-id"), null);
  const [playerRule, chatRule] = cimeFrameEmbedRules("a".repeat(32));
  assert.equal(playerRule.id, CIME_FRAME_EMBED_RULE_ID);
  assert.equal(chatRule.id, CIME_CHAT_FRAME_EMBED_RULE_ID);
  assert.deepEqual(playerRule.action.responseHeaders.map((h) => h.header), ["X-Frame-Options"]);
  assert.deepEqual(chatRule.action.responseHeaders.map((h) => h.header), ["Content-Security-Policy", "X-Frame-Options"]);
  for (const rule of [playerRule, chatRule]) {
    assert.deepEqual(rule.condition.initiatorDomains, ["a".repeat(32)]);
    assert.deepEqual(rule.condition.resourceTypes, ["sub_frame"]);
  }
  const matches = (rule, url) => new RegExp(rule.condition.regexFilter).test(url);
  const cimeStream = { platform: "cime", slug: "hebi" };
  const player = streamToPlayerUrl(cimeStream);
  const chat = streamToChatUrl(cimeStream);
  assert.ok(matches(playerRule, player) && !matches(chatRule, player), player);
  assert.ok(matches(chatRule, chat) && !matches(playerRule, chat), chat);
  for (const other of [
    "https://ci.me/@hebi/vods",
    "https://ci.me/@hebi",
    "https://ci.me/api/app/channels/hebi",
    "https://ci.me/@hebi/live/chat/extra",
    "https://ci.me.example.com/@hebi/live",
    "https://studio.ci.me/@hebi/live",
  ]) {
    assert.ok(!matches(playerRule, other) && !matches(chatRule, other), other);
  }
  check("CIME frame rules: player drops only X-Frame-Options, CSP removal limited to the chat path", true);

  const realFetch = globalThis.fetch;
  const playback = "https://abc.ap-northeast-2.playback.live-video.net/api/video/v1/x.m3u8";
  const json = (status, data) => new Response(JSON.stringify({ code: status, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
  async function run(slug, { channelStatus = 200, liveStatus = 200, liveThrows = false, isLive, state, url = playback }) {
    const requests = [];
    globalThis.fetch = async (input) => {
      const href = String(input);
      requests.push(href);
      if (href.endsWith("/live")) {
        if (liveThrows) throw new TypeError("network down");
        if (liveStatus !== 200) return json(liveStatus, null);
        return json(200, { title: "제목", state, curViewerCnt: 12, playback: { url }, category: { name: "게임" } });
      }
      if (channelStatus !== 200) return json(channelStatus, null);
      return json(200, { slug, name: "Hebi", isLive, imageUrl: null });
    };
    try {
      return { meta: await fetchCimeMeta(slug), requests };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const live = await run("hebi", { isLive: true, state: "ACTIVE" });
  assert.deepEqual(live.requests.sort(), [
    "https://ci.me/api/app/channels/hebi",
    "https://ci.me/api/app/channels/hebi/live",
  ]);
  assert.equal(live.meta.name, "Hebi");
  assert.equal(live.meta.open, true);
  assert.equal(live.meta.playback, playback);
  check("fetchCimeMeta requests channel and live and marks ACTIVE as open", true);

  const offline = await run("hebi", { isLive: false, state: "INACTIVE" });
  assert.equal(offline.meta.open, false);
  assert.equal(offline.meta.playback, playback);
  check("INACTIVE channel is not open but keeps its playback URL", true);

  const foreign = await run("hebi", { isLive: true, state: "ACTIVE", url: "https://evil.example/x.m3u8" });
  assert.equal(foreign.meta.playback, null);
  check("non-IVS playback URL is dropped", true);

  await assert.rejects(run("nobody", { channelStatus: 404, isLive: false, state: "INACTIVE" }));
  check("unknown channel (404) is an error", true);

  assert.equal(live.meta.liveUnavailable, undefined);
  assert.equal(foreign.meta.liveUnavailable, undefined);
  for (const failure of [{ liveStatus: 503 }, { liveThrows: true }]) {
    const failed = await run("hebi", { isLive: true, state: "ACTIVE", ...failure });
    assert.equal(failed.meta.liveUnavailable, true, JSON.stringify(failure));
    assert.equal(failed.meta.playback, null);
    assert.equal(failed.meta.open, false);
  }
  const noLive = await run("hebi", { isLive: false, state: "INACTIVE", liveStatus: 404 });
  assert.equal(noLive.meta.playback, null);
  assert.equal(noLive.meta.liveUnavailable, undefined, "a 404 live answer is not a failure");
  check("a failed /live request (5xx, network) sets liveUnavailable; a missing playback URL does not", true);
}

// 5. chrome-shim.js routes CIME through native fetch and the message switch.
{
  const shim = read("ios/Resources/ios-web/chrome-shim.js");
  assert.match(shim, /NATIVE_FETCH_HOSTS\s*=\s*new Set\(\[[^\]]*"ci\.me"/);
  assert.match(shim, /case "fetch-cime-meta":[\s\S]{0,120}fetchCimeMeta\(message\.slug\)/);
  assert.match(shim, /case "prepare-cime-frames":[\s\S]{0,200}ok:\s*true/);
  check("chrome-shim relays ci.me natively and routes the CIME messages", true);
}

// 6. viewer.js wiring (source assertions; there is no DOM here).
{
  const viewer = read("viewer.js");
  const frameOrigin = viewer.match(/function frameOrigin\(stream\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(frameOrigin, /"cime"[\s\S]*isWrapperHost\s*\?\s*location\.origin\s*:\s*"https:\/\/ci\.me"/);
  assert.match(viewer, /\.srcdoc\s*=\s*documentHtml/);
  assert.match(viewer, /cimeDirectPlayerDocument\(\{[\s\S]{0,80}viewerOrigin:\s*location\.origin/);
  assert.match(viewer, /type === "cime-player-state"[\s\S]{0,400}cimeState/);
  const openChat = viewer.match(/function openChat\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(openChat, /isWrapperCime\(stream\)[\s\S]{0,80}showCimeWrapperChatNotice/);
  assert.ok(viewer.includes("씨미 채팅은 앱 안에 넣을 수 없습니다"));
  check("viewer.js has the CIME origin, srcdoc player, state handler and wrapper chat notice", true);

  // Retry: distinct notices, 30 s doubling to 5 min per tile, reset on load.
  assert.match(viewer, /const CIME_META_RETRY_MS = 30_000;/);
  assert.match(viewer, /const CIME_META_RETRY_MAX_MS = 5 \* 60_000;/);
  assert.ok(viewer.includes('"이 채널은 아직 방송 주소가 없습니다"'));
  const loader = viewer.match(/async function loadCimeDirectPlayer\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(loader, /meta && !meta\.liveUnavailable \? CIME_NO_PLAYBACK_TEXT : CIME_META_FAILED_TEXT/);
  assert.match(loader, /Math\.min\(delay \* 2, CIME_META_RETRY_MAX_MS\)/);
  assert.match(loader, /srcdoc = documentHtml[\s\S]*?\}/);
  assert.match(loader, /delete tile\.dataset\.cimeRetryMs;[\s\S]{0,80}srcdoc = documentHtml/);
  check("loadCimeDirectPlayer separates missing playback from failed metadata or /live and backs off to 5 min", true);

  // refreshCimeTileMeta checks again 30 s later while playing and not live,
  // at most twice more, one pending check per tile, only for the current tile.
  assert.match(viewer, /const CIME_META_RECHECK_MS = 30_000;/);
  assert.match(viewer, /const CIME_META_RECHECK_LIMIT = 2;/);
  const refresh = viewer.match(/async function refreshCimeTileMeta\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(refresh, /recheck < CIME_META_RECHECK_LIMIT/);
  assert.match(refresh, /tiles\.get\(key\) === tile/);
  assert.match(refresh, /tile\.dataset\.cimeState === "playing"/);
  assert.match(refresh, /setTimeout\([\s\S]*refreshCimeTileMeta\(tile, stream, recheck \+ 1\)[\s\S]*CIME_META_RECHECK_MS\)/);
  check("refreshCimeTileMeta rechecks a playing, not-live tile at most twice", true);

  // Player-reported audio changes are adopted; audio-corrected is not.
  const handler = viewer.match(/if \(event\.data\.type === "audio-user-changed"\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(handler, /typeof event\.data\.muted === "boolean"/);
  assert.match(handler, /activeAudioKeys\.delete\(key\)[\s\S]*activeAudioKeys\.add\(key\)[\s\S]*updateAudioClasses\(\)/);
  assert.match(handler, /Number\.isFinite\(volume\) && volume >= 0 && volume <= 1/);
  assert.match(handler, /tileVolumes\.set\(key, clampVolume\(volume \* 100\)\);\s*updateVolumeRow\(key\);\s*saveSettings\(\)/);
  assert.ok(!/setTileVolume|applyVolumeState/.test(handler), "the frame's own change is not sent back to it");
  assert.ok(!/type === "audio-corrected"/.test(viewer), "audio-corrected stays ignored");
  check("viewer adopts audio-user-changed into the tile audio state and volume", true);
}

// 7. manifest.json grants ci.me to the extension.
{
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(manifest.host_permissions.includes("https://ci.me/*"));
  assert.ok(manifest.content_scripts.some((entry) => entry.js?.includes("content/cime-embed.js")));
  const frameSrc = manifest.content_security_policy.extension_pages.match(/frame-src ([^;]*)/)?.[1] ?? "";
  assert.ok(frameSrc.split(/\s+/).includes("https://ci.me"));
  check("manifest has ci.me host permission, the cime-embed content script and frame-src", true);
}

// 8. Swift wrapper relays ci.me natively.
{
  const swift = read("ios/Sources/Core/ViewerConfiguration.swift");
  assert.match(swift, /nativeFetchHosts[^\n]*"ci\.me"/);
  check("ViewerConfiguration.nativeFetchHosts includes ci.me", true);
}
