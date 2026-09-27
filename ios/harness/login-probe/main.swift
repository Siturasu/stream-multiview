import AppKit
import Foundation
import WebKit

// Throwaway credential-free probe. Never types or stores credentials.
// Prints JSON. Cookie values are never read; only names/attributes.

struct ProbeOptions {
    var webRoot: URL
    var privateOptions: WebKitPrivateSettings.Options = .all
    var skipLoginPages = false
    var onlyLoginPages = false
    var timeout: Double = 300
}

func parse() -> ProbeOptions {
    var args = Array(CommandLine.arguments.dropFirst())
    guard !args.isEmpty else { fputs("usage: sv-login-probe <webRoot> [--private none|all] [--skip-login-pages]\n", stderr); exit(64) }
    var o = ProbeOptions(webRoot: URL(fileURLWithPath: args.removeFirst(), isDirectory: true))
    while !args.isEmpty {
        let f = args.removeFirst()
        switch f {
        case "--private": o.privateOptions = (args.removeFirst() == "none") ? [] : .all
        case "--skip-login-pages": o.skipLoginPages = true
        case "--only-login-pages": o.onlyLoginPages = true
        case "--timeout": o.timeout = Double(args.removeFirst()) ?? o.timeout
        default: fputs("unknown flag \(f)\n", stderr); exit(64)
        }
    }
    return o
}

func noQuery(_ s: String?) -> String {
    guard let s else { return "" }
    guard var c = URLComponents(string: s) else { return s }
    c.query = nil; c.fragment = nil
    return c.string ?? s
}

@MainActor
final class LoadWaiter: NSObject, WKNavigationDelegate, WKUIDelegate {
    var finishes = 0
    var lastError: String?
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { finishes += 1 }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { lastError = e.localizedDescription }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { lastError = e.localizedDescription }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { w.load(URLRequest(url: u)) }
        return nil
    }
}

func sleepFor(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }

@MainActor
func waitIdle(_ w: WKWebView, _ waiter: LoadWaiter, timeout: Double = 45) async {
    let deadline = Date().addingTimeInterval(timeout)
    var stable = 0
    while Date() < deadline {
        await sleepFor(0.8)
        if !w.isLoading && waiter.finishes > 0 { stable += 1 } else { stable = 0 }
        if stable >= 4 { break }
    }
    await sleepFor(1.5)
}

@MainActor
func callJS(_ w: WKWebView, _ src: String, frame: WKFrameInfo? = nil) async -> Any? {
    do {
        return try await w.callAsyncJavaScript(src, arguments: [:], in: frame, contentWorld: .page)
    } catch {
        return ["__error": "\(error.localizedDescription)"]
    }
}

func httpOnly(_ c: HTTPCookie) -> Any {
    if let v = c.properties?[HTTPCookiePropertyKey(rawValue: "HttpOnly")] {
        if let b = v as? Bool { return b }
        let s = String(describing: v).lowercased()
        return s == "true" || s == "1" || s == "yes"
    }
    let sel = NSSelectorFromString("isHTTPOnly")
    if c.responds(to: sel), let imp = c.method(for: sel) {
        typealias Getter = @convention(c) (AnyObject, Selector) -> Bool
        return unsafeBitCast(imp, to: Getter.self)(c, sel)
    }
    return "unknown"
}

@MainActor
func dumpCookies() async -> [[String: Any]] {
    let all = await SharedWebSession.dataStore.httpCookieStore.allCookies()
    return all.filter { c in
        let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
        return d.lowercased() == "naver.com" || d.lowercased().hasSuffix(".naver.com")
    }.sorted { ($0.domain, $0.name) < ($1.domain, $1.name) }
    .map { c in
        var ss = "none(nil)"
        if let p = c.sameSitePolicy {
            if p == .sameSiteLax { ss = "lax" } else if p == .sameSiteStrict { ss = "strict" } else { ss = p.rawValue }
        }
        return [
            "name": c.name, "domain": c.domain, "path": c.path,
            "secure": c.isSecure, "httpOnly": httpOnly(c), "sameSite": ss,
            "session": c.isSessionOnly,
            "expires": c.expiresDate.map { ISO8601DateFormatter().string(from: $0) } ?? "session/none",
        ]
    }
}

