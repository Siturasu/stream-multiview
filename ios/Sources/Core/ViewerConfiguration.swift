import Foundation

/// Fixed identity of the wrapped viewer page.
///
/// The viewer document is loaded with `loadHTMLString(_:baseURL:)` under the
/// CHZZK origin itself. Two reasons:
/// 1. Naver's login cookies (NID_AUT, NID_SES) arrive with SameSite=Lax on the
///    real iPad. Lax cookies are never sent to a cross-site iframe, whatever the
///    tracking-prevention or Storage Access state, so a viewer on any other
///    origin (the earlier `stream-multiview.invalid`) left every chzzk tile
///    logged out even after a successful in-app login. With the viewer on
///    chzzk.naver.com the tiles are same-site and the cookies flow.
/// 2. WebKit only emits an HTTP Referer from http(s) documents, and YouTube
///    refuses embeds without one (error 153); this origin satisfies that too.
/// The main frame never actually navigates to chzzk.naver.com: the navigation
/// delegate intercepts every main-frame navigation, so the document is always
/// the composed viewer.
enum ViewerConfiguration {
    static let viewerHost = "chzzk.naver.com"
    static let viewerOrigin = "https://\(viewerHost)"
    static let viewerBaseURL = URL(string: "\(viewerOrigin)/")!

    /// Name of `window.webkit.messageHandlers.<name>` used by chrome-shim.js.
    static let nativeHandlerName = "stellaViewNative"

    /// Desktop Safari identity. CHZZK redirects any UA containing "mobile" to
    /// m.chzzk.naver.com, whose player starts at 360p and lacks the quality
    /// preference key the content script relies on. The UA set on the main
    /// frame applies to every subframe.
    static let userAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15"

    /// Hosts the page may fetch through the native bridge. The viewer origin
    /// is not on api.chzzk.naver.com's CORS allowlist, and YouTube channel
    /// HTML is cross-origin, so those requests go through URLSession, which
    /// sends no Origin header.
    static let nativeFetchHosts: Set<String> = ["api.chzzk.naver.com", "www.youtube.com"]

    // CHZZK's NNG user client uses the game common API, not its live API host.
    // Both the first-party login check and embedded-session check use this URL.
    static let chzzkUserStatusURL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus"

    static let requestTimeout: TimeInterval = 12
    static let maxResponseBytes = 4_000_000
}
