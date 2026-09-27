import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../Sources/Core/ChzzkPlaybackEvidence.swift", import.meta.url), "utf8");
const script = source.match(/static let probeScript = #"""\n([\s\S]*?)\n\s*"""#/)[1];
const content = { currentSrc: "blob:https://chzzk.naver.com/content", currentTime: 10, videoWidth: 1920 };
const ad = { currentSrc: "https://api.chzzk.naver.com/service/t/advert?token=private", currentTime: 1, videoWidth: 1920 };
const elements = [content, ad];
const context = vm.createContext({
  URL, performance: { timeOrigin: 100 }, location: { href: "https://chzzk.naver.com/live/test" },
  document: { querySelectorAll: () => elements },
});
const sample = () => vm.runInContext(`(() => { ${script}\n return videos; })()`, context);
const first = sample();
assert.equal(first[0].isKnownAd, false);
assert.equal(first[1].isKnownAd, true);
assert.equal(first[1].src.includes("token"), false);
assert.equal(first[0].id, sample()[0].id);
content.currentSrc = "blob:https://chzzk.naver.com/replaced";
assert.notEqual(first[0].id, sample()[0].id);
const replacement = { ...content };
elements[0] = replacement;
assert.notEqual(sample()[0].id, first[0].id);
replacement.currentSrc = "";
assert.equal(sample()[0].src, "");
console.log("probe classification, identity and URL redaction checks passed");
