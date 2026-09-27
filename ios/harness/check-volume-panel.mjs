import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  makeChzzkStream,
  makeYouTubeStream,
  streamKey,
} from "../../src/shared/streams.js";

const repo = new URL("../../", import.meta.url);
const viewerSource = readFileSync(new URL("viewer.js", repo), "utf8");
const viewerMarkup = readFileSync(new URL("viewer.html", repo), "utf8");
const viewerStyles = readFileSync(new URL("viewer.css", repo), "utf8");

function check(label, value) {
  assert.ok(value, label);
  console.log(`ok: ${label}`);
}

// vm-realm values carry a different Object.prototype, so posted payloads are
// copied into this realm before comparison.
function plain({ key, message, origin }) {
  return {
    key,
    message: typeof message === "string" ? JSON.parse(message) : { ...message },
    origin,
  };
}

// The panel chrome is plain markup, so its anchors are asserted directly
// instead of being rebuilt in a fake document.
{
  for (const needle of [
    'id="volume-toggle"',
    'class="toolbar-button"',
    'id="volume-panel"',
    'id="volume-rows"',
    'id="volume-mute-all"',
    'id="volume-max-all"',
  ]) assert.ok(viewerMarkup.includes(needle), `viewer.html must contain ${needle}`);
  assert.ok(
    viewerMarkup.indexOf('id="volume-toggle"') > viewerMarkup.indexOf('id="mute-all"'),
    "the volume toggle sits next to 모두 음소거",
  );
  assert.ok(viewerStyles.includes("body.volume-panel-open .volume-panel"), "the open state is styled");
  assert.ok(
    viewerStyles.includes("body.fullscreen-view.fullscreen-controls-hidden .volume-panel"),
    "the panel hides with the rest of the fullscreen chrome",
  );
  check("top bar toggle, panel and fullscreen hiding exist in the viewer document", true);
}

// Evaluate the exact command/volume implementation with only its state
// dependencies, the same way the CHZZK audio checks do.
const fragment = viewerSource.match(
  /function sendChzzkCommand\(frame, payload\) \{[\s\S]*?\n\}\n\nfunction updateAudioClasses/,
);
assert.ok(fragment, "volume command source must be found");
const volumeSource = fragment[0].replace(/\n\nfunction updateAudioClasses$/, "");

const live = makeChzzkStream("a".repeat(32), "치지직");
const video = makeYouTubeStream("dQw4w9WgXcQ", "유튜브");
const liveKey = streamKey(live);
const videoKey = streamKey(video);

function makeContext({ wrapper = true } = {}) {
  const posted = [];
  const tiles = new Map();
  let streams = [live, video];
  for (const stream of streams) {
    const frame = {
      contentWindow: {
        postMessage(message, origin) {
          posted.push({ key: streamKey(stream), message, origin });
        },
      },
    };
    tiles.set(streamKey(stream), {
      querySelector: (selector) => (selector === ".stream-frame" ? frame : null),
    });
  }
  const rowUpdates = [];
  const context = vm.createContext({
    // The wrappers always apply the panel volume; the extension only applies
    // it to tiles the user set. These checks cover the wrapper semantics.
    isWrapperHost: wrapper,
    siteVolumes: new Map(),
    DEFAULT_VOLUME: 100,
    activeAudioKeys: new Set(),
    tileVolumes: new Map(),
    volumeCapabilities: new Map(),
    tiles,
    streamKey,
    getStream: (key) => streams.find((stream) => streamKey(stream) === key) || null,
    updateVolumeRow: (key) => rowUpdates.push(key),
  });
  vm.runInContext(volumeSource, context, { filename: "viewer.js" });
  return {
    context,
    posted,
    rowUpdates,
    setStreams: (next) => { streams = next; },
  };
}

// A tile with no stored entry plays at full volume, and every write is
// clamped and rounded to an integer percentage.
{
  const { context } = makeContext();
  assert.equal(context.getTileVolume(liveKey), 100, "an unknown tile uses the default volume");
  assert.equal(context.tileVolumes.size, 0, "reading a default does not create an entry");
  assert.equal(context.setTileVolume(liveKey, 150), 100);
  assert.equal(context.setTileVolume(liveKey, -20), 0);
  assert.equal(context.setTileVolume(liveKey, 33.6), 34);
  assert.equal(context.setTileVolume(liveKey, "45"), 45, "a range input reports its value as a string");
  assert.equal(context.setTileVolume(liveKey, "loud"), 100, "an unusable value falls back to the default");
  assert.equal(context.getTileVolume(liveKey), 100);
  check("volumes default to 100 and are clamped and rounded to 0..100", true);
}

