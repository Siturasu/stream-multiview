import Foundation

/// Reads the shared web assets from a web root and composes the documents
/// and user scripts the wrapper needs.
///
/// Layout under `webRoot` (identical in the app bundle and in the harness
/// staging directory):
///
///     viewer.html  viewer.css  viewer.js  background.js
///     src/shared/*.js
///     content/chzzk-main.js  content/frame-activity.js  content/chzzk-embed.css
///     content/youtube-volume-frame.js
///     ios-web/chrome-shim.js  ios-web/ios-overrides.css
///
/// ES modules are inlined by rewriting every relative `from "./x.js"` import
/// to a `data:` URL that embeds the imported module. The viewer document is a
/// single HTML string, so relative subresource URLs cannot be used (they
/// would resolve against the fake https base URL).
struct WebAssets {
    enum AssetError: LocalizedError {
        case missing(String)
        case outsideRoot(String)
        case markerNotFound(String)
        case importCycle(String)

        var errorDescription: String? {
            switch self {
            case .missing(let path): return "웹 자산이 없습니다: \(path)"
            case .outsideRoot(let path): return "웹 루트 밖의 경로입니다: \(path)"
            case .markerNotFound(let marker): return "viewer.html에서 교체 지점을 찾지 못했습니다: \(marker)"
            case .importCycle(let path): return "모듈 import가 순환합니다: \(path)"
            }
        }
    }

    let webRoot: URL
    let appFullscreen: Bool

    #if os(iOS)
    static let defaultAppFullscreen = true
    #else
    static let defaultAppFullscreen = false
    #endif

    init(webRoot: URL, appFullscreen: Bool = WebAssets.defaultAppFullscreen) {
        self.webRoot = webRoot.standardizedFileURL
        self.appFullscreen = appFullscreen
    }

    // MARK: - Files

    func fileURL(_ relativePath: String) throws -> URL {
        let url = URL(fileURLWithPath: relativePath, isDirectory: false, relativeTo: webRoot).standardizedFileURL
        guard url.path.hasPrefix(webRoot.path) else { throw AssetError.outsideRoot(relativePath) }
        guard FileManager.default.fileExists(atPath: url.path) else { throw AssetError.missing(relativePath) }
        return url
    }

    func text(_ relativePath: String) throws -> String {
        try String(contentsOf: try fileURL(relativePath), encoding: .utf8)
    }

    // MARK: - ES module inlining

    private static let importPattern = try! NSRegularExpression(
        pattern: #"\bfrom\s*(["'])(\.\.?/[^"']+)\1"#
    )

    /// Returns the module source with relative imports replaced by `data:`
    /// URLs of the (recursively inlined) imported modules.
    func inlineModule(_ relativePath: String) throws -> String {
        var cache: [String: String] = [:]
        var visiting: Set<String> = []
        return try inlineModule(at: try fileURL(relativePath), cache: &cache, visiting: &visiting)
    }

    private func inlineModule(at url: URL, cache: inout [String: String], visiting: inout Set<String>) throws -> String {
        guard !visiting.contains(url.path) else { throw AssetError.importCycle(url.lastPathComponent) }
        visiting.insert(url.path)
        defer { visiting.remove(url.path) }

        let source = try String(contentsOf: url, encoding: .utf8)
        let directory = url.deletingLastPathComponent()
        let nsSource = source as NSString
        var output = ""
        var cursor = 0

        for match in Self.importPattern.matches(in: source, range: NSRange(location: 0, length: nsSource.length)) {
            let specifierRange = match.range(at: 2)
            let specifier = nsSource.substring(with: specifierRange)
            let target = URL(fileURLWithPath: specifier, isDirectory: false, relativeTo: directory).standardizedFileURL
            guard target.path.hasPrefix(webRoot.path) else { throw AssetError.outsideRoot(specifier) }
            guard FileManager.default.fileExists(atPath: target.path) else { throw AssetError.missing(specifier) }

            let dataURL: String
            if let cached = cache[target.path] {
                dataURL = cached
            } else {
                let inlined = try inlineModule(at: target, cache: &cache, visiting: &visiting)
                dataURL = "data:text/javascript;base64," + Data(inlined.utf8).base64EncodedString()
                cache[target.path] = dataURL
            }

            output += nsSource.substring(with: NSRange(location: cursor, length: specifierRange.location - cursor))
            output += dataURL
            cursor = specifierRange.location + specifierRange.length
        }
        output += nsSource.substring(from: cursor)
        return output
    }

    // MARK: - Composed documents

