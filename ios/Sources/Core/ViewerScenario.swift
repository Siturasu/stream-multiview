import Foundation
import WebKit

/// Drives a ViewerWebViewController the way a user would and returns a JSON
/// report. Shared by the macOS harness (ios/harness/main.swift) and the iOS
/// app's harness mode (launch argument -svHarness), so the same checks run on
/// iPadOS WebKit in the simulator or on a device.
struct ScenarioOptions {
    /// YouTube video to add; nil skips the YouTube checks. The default is a
    /// permanent VOD so the Referer path is always testable.
    var youtube: String? = "dQw4w9WgXcQ"
    /// CHZZK channel id to add through the form; nil picks the first LIVE
    /// member from the library.
    var channel: String?
    /// Explicit recording fixtures exercise simultaneous playback even offline.
    var chzzkVideos: [String] = []
    var timeout: Double = 40
}

/// Forwards console.error/warn and uncaught errors from every frame to the
/// "stellaViewHarness" message handler.
let consoleCaptureScript = #"""
(() => {
  const handler = globalThis.webkit?.messageHandlers?.stellaViewHarness;
  if (!handler) return;
  const send = (level, parts) => {
    try {
      const text = parts.map((part) => {
        if (typeof part === "string") return part;
        try { return JSON.stringify(part); } catch { return String(part); }
      }).join(" ").slice(0, 400);
      handler.postMessage({ level, frame: location.href.slice(0, 100), text });
    } catch {}
  };
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...parts) => { send(level, parts); original(...parts); };
  }
  window.addEventListener("error", (event) => send("uncaught", [event.message, event.filename, event.lineno]));
  window.addEventListener("unhandledrejection", (event) => send("rejection", [String(event.reason?.message || event.reason)]));
})();
"""#

@MainActor
final class PageLog: NSObject, WKScriptMessageHandler {
    private(set) var entries: [[String: Any]] = []
    var onEntry: ((String) -> Void)?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let entry = message.body as? [String: Any] else { return }
        entries.append(entry)
        let level = entry["level"] as? String ?? "log"
        let frame = entry["frame"] as? String ?? ""
        let text = entry["text"] as? String ?? ""
        onEntry?("[page \(level)] \(frame) :: \(text)")
    }
}

@MainActor
final class ViewerScenario {
    let options: ScenarioOptions
    let controller: ViewerWebViewController
    let pageLog: PageLog
    var log: (String) -> Void = { message in fputs(message + "\n", stderr) }

    private var frames: [(url: URL, frame: WKFrameInfo)] = []
    private var report: [String: Any] = [:]
    private var failures: [String] = []
    private var inconclusive: [String] = []
    private var webViewErrors: [String] = []

    /// Adds the console capture script and the page-log handler. Pass this in
    /// the controller's `configure` closure (it runs before the app scripts).
    static func instrument(_ userContent: WKUserContentController, pageLog: PageLog) {
        userContent.addUserScript(WKUserScript(
            source: consoleCaptureScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page
        ))
        userContent.add(pageLog, contentWorld: .page, name: "stellaViewHarness")
        userContent.addUserScript(WKUserScript(
            source: """
            globalThis.__svSessionChecks = {};
            window.addEventListener('message', event => {
              if (event.origin !== 'https://chzzk.naver.com' || event.data?.source !== 'stellaview-session') return;
              const frame = [...document.querySelectorAll('iframe.stream-frame')].find(frame => frame.contentWindow === event.source);
              if (!frame) return;
              globalThis.__svSessionChecks[frame.closest('.stream-tile').dataset.key] = {
                loggedIn: event.data.loggedIn, reason: event.data.reason,
              };
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
            in: .page
        ))
    }

    init(controller: ViewerWebViewController, pageLog: PageLog, options: ScenarioOptions) {
        self.controller = controller
        self.pageLog = pageLog
        self.options = options
        pageLog.onEntry = { [weak self] line in self?.log(line) }
        controller.bridge.logHandler = { [weak self] text in self?.log("[bridge] \(text)") }
        controller.bridge.openLoginHandler = { [weak self] in self?.log("[bridge] openLogin requested") }
        controller.navigationObserver = { [weak self] action in
            guard let self, let url = action.request.url, let frame = action.targetFrame, !frame.isMainFrame else { return }
            self.frames.append((url, frame))
        }
        controller.errorHandler = { [weak self] message in
            self?.webViewErrors.append(message)
            self?.log("[webview] \(message)")
        }
    }

    // MARK: - JS helpers

    private func evaluate(_ body: String, in frame: WKFrameInfo? = nil) async throws -> String {
        let script = "JSON.stringify((() => {\n\(body)\n})() ?? null)"
        let webView = controller.webView
        // The completion-handler overload is unambiguous; the plain call would
        // resolve to the fire-and-forget variant (completionHandler: nil).
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script, in: frame, in: .page) { outcome in
                switch outcome {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
        return (result as? String) ?? "null"
    }

    private func query(_ body: String, in frame: WKFrameInfo? = nil) async throws -> Any? {
        let text = try await evaluate(body, in: frame)
        let object = try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
        return object is NSNull ? nil : object
    }

    /// Runs an async function body inside a frame and returns its JSON value.
    private func queryAsync(_ body: String, in frame: WKFrameInfo? = nil) async throws -> Any? {
        let webView = controller.webView
        let result: Any? = try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(body, arguments: [:], in: frame, in: .page) { outcome in
                switch outcome {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
        return result is NSNull ? nil : result
    }

    private func poll(_ label: String, timeout: Double? = nil, interval: Double = 0.5, _ check: () async throws -> Any?) async -> Any? {
        let deadline = Date().addingTimeInterval(timeout ?? options.timeout)
        var lastError: String?
        while Date() < deadline {
            do {
                if let value = try await check() { return value }
            } catch {
                lastError = error.localizedDescription
            }
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
        }
        log("[harness] timeout: \(label)\(lastError.map { " (last error: \($0))" } ?? "")")
        return nil
    }

    private func sleep(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    private func frame(host: String, pathPrefix: String) -> WKFrameInfo? {
        frames.last { $0.url.host?.lowercased() == host && $0.url.path.hasPrefix(pathPrefix) }?.frame
    }

    /// A CHZZK tile is either a live channel (/live/) or a recording (/video/).
    private func chzzkStreamFrame() -> WKFrameInfo? {
        frames.last {
            $0.url.host?.lowercased() == "chzzk.naver.com"
                && ($0.url.path.hasPrefix("/live/") || $0.url.path.hasPrefix("/video/"))
                && !$0.url.path.hasSuffix("/chat")
        }?.frame
    }

    private func fail(_ message: String) {
        failures.append(message)
        log("[harness] FAIL: \(message)")
    }

    private func pass(_ message: String) {
        log("[harness] ok: \(message)")
    }

    private func skip(_ message: String) {
        inconclusive.append(message)
        log("[harness] inconclusive: \(message)")
    }

    // MARK: - Probes

    private let chzzkTileQuery = """
    const tile = [...document.querySelectorAll('.stream-tile')].find((t) => (t.dataset.key || '').startsWith('chzzk:'));
    if (!tile) return null;
    return { ready: tile.dataset.playerReady || '', quality: tile.querySelector('.quality-pill')?.textContent || '', key: tile.dataset.key || '' };
    """

    private let chzzkProbe = ChzzkPlaybackEvidence.probeScript + "\n" + """
    const root = document.documentElement;
    return {
      href: location.href.slice(0, 120),
      svEmbedded: root.classList.contains("sv-embedded"),
      qualityStatus: root.dataset.svQualityStatus || null,
      qualityLabel: root.dataset.svQualityLabel || null,
      qualityMethod: root.dataset.svQualityMethod || null,
      styleInjected: !!document.getElementById("sv-embed-style"),
      playerRoot: !!document.querySelector(".sv-player-root"),
      directHls: !!window.__stellaViewDirectHlsInstalled,
      activityRelay: root.dataset.svActivityRelay || null,
      cookie: document.cookie.includes("sv_probe=1"),
      cookieLax: document.cookie.includes("sv_probe_lax=1"),
      videos,
    };
    """

    private let youtubeProbe = """
    const v = document.querySelector("video");
    const errorNode = document.querySelector(".ytp-error, .ytp-error-content-wrap-reason, #player-unavailable, .ytp-error-content");
    return {
      href: location.href.slice(0, 140),
      title: document.title,
      error: errorNode ? errorNode.textContent.trim().slice(0, 200) : null,
      cookie: document.cookie.includes("sv_probe=1"),
      cookieLax: document.cookie.includes("sv_probe_lax=1"),
      video: v ? { paused: v.paused, muted: v.muted, readyState: v.readyState, currentTime: Math.round(v.currentTime * 10) / 10 } : null,
    };
    """

    /// Wait through pre/mid-roll ads and require progress in the same content
    /// element/source. The timeout is a bound, not evidence of playback.
    private func waitForContentProgress(in frame: WKFrameInfo, requireAudio: Bool = false, reportKey: String) async -> Any? {
        let deadline = Date().addingTimeInterval(options.timeout)
        var previous: Any?
        var lastProbe: Any?
        var knownAdObserved = false
        var lastError: String?
        while Date() < deadline {
            do {
                let probe = try await query(chzzkProbe, in: frame)
                lastProbe = probe
                knownAdObserved = knownAdObserved || ChzzkPlaybackEvidence.videos(probe).contains { $0["isKnownAd"] as? Bool == true }
                if let evidence = ChzzkPlaybackEvidence.progress(from: previous, to: probe, requireAudio: requireAudio) {
                    report[reportKey] = ["status": "passed", "knownAdObserved": knownAdObserved, "evidence": evidence]
                    pass("\(reportKey): content advanced \(evidence["advancedSeconds"] ?? 0)s in the same video/source")
                    return probe
                }
                previous = probe
            } catch {
                previous = nil
                lastError = error.localizedDescription
            }
            await sleep(2)
        }
        var result: [String: Any] = [
            "status": "failed", "knownAdObserved": knownAdObserved,
            "timeoutSeconds": options.timeout, "lastProbe": lastProbe ?? "unreachable",
        ]
        if let lastError { result["lastError"] = lastError }
        report[reportKey] = result
        fail("\(reportKey): no same-source content progress\(requireAudio ? " with audio enabled" : "") within \(options.timeout)s (known ad observed: \(knownAdObserved))")
        return nil
    }

    /// These script-readable probes only verify their own third-party cookie
    /// visibility. They do not prove HttpOnly login or authenticated playback.
    /// Runs after the first load so the network process exists.
    private func seedProbeCookies() async {
        let cookieStore = controller.webView.configuration.websiteDataStore.httpCookieStore
        var requested = 0
        for domain in [".naver.com", ".youtube.com"] {
            for (name, policy) in [("sv_probe", nil), ("sv_probe_lax", HTTPCookieStringPolicy.sameSiteLax.rawValue)] as [(String, String?)] {
                var properties: [HTTPCookiePropertyKey: Any] = [
                    .domain: domain,
                    .path: "/",
                    .name: name,
                    .value: "1",
                    .secure: "TRUE",
                    .expires: Date().addingTimeInterval(3600),
                ]
                if let policy { properties[.sameSitePolicy] = policy }
                guard let cookie = HTTPCookie(properties: properties) else { continue }
                requested += 1
                await cookieStore.setCookie(cookie)
            }
        }
        report["probeCookiesRequested"] = requested
    }

    // MARK: - Scenario

    func run() async -> [String: Any] {
        report["privateSettings"] = controller.privateSettings.dictionary
        log("[harness] run: private settings \(controller.privateSettings.dictionary)")

        do {
            try controller.loadViewer()
        } catch {
            fail("loadViewer: \(error.localizedDescription)")
            return finish()
        }

        // 1. Viewer document rendered (modules resolved, viewer.js ran).
        let memberCount = await poll("viewer render", timeout: 20) {
            let count = try await self.query("return document.querySelectorAll('.viewer-member').length;") as? Int ?? 0
            return count > 0 ? count : nil
        }
        report["memberButtons"] = memberCount ?? 0
        guard let memberCount else {
            fail("viewer did not render member library")
            return finish()
        }
        pass("viewer rendered with \(memberCount) member buttons")

        if !options.chzzkVideos.isEmpty {
            await runVideoScenario()
            return finish()
        }

        // 2. Live status fetched through the native fetch bridge.
        let states = await poll("member status fetch", timeout: 25) {
            try await self.query("""
            const states = [...document.querySelectorAll('.viewer-member-state')].map((e) => e.textContent.trim());
            return states.length && states.every((s) => s !== '…') ? states : null;
            """)
        }
        report["memberStates"] = states ?? "timeout"
        if states == nil { fail("member statuses were not fetched (native fetch bridge)") } else { pass("member statuses: \(states!)") }

        await seedProbeCookies()

        // 3. Add a CHZZK stream: explicit channel id, else the first LIVE
        //    member; with nobody live, an offline member still exercises the
        //    iframe injection but playback checks become inconclusive.
        var live = false
        if let channel = options.channel {
            _ = try? await query("""
            document.querySelector('#viewer-stream-input').value = \(WebAssets.jsString(channel));
            document.querySelector('#viewer-add-form').requestSubmit();
            return 'submitted';
            """)
            report["chzzkTarget"] = ["channelId": channel]
            live = true
        } else {
            let target = try? await query("""
            const members = [...document.querySelectorAll('.viewer-member')];
            const state = (b) => b.querySelector('.viewer-member-state')?.textContent.trim() || '';
            const button = members.find((b) => state(b) === 'LIVE') || members.find((b) => state(b) === 'OFF');
            if (!button) return null;
            button.click();
            return { name: button.querySelector('strong')?.textContent || '', live: state(button) === 'LIVE' };
            """)
            report["chzzkTarget"] = target ?? "none"
            live = ((target as? [String: Any])?["live"] as? Bool) ?? false
            if !live { skip("no live CHZZK member; playback, quality and unmute checks skipped") }
        }

        // 4. Tile handshake: the page-world script inside the chzzk iframe must
        //    post player-ready back to the viewer (origin check + injection).
        let tileReady = await poll("chzzk tile handshake") {
            let tile = try await self.query(self.chzzkTileQuery) as? [String: Any]
            return (tile?["ready"] as? String) == "1" ? tile : nil
        }
        report["chzzkTile"] = (try? await query(chzzkTileQuery)) ?? "missing"
        if tileReady == nil { fail("chzzk tile never reported player-ready") } else { pass("chzzk tile handshake complete: \(tileReady!)") }

        // 5. Inside the chzzk frame: no mobile redirect, injection, cookies, playback, quality.
        if let chzzkFrame = chzzkStreamFrame() {
            let playback = live ? await waitForContentProgress(in: chzzkFrame, reportKey: "chzzkContentPlayback") : nil
            let probe: Any?
            if let playback { probe = playback }
            else { probe = try? await query(chzzkProbe, in: chzzkFrame) }
            report["chzzkFrame"] = probe ?? "unreachable"
            if let dict = probe as? [String: Any] {
                if (dict["href"] as? String)?.hasPrefix("https://chzzk.naver.com/") == true { pass("chzzk frame stayed on desktop host") } else { fail("chzzk frame navigated away: \(dict["href"] ?? "")") }
                if dict["svEmbedded"] as? Bool == true { pass("chzzk-main.js ran inside the iframe") } else { fail("chzzk-main.js did not mark the frame (sv-embedded missing)") }
                if dict["styleInjected"] as? Bool == true { pass("chzzk-embed.css injected") } else { fail("chzzk-embed.css missing") }
                // The extension's frame-activity.js only matches /live/ frames; a
                // recording (/video/) legitimately has no relay.
                if (dict["href"] as? String)?.contains("/video/") == true {
                    log("[harness] frame-activity relay not expected for a VOD frame")
                } else if dict["activityRelay"] as? String == "ready" { pass("frame-activity.js ran in the isolated world") } else { fail("frame-activity.js did not run") }
                if dict["cookie"] as? Bool == true { pass("third-party cookie reached the chzzk frame") } else { fail("third-party probe cookie did not reach the chzzk frame") }
                // Naver's NID_AUT/NID_SES are SameSite=Lax on the device; the
                // same-site viewer origin is what lets them reach the tiles.
                if dict["cookieLax"] as? Bool == true { pass("SameSite=Lax cookie reached the chzzk frame (same-site viewer)") } else { fail("SameSite=Lax cookie did not reach the chzzk frame: login cookies would not apply") }
                if dict["qualityMethod"] as? String == "preference" { pass("quality preference written") } else { fail("quality preference could not be written (method: \(dict["qualityMethod"] ?? "nil"))") }
                // Capability probe: can Web Audio start without a gesture in this
                // frame (fallback path when HTMLMediaElement.volume is ignored)?
                let volumeProbe = try? await queryAsync("""
                // The raw setter is not probed here: the content script's volume
                // controller re-applies the viewer's value on volumechange, which
                // would read as "setter ignored". The panel step measures it.
                const video = [...document.querySelectorAll("video")].find((v) => v.currentSrc) || document.querySelector("video");
                const result = { hasVideo: !!video, videoVolume: video ? video.volume : null };
                const Context = window.AudioContext || window.webkitAudioContext;
                result.hasWebAudio = typeof Context === "function";
                if (result.hasWebAudio) {
                  try {
                    const context = new Context();
                    result.audioContextInitialState = context.state;
                    await context.resume().catch(() => {});
                    result.audioContextAfterResume = context.state;
                    await context.close().catch(() => {});
                  } catch (error) {
                    result.audioContextError = String(error?.name || error);
                  }
                }
                return result;
                """, in: chzzkFrame)
                report["volumeCapability"] = volumeProbe ?? "unavailable"
                log("[harness] volume capability: \(volumeProbe ?? "unavailable")")
            } else {
                fail("could not evaluate inside the chzzk frame")
            }

            if live {
                if let playback = playback as? [String: Any] {
                    let status = (playback["qualityStatus"] as? String) ?? ""
                    let label = (playback["qualityLabel"] as? String) ?? ""
                    report["chzzkQuality"] = ["status": status, "label": label]
                    switch status {
                    case "selected": pass("quality selected: \(label)")
                    case "fallback":
                        let height = Int(label.replacingOccurrences(of: "p", with: "")) ?? 0
                        if height >= 720 { pass("quality fell back to \(label)") } else { fail("quality fell back below 720p: \(label)") }
                    default: fail("quality was never confirmed (status: \(status))")
                    }
                }

                // 6. Unmute through the viewer's audio button (postMessage → content script).
                _ = try? await query("""
                const tile = [...document.querySelectorAll('.stream-tile')].find((t) => (t.dataset.key || '').startsWith('chzzk:'));
                tile?.querySelector('[data-action="audio"]')?.click();
                return 'ok';
                """)
                let afterUnmute = await waitForContentProgress(in: chzzkFrame, requireAudio: true, reportKey: "chzzkContentAfterUnmute")
                report["chzzkAfterUnmute"] = afterUnmute ?? "no content progress with audio enabled"

                // 6b. Volume panel: the chzzk row's slider must drive the frame's
                //     HTMLMediaElement.volume (element mode) or report unsupported.
                let sliderSet = try? await query("""
                document.querySelector('#volume-toggle')?.click();
                const row = document.querySelector('.volume-row[data-key^="chzzk:"]');
                const range = row?.querySelector('input.volume-range');
                if (!range) return null;
                range.value = '30';
                range.dispatchEvent(new Event('input', { bubbles: true }));
                range.dispatchEvent(new Event('change', { bubbles: true }));
                return { panelOpen: document.body.classList.contains('volume-panel-open'), disabled: range.disabled };
                """)
                await sleep(1.5)
                let frameVolume = (try? await queryAsync("""
                const video = [...document.querySelectorAll('video')].find((v) => v.currentSrc);
                return video ? { volume: video.volume, muted: video.muted } : null;
                """, in: chzzkFrame)) ?? nil
                let rowState = (try? await query("""
                const row = document.querySelector('.volume-row[data-key^="chzzk:"]');
                const range = row?.querySelector('input.volume-range');
                if (!range) return null;
                const result = { disabled: range.disabled, value: range.value, hint: row.querySelector('.volume-hint')?.textContent || '' };
                range.value = '100';
                range.dispatchEvent(new Event('input', { bubbles: true }));
                range.dispatchEvent(new Event('change', { bubbles: true }));
                document.querySelector('#volume-toggle')?.click();
                return result;
                """)) ?? nil
                report["volumePanelChzzk"] = ["slider": sliderSet ?? "missing", "frame": frameVolume ?? "unreachable", "row": rowState ?? "missing"]
                let observed = ((frameVolume as? [String: Any])?["volume"] as? Double) ?? -1
                if sliderSet == nil { fail("volume panel has no row for the chzzk tile") }
                else if abs(observed - 0.3) < 0.02 { pass("volume slider set the chzzk frame volume to 0.3") }
                else if (rowState as? [String: Any])?["disabled"] as? Bool == true { fail("chzzk frame reported volume unsupported (slider disabled)") }
                else { fail("chzzk frame volume is \(observed) after moving the slider to 30") }

            }
        } else {
            fail("no chzzk /live/ frame was created")
        }

        // 7. YouTube tile: Referer from the https base URL must satisfy YouTube.
        if let videoId = options.youtube {
            _ = try? await query("""
            document.querySelector('#viewer-stream-input').value = \(WebAssets.jsString("https://www.youtube.com/watch?v=\(videoId)"));
            document.querySelector('#viewer-add-form').requestSubmit();
            return 'submitted';
            """)
            let youtubeTile = await poll("youtube tile", timeout: 20) {
                try await self.query("return document.querySelector('.platform-pill.youtube') ? 'ok' : null;")
            }
            if youtubeTile == nil { fail("youtube tile was not created") }
            await sleep(2)
            if let youtubeFrame = frame(host: "www.youtube.com", pathPrefix: "/embed/") {
                let outcome = await poll("youtube playback", timeout: 35) {
                    let probe = try await self.query(self.youtubeProbe, in: youtubeFrame) as? [String: Any]
                    if probe?["error"] != nil { return probe }
                    if let video = probe?["video"] as? [String: Any], ((video["currentTime"] as? Double) ?? 0) > 0 { return probe }
                    return nil
                }
                let probe = ((try? await query(youtubeProbe, in: youtubeFrame)) ?? nil) as? [String: Any]
                report["youtubeFrame"] = probe ?? "unreachable"
                if let error = probe?["error"] as? String, !error.isEmpty {
                    fail("youtube player error: \(error)")
                } else if outcome != nil {
                    // Embedded YouTube can cut to an ad or rebuffer mid-check, which
                    // resets the element; accept any of three 2-second windows.
                    var advanced = 0.0
                    var previous = ((probe?["video"] as? [String: Any])?["currentTime"] as? Double) ?? 0
                    for _ in 0..<3 {
                        await sleep(2)
                        let sample = ((try? await query(youtubeProbe, in: youtubeFrame)) ?? nil) as? [String: Any]
                        let now = ((sample?["video"] as? [String: Any])?["currentTime"] as? Double) ?? 0
                        advanced = now - previous
                        previous = now
                        if advanced >= 1 { break }
                    }
                    if advanced >= 1 { pass("youtube video is playing (advanced \(advanced)s in 2s)") } else { fail("youtube video stalled (last window advanced \(advanced)s)") }
                } else {
                    fail("youtube video did not start")
                }
                if probe?["cookie"] as? Bool == true { pass("third-party cookie reached the youtube frame") } else { fail("third-party probe cookie did not reach the youtube frame") }
                let ytSlider = try? await query("""
                document.querySelector('#volume-toggle')?.click();
                const row = document.querySelector('.volume-row[data-key^="youtube:"]');
                const range = row?.querySelector('input.volume-range');
                if (!range) return null;
                range.value = '40';
                range.dispatchEvent(new Event('input', { bubbles: true }));
                range.dispatchEvent(new Event('change', { bubbles: true }));
                return { disabled: range.disabled };
                """)
                await sleep(1.5)
                let ytVolume = (try? await queryAsync("""
                const video = document.querySelector('video');
                return video ? { volume: video.volume, muted: video.muted } : null;
                """, in: youtubeFrame)) ?? nil
                _ = try? await query("""
                const range = document.querySelector('.volume-row[data-key^="youtube:"] input.volume-range');
                if (range) { range.value = '100'; range.dispatchEvent(new Event('input', { bubbles: true })); range.dispatchEvent(new Event('change', { bubbles: true })); }
                document.querySelector('#volume-toggle')?.click();
                return 'ok';
                """)
                report["volumePanelYouTube"] = ["slider": ytSlider ?? "missing", "frame": ytVolume ?? "unreachable"]
                let ytObserved = ((ytVolume as? [String: Any])?["volume"] as? Double) ?? -1
                if ytSlider == nil { fail("volume panel has no row for the youtube tile") }
                else if abs(ytObserved - 0.4) < 0.02 { pass("volume slider set the youtube frame volume to 0.4") }
                else { fail("youtube frame volume is \(ytObserved) after moving the slider to 40") }
            } else {
                fail("no youtube embed frame was created")
            }
        }

        // 8. Login dismissal must refresh cookies without losing an unsaved
        // composition. Exercise the exact controller path used by the app.
        do {
            _ = try await query("""
            const remember = document.querySelector('#remember-session');
            remember.checked = false;
            remember.dispatchEvent(new Event('change', { bubbles: true }));
            document.querySelector('.stream-tile [data-action="chat"]')?.click();
            const tiles = [...document.querySelectorAll('.stream-tile')];
            const chat = document.querySelector('#chat-frame');
            const frames = tiles.map((tile) => tile.querySelector('.stream-frame'));
            if (chat?.getAttribute('src') && chat.getAttribute('src') !== 'about:blank') frames.push(chat);
            const refreshed = new Set();
            const observer = new MutationObserver((records) => {
              for (const record of records) refreshed.add(record.target);
            });
            frames.forEach((frame) => observer.observe(frame, { attributes: true, attributeFilter: ['src'] }));
            globalThis.__svHarnessLogin = {
              body: document.body, tiles, frames, chatSource: chat?.getAttribute('src'),
              youtubeBadge: tiles.find((tile) => tile.dataset.key.startsWith('youtube:'))?.querySelector('.quality-pill')?.textContent || '',
              audioKeys: [...document.querySelectorAll('.is-audio-active')].map(tile => tile.dataset.key).sort(),
              observer, refreshed,
            };
            return tiles.length;
            """)
            let removed = await poll("unsaved composition", timeout: 5) {
                self.controller.bridge.storage.all()["selectedStreams"] == nil ? "removed" : nil
            }
            if removed == nil { fail("rememberSession=false did not remove persisted streams") }
            try await controller.refreshStreamsAfterLogin()
            let result = try await query("""
            const before = globalThis.__svHarnessLogin;
            if (!before) return { sameDocument: false };
            for (const record of before.observer.takeRecords()) before.refreshed.add(record.target);
            before.observer.disconnect();
            const tiles = [...document.querySelectorAll('.stream-tile')];
            return {
              sameDocument: document.body === before.body,
              sameTiles: tiles.length > 0 && tiles.length === before.tiles.length && tiles.every((tile, i) => tile === before.tiles[i]),
              sameAudio: JSON.stringify([...document.querySelectorAll('.is-audio-active')].map(tile => tile.dataset.key).sort()) === JSON.stringify(before.audioKeys),
              sameChat: document.querySelector('#chat-frame')?.getAttribute('src') === before.chatSource,
              sameYoutubeBadge: (tiles.find((tile) => tile.dataset.key.startsWith('youtube:'))?.querySelector('.quality-pill')?.textContent || '') === before.youtubeBadge,
              rememberSessionDisabled: document.querySelector('#remember-session')?.checked === false,
              allFramesRefreshed: before.frames.every((frame) => before.refreshed.has(frame)),
              tileCount: tiles.length, refreshedFrameCount: before.refreshed.size,
            };
            """) as? [String: Any] ?? [:]
            report["loginRefresh"] = result
            let checks = ["sameDocument", "sameTiles", "sameAudio", "sameChat", "sameYoutubeBadge", "rememberSessionDisabled", "allFramesRefreshed"]
            if checks.allSatisfy({ result[$0] as? Bool == true }) { pass("login refresh preserved unsaved tiles, audio and chat; all active frames refreshed") }
            else { fail("login refresh changed the composition or did not refresh every frame: \(result)") }
        } catch {
            fail("login refresh check failed: \(error.localizedDescription)")
        }

        // 9. Console noise and web view errors.
        var counts: [String: Int] = [:]
        for entry in pageLog.entries { counts[(entry["level"] as? String) ?? "log", default: 0] += 1 }
        report["pageLogCounts"] = counts
        report["pageLogTail"] = pageLog.entries.suffix(12).map { entry in
            "\((entry["level"] as? String) ?? "") \((entry["frame"] as? String) ?? "") :: \((entry["text"] as? String) ?? "")"
        }
        if webViewErrors.contains(where: { $0.contains("terminated") }) { fail("web content process terminated during the run") }
        return finish()
    }

    /// Both videos must advance over the same sampling intervals. Checking one
    /// tile and then the other would miss mobile media-focus interruptions.
    private func runVideoScenario() async {
        let ids = options.chzzkVideos
        guard ids.count >= 2, Set(ids).count == ids.count,
              ids.allSatisfy({ $0.range(of: #"^[1-9][0-9]{0,15}$"#, options: .regularExpression) != nil }) else {
            fail("VOD scenario needs at least two different numeric video ids")
            return
        }
        report["chzzkVideos"] = ids
        // A fresh top-level WebKit page must report signedOut, not unavailable.
        // This uses no saved account and catches wrong-host/CORS regressions that
        // success-only fetch mocks cannot detect.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let loginProbe = WKWebView(frame: .zero, configuration: configuration)
        loginProbe.customUserAgent = ViewerConfiguration.userAgent
        loginProbe.load(URLRequest(url: URL(string: "https://chzzk.naver.com/")!))
        let loginLoaded = await poll("anonymous CHZZK page", timeout: 30) {
            loginProbe.url?.host == "chzzk.naver.com" && !loginProbe.isLoading ? true : nil
        }
        let loginStatus = loginLoaded == nil ? ChzzkLoginStatus.unavailable : await LoginWebViewFactory.checkChzzkLogin(in: loginProbe)
        report["anonymousChzzkLogin"] = String(describing: loginStatus)
        if loginStatus != .signedOut { fail("anonymous CHZZK login checker did not return signedOut") }
        else { pass("anonymous CHZZK login status: signedOut") }
        for id in ids {
            _ = try? await query("""
            document.querySelector('#viewer-stream-input').value = \(WebAssets.jsString("https://chzzk.naver.com/video/\(id)"));
            document.querySelector('#viewer-add-form').requestSubmit();
            return true;
            """)
            let tile = await poll("VOD tile \(id)", timeout: 20) {
                try await self.query("return document.querySelector('[data-key=\"chzzk:video:\(id)\"]') ? true : null;")
            }
            if tile == nil { fail("VOD input was not accepted: \(id)"); return }
        }

        func parallel(_ key: String, audible: Set<String> = []) async -> Bool {
            let deadline = Date().addingTimeInterval(options.timeout)
            var previous: [String: Any] = [:]
            var last: [String: Any] = [:]
            var streak = 0
            var evidence: [String: Any] = [:]
            while Date() < deadline {
                var current: [String: Any] = [:]
                for id in ids {
                    if let frame = frame(host: "chzzk.naver.com", pathPrefix: "/video/\(id)"),
                       let sample = try? await query(chzzkProbe, in: frame) {
                        current[id] = sample
                    }
                }
                last = current
                var round: [String: Any] = [:]
                for id in ids {
                    guard let sample = current[id] as? [String: Any],
                          sample["svEmbedded"] as? Bool == true,
                          let progress = ChzzkPlaybackEvidence.progress(from: previous[id], to: sample, requireAudio: audible.contains(id)) else { continue }
                    let content = ChzzkPlaybackEvidence.contentVideos(sample)
                    guard !content.isEmpty,
                          content.allSatisfy({ ($0["muted"] as? Bool) == !audible.contains(id) }) else { continue }
                    round[id] = progress
                }
                if round.count == ids.count {
                    streak += 1
                    evidence = round
                    if streak >= 2 {
                        report[key] = ["status": "passed", "commonProgressWindows": streak, "evidence": evidence]
                        pass("\(key): all \(ids.count) VODs advanced in two common windows with correct audio focus")
                        return true
                    }
                } else { streak = 0 }
                previous = current
                await sleep(2)
            }
            report[key] = ["status": "failed", "lastProbes": last, "commonProgressWindows": streak]
            fail("\(key): VODs did not advance together with the expected audio focus")
            return false
        }

        guard await parallel("vodConcurrentMuted") else { return }
        let frameLoginChecks = await poll("embedded login status response", timeout: 12) {
            try await self.query("""
            const statuses = globalThis.__svSessionChecks;
            const keys = \(WebAssets.jsString(ids.joined(separator: ","))).split(',').map(id => 'chzzk:video:' + id);
            return keys.every(key => typeof statuses[key]?.loggedIn === 'boolean') ? statuses : null;
            """)
        }
        report["embeddedLoginChecks"] = frameLoginChecks ?? "unavailable"
        if frameLoginChecks == nil { fail("embedded CHZZK login status checks failed") }
        func toggleAudio(_ id: String) async {
            _ = try? await query("document.querySelector('[data-key=\"chzzk:video:\(id)\"] [data-action=\"audio\"]').click(); return true;")
        }
        await toggleAudio(ids[0])
        guard await parallel("vodFirstAudio", audible: [ids[0]]) else { return }
        for id in ids.dropFirst() { await toggleAudio(id) }
        guard await parallel("vodMultipleAudio", audible: Set(ids)) else { return }
        await toggleAudio(ids[0])
        guard await parallel("vodMuteOneOnly", audible: Set(ids.dropFirst())) else { return }
        _ = try? await query("document.querySelector('#mute-all').click(); return true;")
        guard await parallel("vodMuteAll") else { return }
        for id in ids { await toggleAudio(id) }
        guard await parallel("vodMultipleAudioRestored", audible: Set(ids)) else { return }

        if (try? await query("return document.documentElement.dataset.svIOSFullscreenAdapter === '1';")) as? Bool == true {
            guard let firstFrame = frame(host: "chzzk.naver.com", pathPrefix: "/video/\(ids[0])") else {
                fail("fullscreen test could not find its player frame"); return
            }
            let controlsHidden = """
            const exit = document.querySelector('.sv-ios-fullscreen-exit');
            return document.body.classList.contains('fullscreen-controls-hidden') && exit &&
              getComputedStyle(exit).opacity === '0' && getComputedStyle(exit).pointerEvents === 'none' ? true : null;
            """
            func revealControls(fromFrame: Bool = false) async -> Bool {
                if fromFrame {
                    _ = try? await query("document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true;", in: firstFrame)
                } else {
                    let wakeReachable = try? await query("""
                    const wake = document.querySelector('.sv-ios-fullscreen-wake');
                    return document.elementFromPoint(innerWidth / 2, innerHeight / 2) === wake;
                    """)
                    guard wakeReachable as? Bool == true else { return false }
                    _ = try? await query("document.querySelector('.sv-ios-fullscreen-wake').click(); return true;")
                }
                return await poll("fullscreen controls visible after frame touch", timeout: 5) {
                    try await self.query("""
                    const exit = document.querySelector('.sv-ios-fullscreen-exit');
                    const rect = exit?.getBoundingClientRect();
                    return !document.body.classList.contains('fullscreen-controls-hidden') && !document.fullscreenElement &&
                      exit && !exit.hidden && getComputedStyle(exit).opacity === '1' && rect.width >= 44 && rect.height >= 44 &&
                      document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === exit ? true : null;
                    """)
                } != nil
            }
            func verifyControls(_ key: String) async -> Bool {
                guard await poll("fullscreen controls initially hidden", timeout: 5, { try await self.query(controlsHidden) }) != nil else {
                    fail("\(key): controls were not hidden on entry"); return false
                }
                guard await revealControls() else { fail("\(key): frame touch did not restore a tappable exit"); return false }
                guard await poll("fullscreen controls hidden after inactivity", timeout: 5, { try await self.query(controlsHidden) }) != nil else {
                    fail("\(key): controls stayed visible after inactivity"); return false
                }
                guard await revealControls(fromFrame: true) else { fail("\(key): frame activity relay failed"); return false }
                guard await poll("fullscreen controls rehide after relay", timeout: 5, { try await self.query(controlsHidden) }) != nil else {
                    fail("\(key): controls stayed visible after frame activity"); return false
                }
                report[key] = ["hiddenOnEntry": true, "wakeTapReveals": true, "frameTouchReveals": true, "hiddenAfterInactivity": true]
                return true
            }
            _ = try? await query("""
            globalThis.__svFullscreenFrames = [...document.querySelectorAll('.stream-frame')].map(frame => ({
              frame, source: frame.src, window: frame.contentWindow,
            }));
            document.querySelector('#fullscreen').click();
            return true;
            """)
            guard await verifyControls("vodAppFullscreenControls") else { return }
            if !(await parallel("vodAppFullscreen", audible: Set(ids))) { return }
            guard await revealControls() else { fail("app fullscreen exit could not be revealed"); return }
            _ = try? await query("document.querySelector('.sv-ios-fullscreen-exit').click(); return true;")

            _ = try? await query("document.querySelector('.sv-player-root').requestFullscreen(); return true;", in: firstFrame)
            let tileEntered = await poll("CSS player fullscreen", timeout: 5) {
                try await self.query("""
                const tile = document.querySelector('[data-key="chzzk:video:\(ids[0])"]');
                return tile?.classList.contains('sv-ios-fullscreen-tile') && !document.fullscreenElement ? true : null;
                """)
            }
            if tileEntered == nil { fail("player fullscreen did not expand the correct tile"); return }
            guard await verifyControls("vodTileFullscreenControls") else { return }
            if !(await parallel("vodTileFullscreen", audible: Set(ids))) { return }
            guard await revealControls() else { fail("tile fullscreen exit could not be revealed"); return }
            _ = try? await query("document.querySelector('.sv-ios-fullscreen-exit').click(); return true;")
            let reset = await poll("player fullscreen state reset", timeout: 5) {
                try await self.query("return document.fullscreenElement === null ? true : null;", in: firstFrame)
            }
            if reset == nil { fail("parent exit left player fullscreen state active"); return }
            let restored = try? await query("""
            return !document.body.classList.contains('fullscreen-view') &&
              !document.body.classList.contains('fullscreen-controls-hidden') &&
              document.querySelector('.sv-ios-fullscreen-exit').hidden &&
              globalThis.__svFullscreenFrames.every(({frame, source, window}) =>
                frame.isConnected && frame.src === source && frame.contentWindow === window);
            """)
            report["vodFullscreenRestored"] = restored ?? false
            if restored as? Bool != true { fail("fullscreen changed frame identity/source or did not restore the grid"); return }
            if !(await parallel("vodAfterFullscreen", audible: Set(ids))) { return }
        } else {
            skip("CSS fullscreen adapter not enabled in this harness run")
        }

        // A same-site hard navigation often drops sv/quality query parameters.
        // It must keep the wrapper's muted/inline policy and parent handshake.
        _ = try? await query("""
        for (const frame of document.querySelectorAll('.stream-frame')) {
          const url = new URL(frame.src);
          if (url.hostname === 'chzzk.naver.com' && url.pathname.startsWith('/video/')) {
            frame.src = url.origin + url.pathname;
          }
        }
        return true;
        """)
        if !(await parallel("vodNavigationWithoutFlags", audible: Set(ids))) { return }

        // Mute and fullscreen controls must not undo an intentional pause.
        guard let pausedFrame = frame(host: "chzzk.naver.com", pathPrefix: "/video/\(ids[0])"),
              let runningFrame = frame(host: "chzzk.naver.com", pathPrefix: "/video/\(ids[1])") else {
            fail("manual pause check could not find navigated VOD frames"); return
        }
        _ = try? await query("document.querySelectorAll('video').forEach(video => video.pause()); return true;", in: pausedFrame)
        let runningBefore = try? await query(chzzkProbe, in: runningFrame)
        await toggleAudio(ids[0])
        await toggleAudio(ids[0])
        _ = try? await query("window.dispatchEvent(new Event('resize')); return true;", in: pausedFrame)
        await sleep(3)
        let stayedPaused = try? await query("return [...document.querySelectorAll('video')].every(video => video.paused);", in: pausedFrame)
        let runningAfter = try? await query(chzzkProbe, in: runningFrame)
        let otherProgress = ChzzkPlaybackEvidence.progress(from: runningBefore, to: runningAfter, requireAudio: true)
        report["vodManualPausePreserved"] = ["stayedPaused": stayedPaused as? Bool == true, "otherAdvanced": otherProgress != nil]
        if stayedPaused as? Bool != true || otherProgress == nil {
            fail("audio/layout changes resumed a paused VOD or interrupted the other one"); return
        }
        pass("manual pause survives audio/layout changes while the other VOD remains audible")
        report["vodPlaybackVerified"] = true
    }

    private func finish() -> [String: Any] {
        if webViewErrors.contains(where: { $0.contains("terminated") }) && !failures.contains("web content process terminated during the run") {
            fail("web content process terminated during the run")
        }
        report["webViewErrors"] = webViewErrors
        report["inconclusive"] = inconclusive
        report["failures"] = failures
        report["passed"] = failures.isEmpty
        return report
    }
}