// CHZZK frames take the parent-authenticated object command; YouTube frames
// need both the IFrame API command and the wrapper message.
{
  const { context, posted } = makeContext();
  context.setTileVolume(liveKey, 30);
  // Messages are built inside the vm realm, so they are copied out before a
  // strict structural comparison.
  assert.deepEqual(posted.map(plain), [{
    key: liveKey,
    message: { source: "stellaview", type: "set-volume", volume: 0.3 },
    origin: "https://chzzk.naver.com",
  }]);

  posted.length = 0;
  context.setTileVolume(videoKey, 30);
  assert.deepEqual(posted.map(plain), [
    {
      key: videoKey,
      message: { event: "command", func: "setVolume", args: [30] },
      origin: "https://www.youtube.com",
    },
    {
      key: videoKey,
      message: { source: "stellaview", type: "set-volume", volume: 0.3 },
      origin: "https://www.youtube.com",
    },
  ]);
  assert.equal(typeof posted[0].message, "string", "the IFrame API only accepts a JSON string");
  check("CHZZK and YouTube tiles receive their own volume commands", true);
}

// Volume travels with the audio handshake, so player-ready, frame load and
// reload restore it without a separate schedule.
{
  const { context, posted } = makeContext();
  context.setTileVolume(liveKey, 40);
  posted.length = 0;
  context.applyAudioState(context.tiles.get(liveKey), live);
  assert.deepEqual(posted.map((entry) => plain(entry).message), [
    { source: "stellaview", type: "set-muted", muted: true },
    { source: "stellaview", type: "set-volume", volume: 0.4 },
  ]);
  check("an audio handshake re-sends the selected volume", true);
}

// Removing a stream drops its frame reports but keeps its set volume, so a
// member toggled off and on gets the same level back.
{
  const { context, setStreams } = makeContext();
  context.setTileVolume(liveKey, 20);
  context.setTileVolume(videoKey, 60);
  context.volumeCapabilities.set(videoKey, { supported: false, mode: "none" });
  context.siteVolumes.set(videoKey, 30);
  setStreams([live]);
  context.pruneVolumeState();
  assert.deepEqual([...context.tileVolumes.entries()], [[liveKey, 20], [videoKey, 60]]);
  assert.deepEqual([...context.volumeCapabilities.keys()], []);
  assert.deepEqual([...context.siteVolumes.keys()], []);
  check("removed streams keep their volume and lose their frame reports", true);
}

// The Chrome extension leaves an untouched tile's volume to the player: the
// handshake carries only the mute until the panel slider has been moved.
{
  const { context, posted } = makeContext({ wrapper: false });
  context.applyAudioState(context.tiles.get(liveKey), live);
  assert.deepEqual(posted.map((entry) => plain(entry).message), [
    { source: "stellaview", type: "set-muted", muted: true },
  ]);
  posted.length = 0;
  context.setTileVolume(liveKey, 40);
  assert.deepEqual(posted.map((entry) => plain(entry).message), [
    { source: "stellaview", type: "set-volume", volume: 0.4 },
  ]);
  check("the extension sends no volume for an untouched tile and does once it is set", true);
}

// Stored settings are attacker-shaped input: anything but an in-range number
// is discarded rather than reaching a player command.
{
  const { context } = makeContext();
  assert.deepEqual({ ...context.sanitizeVolumes({
    [liveKey]: 50,
    [videoKey]: 33.4,
    string: "50",
    nan: NaN,
    infinite: Infinity,
    high: 101,
    low: -1,
    nothing: null,
    object: { valueOf: () => 50 },
    boolean: true,
  }) }, { [liveKey]: 50, [videoKey]: 33 });
  for (const raw of [undefined, null, "100", 50, []]) {
    assert.deepEqual({ ...context.sanitizeVolumes(raw) }, {}, `reject ${JSON.stringify(raw) ?? "undefined"}`);
  }
  check("sanitizeVolumes keeps only integral 0..100 numbers", true);
}

console.log("Volume panel markup, defaults, clamping, frame commands, pruning and sanitizing checks passed");
