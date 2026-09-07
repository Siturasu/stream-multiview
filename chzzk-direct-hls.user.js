// ==UserScript==
// @name         Chzzk Direct HLS (2026)
// @namespace    local.chzzk.direct-hls
// @version      2026.08.29.2
// @description  Remove CHZZK P2P/grid paths before the player reads playback metadata
// @match        https://chzzk.naver.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(() => {
  'use strict';

  const TAG = '[Chzzk Direct HLS]';
  const INSTALLED = '__chzzkDirectHls_20260829';
  const WRAPPED = '__chzzkDirectHlsWrapped';
  const nativeParse = JSON.parse;

  const hosts = new Set([
    'livecloud.pstatic.net',
    'nvelop-livecloud.pstatic.net',
    'ex-nlive-streaming.navercdn.com',
  ]);

  const playbackKeys = ['livePlaybackJson', 'playbackJson'];
  const qualityKeys = ['p2pQuality', 'pq'];
  const p2pKeys = ['p2pPath', 'p2pPathUrlEncoding'];
  const own = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);

  if (window[INSTALLED] || nativeParse[WRAPPED]) return;

  function stripP2P(object) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      return object;
    }

    if (!p2pKeys.some((key) => own(object, key))) return object;

    const copy = { ...object };
    for (const key of p2pKeys) delete copy[key];
    return copy;
  }

  function isDirectHls(media) {
    if (
      media?.protocol !== 'HLS' ||
      !['HLS', 'LLHLS'].includes(media?.mediaId) ||
      typeof media?.path !== 'string'
    ) {
      return false;
    }

    try {
      const url = new URL(media.path, location.href);
      return (
        url.protocol === 'https:' &&
        hosts.has(url.hostname) &&
        url.pathname.endsWith('.m3u8')
      );
    } catch {
      return false;
    }
  }

  function patchPlayback(playback) {
    if (
      !playback ||
      typeof playback !== 'object' ||
      Array.isArray(playback) ||
      !Array.isArray(playback.media)
    ) {
      return playback;
    }

    let changed = false;

    const media = playback.media.map((item) => {
      if (!isDirectHls(item)) return item;

      const cleanMedia = stripP2P(item);

      if (!Array.isArray(item.encodingTrack)) {
        changed ||= cleanMedia !== item;
        return cleanMedia;
      }

      const encodingTrack = item.encodingTrack.map(stripP2P);
      const tracksChanged = encodingTrack.some(
        (track, index) => track !== item.encodingTrack[index],
      );

      changed ||= cleanMedia !== item || tracksChanged;

      return tracksChanged
        ? { ...cleanMedia, encodingTrack }
        : cleanMedia;
    });

    if (!changed) return playback;

    const meta =
      playback.meta?.p2p === true
        ? { ...playback.meta, p2p: false }
        : playback.meta;

    return { ...playback, meta, media };
  }

  function patchEnvelope(value) {
    const content = value?.content;

    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return value;
    }

    let output = content;
    let changed = false;
    let foundPlayback = false;

    for (const key of playbackKeys) {
      if (!own(content, key)) continue;
      foundPlayback = true;

      try {
        const raw = content[key];
        const parsed = typeof raw === 'string' ? nativeParse(raw) : raw;
        const patched = patchPlayback(parsed);

        if (patched !== parsed) {
          output = {
            ...output,
            [key]: typeof raw === 'string'
              ? JSON.stringify(patched)
              : patched,
          };
          changed = true;
        }
      } catch {
        // Unknown payload: leave it unchanged.
      }
    }

    if (foundPlayback) {
      for (const key of qualityKeys) {
        if (Array.isArray(content[key]) && content[key].length) {
          output = { ...output, [key]: [] };
          changed = true;
        }
      }
    }

    return changed ? { ...value, content: output } : value;
  }

  let reported = false;

  function patchParsedValue(value) {
    const direct = patchPlayback(value);
    const result = direct !== value ? direct : patchEnvelope(value);

    if (result !== value && !reported) {
      reported = true;
      console.info(TAG, 'metadata patched');
    }

    return result;
  }

  const wrappedParse = function (...args) {
    const value = nativeParse.apply(this, args);

    if (
      !/^\/live(?:\/|$)/.test(location.pathname) ||
      (args.length > 1 && typeof args[1] === 'function')
    ) {
      return value;
    }

    return patchParsedValue(value);
  };

  try {
    Object.defineProperty(wrappedParse, WRAPPED, { value: true });
    JSON.parse = wrappedParse;
    Object.defineProperty(window, INSTALLED, { value: true });
    console.info(TAG, 'installed');
  } catch (error) {
    console.error(TAG, 'install failed', error);
  }
})();