    /// viewer.html with the stylesheet, the chrome API shim and viewer.js
    /// inlined, ready for `loadHTMLString(_:baseURL:)`.
    func viewerHTML() throws -> String {
        var html = try text("viewer.html")

        let css = try text("viewer.css") + "\n" + (try text("ios-web/ios-overrides.css"))
        try replace(
            in: &html,
            marker: #"<link rel="stylesheet" href="viewer.css">"#,
            with: "<style>\n\(css)\n</style>"
        )
        try replace(
            in: &html,
            marker: #"<meta name="viewport" content="width=device-width, initial-scale=1">"#,
            with: #"<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">"#
        )

        let shim = try inlineModule("ios-web/chrome-shim.js")
        let viewer = try inlineModule("viewer.js")
        try replace(
            in: &html,
            marker: #"<script type="module" src="viewer.js"></script>"#,
            with: "<script>\(fullscreenBootstrap)</script>\n<script type=\"module\">\n\(shim)\n</script>\n<script type=\"module\">\n\(viewer)\n</script>"
        )
        return html
    }

    /// Page-world script for every frame. Inside chzzk.naver.com frames it
    /// announces the viewer origin, injects the embed stylesheet and runs the
    /// extension's MAIN-world content script. Other frames are left alone.
    func chzzkPageScript() throws -> String {
        let main = try text("content/chzzk-main.js")
        let sessionAccess = try text("ios-web/session-access-frame.js")
        let css = try text("content/chzzk-embed.css")
        return """
        (() => {
          // The viewer document shares this hostname (same-site origin for
          // cookies); only real CHZZK subframes get the content script.
          if (location.hostname !== "chzzk.naver.com" || window.self === window.top) return;
          globalThis.__stellaViewViewerOrigin = \(Self.jsString(ViewerConfiguration.viewerOrigin));
          globalThis.__stellaViewChzzkStatusURL = \(Self.jsString(ViewerConfiguration.chzzkUserStatusURL));
          // The app owns these frames even after CHZZK navigates from a live
          // channel to a recording without preserving our query parameters.
          // Login views use a different user-content controller and never run
          // this script. Chat and top-level CHZZK documents stay untouched.
          globalThis.__stellaViewManagedFrame = window.self !== window.top &&
            /^\\/(?:live|video)\\//.test(location.pathname) && !/\\/chat\\/?$/.test(location.pathname);
          try {
            const style = document.createElement("style");
            style.id = "sv-embed-style";
            style.textContent = \(Self.jsString(css));
            (document.head || document.documentElement).append(style);
          } catch {}
        \(main)
        \(sessionAccess)
        })();
        """
    }

    /// Page-world script for YouTube embed frames (iPad wrapper only): applies
    /// the viewer's per-tile volume to the player's <video>, since the IFrame
    /// API volume commands are not reliable on iPadOS.
    func youtubeVolumeFrameScript() throws -> String {
        let script = try text("content/youtube-volume-frame.js")
        return """
        (() => {
          if (location.hostname !== "www.youtube.com" || window.self === window.top) return;
          globalThis.__stellaViewViewerOrigin = \(Self.jsString(ViewerConfiguration.viewerOrigin));
        \(script)
        })();
        """
    }

    /// Isolated-world script (extension: frame-activity.js). It only needs
    /// `chrome.runtime.getURL` to learn the viewer origin.
    func frameActivityScript() throws -> String {
        let script = try text("content/frame-activity.js")
        let base = Self.jsString(ViewerConfiguration.viewerOrigin + "/")
        return """
        (function (chrome) {
        \(script)
        })({ runtime: { getURL: (path) => new URL(path, \(base)).href } });
        """
    }

    private var fullscreenBootstrap: String {
        "globalThis.__stellaViewIOSFullscreenAdapter = \(appFullscreen ? "true" : "false");" +
        "globalThis.__stellaViewFullscreenParentOrigin = \(Self.jsString(ViewerConfiguration.viewerOrigin));"
    }

    func fullscreenFrameScript() throws -> String {
        guard appFullscreen else { return "" }
        return fullscreenBootstrap + "\n" + (try text("ios-web/fullscreen-frame.js"))
    }

    // MARK: - Helpers

    private func replace(in html: inout String, marker: String, with replacement: String) throws {
        guard let range = html.range(of: marker) else { throw AssetError.markerNotFound(marker) }
        html.replaceSubrange(range, with: replacement)
    }

    /// JSON encoding doubles as a JS string literal.
    static func jsString(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}