let loginPageProbe = #"""
const sels = ["#id","#pw","input[name=id]","input[name=pw]","form#frmNIDLogin",".btn_login","#log\\.login"];
const found = {};
for (const s of sels) { try { found[s] = !!document.querySelector(s); } catch (e) { found[s] = "selector-error"; } }
const text = (document.body && document.body.innerText) || "";
const kw = ["지원하지 않","브라우저","업데이트","보안","차단"];
return {
  href: location.href,
  title: document.title,
  found,
  passwordInputs: document.querySelectorAll('input[type=password]').length,
  forms: document.querySelectorAll('form').length,
  keywordHits: kw.filter((k) => text.includes(k)),
  textLength: text.length,
  cookieNames: document.cookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean),
  readiness: (() => {
    const el = (s) => { try { return document.querySelector(s); } catch (e) { return null; } };
    const len = (s) => { const e = el(s); return e ? String(e.value || '').length : -1; };
    const res = performance.getEntriesByType('resource');
    const host = (n) => { try { const u = new URL(n); return u.host + u.pathname; } catch (e) { return 'bad-url'; } };
    return {
      loginButton: !!(el('#loginBtn_column') || el('#loginBtn_row')),
      sessionKeysLen: len('#session_keys'),
      dynamicKeyLen: len('#dynamicKey'),
      bvsdLen: len('#bvsd'),
      encpwPresent: !!(el('#encpw') || el('#eccpw')),
      isPc: (el('#isPc') || {}).value || null,
      cookieEnabled: navigator.cookieEnabled,
      subtleCrypto: !!(window.crypto && window.crypto.subtle),
      secureContext: isSecureContext,
      socialButtons: ["#log\\.naver", "#log\\.google", "#log\\.apple", "#log\\.line"].filter((s) => !!el(s)),
      resourceCount: res.length,
      emptyResources: res.filter((r) => r.decodedBodySize === 0 && r.transferSize === 0).map((r) => host(r.name)).slice(0, 10),
    };
  })(),
};
"""#

func frameProbe(_ statusURL: String) -> String { #"""
const names = document.cookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean);
let sa = null;
try { sa = await document.hasStorageAccess(); } catch (e) { sa = 'exception:' + (e && e.name); }
const out = {};
try {
  const r = await fetch("__URL__", { method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
  out.httpStatus = r.status;
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  out.code = j && j.code !== undefined ? j.code : null;
  out.loggedInType = j && j.content ? typeof j.content.loggedIn : 'no-content';
  out.loggedIn = j && j.content ? j.content.loggedIn : null;
} catch (e) { out.error = (e && e.name) || 'error'; }
return {
  origin: location.origin, path: location.pathname,
  isTop: window.self === window.top,
  cookieNames: names,
  hasStorageAccess: sa,
  status: out,
};
"""#.replacingOccurrences(of: "__URL__", with: statusURL) }

@MainActor
final class Probe {
    let options: ProbeOptions
    let window: NSWindow
    var report: [String: Any] = [:]

    init(options: ProbeOptions) {
        self.options = options
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1366, height: 1024),
                          styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "sv-login-probe"
        window.orderFrontRegardless()
    }

    func makeLoginView(useAppUA: Bool, pageLog: PageLog) -> (WKWebView, LoadWaiter) {
        let made = LoginWebViewFactory.make()
        // LoginWebViewFactory always disables tracking prevention on the shared
        // (singleton) store. For the ITP-on comparison run, put it back.
        if !options.privateOptions.contains(.disableTrackingPrevention) {
            let store = SharedWebSession.dataStore
            let sel = NSSelectorFromString("_setResourceLoadStatisticsEnabled:")
            if store.responds(to: sel), let imp = store.method(for: sel) {
                typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
                unsafeBitCast(imp, to: Setter.self)(store, sel, true)
            }
        }
        let wv = made.webView
        if !useAppUA { wv.customUserAgent = nil }
        let uc = wv.configuration.userContentController
        uc.addUserScript(WKUserScript(source: consoleCaptureScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        uc.add(pageLog, contentWorld: .page, name: "stellaViewHarness")
        let waiter = LoadWaiter()
        wv.navigationDelegate = waiter
        wv.uiDelegate = waiter
        report["privateSettings.login"] = made.privateSettings.dictionary
        window.contentView = wv
        return (wv, waiter)
    }

    func step12(_ key: String, useAppUA: Bool) async {
        let pageLog = PageLog()
        let (wv, waiter) = makeLoginView(useAppUA: useAppUA, pageLog: pageLog)
        wv.load(URLRequest(url: LoginDestination.chzzk.url))
        await waitIdle(wv, waiter)
        var out: [String: Any] = [:]
        out["userAgent"] = useAppUA ? ViewerConfiguration.userAgent : "(WKWebView default)"
        out["effectiveUA"] = (await callJS(wv, "return navigator.userAgent;") as? String) ?? "?"
        out["finalURL"] = noQuery(wv.url?.absoluteString)
        if let e = waiter.lastError { out["loadError"] = e }
        if let d = await callJS(wv, loginPageProbe) as? [String: Any] {
            var d2 = d
            d2["href"] = noQuery(d["href"] as? String)
            out["page"] = d2
        }
        out["console"] = pageLog.entries.prefix(5).map { e -> String in
            let lvl = e["level"] as? String ?? "?"
            let f = noQuery(e["frame"] as? String)
            let t = (e["text"] as? String ?? "").prefix(160)
            return "[\(lvl)] \(f) :: \(t)"
        }
        out["consoleCount"] = pageLog.entries.count
        report[key] = out
        wv.navigationDelegate = nil
        wv.loadHTMLString("", baseURL: nil)
    }

    func step3() async -> WKWebView {
        let pageLog = PageLog()
        let (wv, waiter) = makeLoginView(useAppUA: true, pageLog: pageLog)
        wv.load(URLRequest(url: URL(string: "https://chzzk.naver.com/")!))
        await waitIdle(wv, waiter)
        var out: [String: Any] = [:]
        out["finalURL"] = noQuery(wv.url?.absoluteString)
        out["title"] = (await callJS(wv, "return document.title;") as? String) ?? "?"
        out["docCookieNames"] = (await callJS(wv, "return document.cookie.split(';').map(s=>s.split('=')[0].trim()).filter(Boolean);"))
        out["storeCookies"] = await dumpCookies()
        out["topLevelStatusFetch"] = await callJS(wv, frameProbe(ViewerConfiguration.chzzkUserStatusURL))
        out["console"] = pageLog.entries.prefix(5).map { e -> String in
            "[\(e["level"] as? String ?? "?")] \(noQuery(e["frame"] as? String)) :: \((e["text"] as? String ?? "").prefix(160))"
        }
        report["step3_topLevelChzzk"] = out
        return wv
    }

    func step45() async {
        let pageLog = PageLog()
        let assets = WebAssets(webRoot: options.webRoot, appFullscreen: false)
        let suite = "dev.siturasu.stream-multiview.login-probe"
        guard let defaults = UserDefaults(suiteName: suite) else { return }
        defaults.removePersistentDomain(forName: suite)
        let bridge = NativeBridge(storage: ChromeStorage(defaults: defaults))
        var frames: [(URL, WKFrameInfo)] = []
        let controller: ViewerWebViewController
        do {
            controller = try ViewerWebViewController(assets: assets, bridge: bridge, privateOptions: options.privateOptions) { uc in
                ViewerScenario.instrument(uc, pageLog: pageLog)
            }
        } catch {
            report["step4_viewerIframe"] = ["error": error.localizedDescription]
            return
        }
        controller.navigationObserver = { action in
            guard let u = action.request.url, let f = action.targetFrame, !f.isMainFrame else { return }
            frames.append((u, f))
        }
        var out: [String: Any] = ["privateSettings": controller.privateSettings.dictionary]
        window.contentView = controller.webView
        do { try controller.loadViewer() } catch {
            out["error"] = "loadViewer: \(error.localizedDescription)"
            report["step4_viewerIframe"] = out
            return
        }
        let wv = controller.webView
        // Wait for member buttons.
        var members = 0
        for _ in 0..<40 {
            await sleepFor(0.7)
            if let n = await callJS(wv, "return document.querySelectorAll('.viewer-member').length;") as? Int, n > 0 { members = n; break }
        }
        out["memberButtons"] = members
        // Wait for LIVE/OFF states to settle (native fetch bridge).
        for _ in 0..<30 {
            await sleepFor(1.0)
            if let ok = await callJS(wv, "const s=[...document.querySelectorAll('.viewer-member-state')].map(e=>e.textContent.trim()); return s.length>0 && s.every(x=>x!=='…');") as? Bool, ok { break }
        }
        let target = await callJS(wv, #"""
        const members = [...document.querySelectorAll('.viewer-member')];
        const st = (b) => (b.querySelector('.viewer-member-state') || {}).textContent?.trim() || '';
        const b = members.find((m) => st(m) === 'LIVE') || members[0];
        if (!b) return null;
        b.click();
        return { live: st(b) === 'LIVE', state: st(b) };
        """#)
        out["chzzkTarget"] = target ?? "none"
        // Wait for the chzzk /live/ or /video/ frame.
        var chzzkFrame: WKFrameInfo?
        var chzzkURL = ""
        for _ in 0..<40 {
            await sleepFor(1.0)
            if let hit = frames.last(where: { $0.0.host?.lowercased() == "chzzk.naver.com" && ($0.0.path.hasPrefix("/live/") || $0.0.path.hasPrefix("/video/")) }) {
                chzzkFrame = hit.1; chzzkURL = noQuery(hit.0.absoluteString); break
            }
        }
        out["chzzkFrameURL"] = chzzkURL.isEmpty ? "none" : chzzkURL
        if let f = chzzkFrame {
            await sleepFor(4)
            out["iframe"] = await callJS(wv, frameProbe(ViewerConfiguration.chzzkUserStatusURL), frame: f)
        }
        out["storeCookiesAfter"] = await dumpCookies()
        out["console"] = pageLog.entries.filter { ($0["level"] as? String) != "log" }.prefix(5).map { e -> String in
            "[\(e["level"] as? String ?? "?")] \(noQuery(e["frame"] as? String)) :: \((e["text"] as? String ?? "").prefix(160))"
        }
        report["step4_viewerIframe"] = out
    }

    func run() async {
        report["run"] = [
            "privateOptionsAll": options.privateOptions.contains(.disableTrackingPrevention),
            "skipLoginPages": options.skipLoginPages,
        ]
        if !options.skipLoginPages {
            await step12("step1_naverLogin_appUA", useAppUA: true)
            await step12("step2_naverLogin_defaultUA", useAppUA: false)
        }
        if !options.onlyLoginPages {
            _ = await step3()
            await step45()
        }
        if let d = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            print(String(decoding: d, as: UTF8.self))
        }
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let opts = parse()
Task { @MainActor in
    let probe = Probe(options: opts)
    Task.detached {
        try? await Task.sleep(nanoseconds: UInt64(opts.timeout * 1_000_000_000))
        fputs("[probe] watchdog expired\n", stderr)
        exit(3)
    }
    await probe.run()
}
app.run()
