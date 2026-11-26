// Isolated-world hand-over for the MAIN-world frame scripts
// (content/chzzk-main.js, content/youtube-volume-frame.js). The MAIN world has
// no chrome.runtime, so it cannot tell this extension's viewer from another
// extension's page that frames the same ?sv=1 player. This script runs first
// (manifest.json lists it before them) and leaves the own origin on <html>;
// the MAIN-world script takes it and removes it before any page script runs.
(() => {
  "use strict";

  let embedded = false;
  try {
    embedded = window.self !== window.top;
  } catch {
    embedded = true;
  }
  if (!embedded || new URLSearchParams(location.search).get("sv") !== "1") return;

  const root = document.documentElement;
  if (root) root.dataset.svExtensionOrigin = new URL(chrome.runtime.getURL("/")).origin;
})();
