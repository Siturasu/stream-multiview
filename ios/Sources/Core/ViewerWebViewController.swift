import Foundation
import WebKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Owns the WKWebView that hosts the viewer and the two user scripts that
/// replace the extension's content scripts.
///
/// Media policy: inline playback, no user-gesture requirement, picture in
/// picture. The viewer controls each tile's mute state independently; iOS
/// fullscreen uses the existing WebKit surface through a CSS adapter.
@MainActor
final class ViewerWebViewController: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    let bridge: NativeBridge
    /// Which private cookie switches actually applied on this WebKit.
    let privateSettings: WebKitPrivateSettings.Report
    private let assets: WebAssets
    private var pendingViewerLoad = false

    /// Called for every navigation action (harness instrumentation).
    var navigationObserver: ((WKNavigationAction) -> Void)?
    /// Called with a description when a load fails.
    var errorHandler: ((String) -> Void)?

    /// Shared configuration for the viewer and the login web view: same
    /// persistent data store (cookies survive relaunches), same media policy,
    /// same cookie relaxation.
    static func makeConfiguration(
        userContent: WKUserContentController? = nil,
        privateOptions: WebKitPrivateSettings.Options = .all
    ) -> (configuration: WKWebViewConfiguration, privateSettings: WebKitPrivateSettings.Report) {
        let configuration = WKWebViewConfiguration()
        if let userContent { configuration.userContentController = userContent }
        configuration.websiteDataStore = SharedWebSession.dataStore
        configuration.mediaTypesRequiringUserActionForPlayback = []
        #if os(iOS)
        // The app already fills the display. Its CSS adapter keeps video and
        // touch controls on the current WKWebView surface when expanding.
        configuration.preferences.isElementFullscreenEnabled = false
        #else
        configuration.preferences.isElementFullscreenEnabled = true
        #endif
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsPictureInPictureMediaPlayback = true
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        #endif
        let report = WebKitPrivateSettings.apply(to: configuration, options: privateOptions)
        return (configuration, report)
    }

    init(
        assets: WebAssets,
        bridge: NativeBridge,
        privateOptions: WebKitPrivateSettings.Options = .all,
        configure: ((WKUserContentController) -> Void)? = nil
    ) throws {
        self.assets = assets
        self.bridge = bridge

        let userContent = WKUserContentController()
        // Host instrumentation first, so a harness console capture sees errors
        // thrown by the app's own document-start scripts.
        configure?(userContent)
        userContent.addUserScript(WKUserScript(
            source: try assets.fullscreenFrameScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page
        ))
        userContent.addUserScript(WKUserScript(
            source: try assets.chzzkPageScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page
        ))
        userContent.addUserScript(WKUserScript(
            source: try assets.youtubeVolumeFrameScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .page
        ))
        userContent.addUserScript(WKUserScript(
            source: try assets.frameActivityScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: .defaultClient
        ))
        userContent.addScriptMessageHandler(bridge, contentWorld: .page, name: ViewerConfiguration.nativeHandlerName)

        let (configuration, privateSettings) = Self.makeConfiguration(
            userContent: userContent,
            privateOptions: privateOptions
        )
        self.privateSettings = privateSettings

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = ViewerConfiguration.userAgent
        #if DEBUG
        webView.isInspectable = true
        #endif
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if os(iOS)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.backgroundColor = .black
        webView.isOpaque = true
        #endif
    }

    func loadViewer() throws {
        let html = try assets.viewerHTML()
        pendingViewerLoad = true
        webView.loadHTMLString(html, baseURL: ViewerConfiguration.viewerBaseURL)
    }

    /// Reloads only the existing stream iframes after an in-app login. Keeping
    /// the viewer document alive preserves its in-memory tile, chat and audio
    /// state when the user has chosen not to persist the last composition.
    func refreshStreamsAfterLogin() async throws {
        _ = try await webView.evaluateJavaScript("""
        (() => {
          const buttons = document.querySelectorAll('.tile-actions button[data-action="reload"]');
          buttons.forEach((button) => {
            const tile = button.closest('.stream-tile');
            if (tile?.dataset.key?.startsWith('youtube:')) {
              // reloadTile sets a CHZZK handshake badge which YouTube never
              // clears. Keep YouTube's label and existing load/audio handler.
              const frame = tile.querySelector('.stream-frame');
              if (frame) frame.src = frame.src;
            } else {
              button.click();
            }
          });
          const chat = document.querySelector('#chat-frame');
          const chatSource = chat?.getAttribute('src');
          if (chatSource && chatSource !== 'about:blank') chat.src = chatSource;
          return buttons.length;
        })()
        """)
    }

    // MARK: - WKNavigationDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        navigationObserver?(navigationAction)
        let url = navigationAction.request.url

        // target=_blank / window.open: hand the URL to the system browser.
        guard let targetFrame = navigationAction.targetFrame else {
            if let url { openExternally(url) }
            decisionHandler(.cancel)
            return
        }

        // Stream, chat and YouTube frames navigate freely.
        guard targetFrame.isMainFrame else {
            decisionHandler(.allow)
            return
        }

        // The viewer document itself (loadHTMLString reports the base URL).
        // Scoped to the viewer host so a mis-timed flag can never authorize an
        // external URL.
        if pendingViewerLoad, url == nil || url?.host?.lowercased() == ViewerConfiguration.viewerHost {
            pendingViewerLoad = false
            decisionHandler(.allow)
            return
        }

        // Links inside the viewer page (e.g. the brand link) point at the
        // fake origin; reload the composed document instead.
        if url?.host?.lowercased() == ViewerConfiguration.viewerHost {
            decisionHandler(.cancel)
            try? loadViewer()
            return
        }

        if let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            openExternally(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        errorHandler?("provisional navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        errorHandler?("navigation failed: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        errorHandler?("web content process terminated; reloading viewer")
        try? loadViewer()
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { openExternally(url) }
        return nil
    }

    // MARK: - Helpers

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        #if canImport(UIKit)
        UIApplication.shared.open(url)
        #elseif canImport(AppKit)
        NSWorkspace.shared.open(url)
        #endif
    }
}
