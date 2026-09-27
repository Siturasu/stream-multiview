import SwiftUI
import UIKit
import WebKit

/// In-app login. The web view shares the default website data store with the
/// viewer, so cookies from a top-level Naver/Google sign-in are available to
/// the chzzk and YouTube frames afterwards (see WebKitPrivateSettings).
struct LoginScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var destination: LoginDestination = .chzzk
    @State private var loadError: String?
    @State private var chzzkLoginStatus: ChzzkLoginStatus = .waiting
    @State private var compatibilityWarning: String?
    @State private var finishing = false
    @State private var statusCheckCount = 0
    @State private var chzzkProbe: ChzzkLoginProbe?
    @State private var privateSettings: WebKitPrivateSettings.Report?
    @State private var cookieSummary: LoginDiagnostics.CookieSummary?
    @State private var diagnosticsExpanded = false
    @State private var diagnosticsCopied = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Which build is installed is the first thing a device report
                // needs, so it shows even before a site is picked.
                Text(LoginDiagnostics.versionLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)

                // A segmented picker inside a toolbar collapses to a stub on
                // iPadOS 26, so it lives above the web view instead.
                Picker("사이트", selection: $destination) {
                    ForEach(LoginDestination.allCases, id: \.self) { item in
                        Text(item.title).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)

                if let loadError {
                    Text(loadError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 6)
                }

                if destination == .chzzk {
                    HStack(spacing: 12) {
                        Text(chzzkLoginStatus.message)
                            .font(.footnote)
                            .foregroundStyle(chzzkLoginStatus == .signedIn ? Color.green : Color.secondary)
                        Spacer(minLength: 0)
                        Button("다시 확인") { statusCheckCount += 1 }
                            .disabled(chzzkLoginStatus == .checking)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)

                    if chzzkLoginStatus == .signedIn, cookieSummary?.loginCookiesAreSessionOnly == true {
                        Text("로그인이 앱을 종료하면 사라지는 세션 상태입니다. 네이버 로그인 화면에서 '로그인 상태 유지'를 켜고 다시 로그인하면 앱을 다시 켜도 유지됩니다.")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 6)
                    }

                    diagnosticsSection
                }

                if let compatibilityWarning {
                    Text(compatibilityWarning)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 6)
                }

                LoginWebView(
                    destination: destination,
                    statusCheckCount: statusCheckCount,
                    loadError: $loadError,
                    chzzkLoginStatus: $chzzkLoginStatus,
                    chzzkProbe: $chzzkProbe,
                    privateSettings: $privateSettings,
                    compatibilityWarning: $compatibilityWarning
                )
                    .ignoresSafeArea(edges: .bottom)
            }
            .task { cookieSummary = await LoginDiagnostics.readCookies() }
            .navigationTitle("계정 로그인")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(finishing ? "처리 중…" : "완료") {
                        finishing = true
                        Task { @MainActor in
                            await SharedWebSession.synchronizeCookies()
                            dismiss()
                        }
                    }
                    .disabled(finishing)
                }
            }
        }
    }

    /// Collapsed by default. Everything here is attribute-level: no cookie
    /// value, no account identifier, no URL beyond a host name.
    @ViewBuilder
    private var diagnosticsSection: some View {
        DisclosureGroup("진단", isExpanded: $diagnosticsExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(diagnosticsLines.enumerated()), id: \.offset) { _, line in
                            Text(line)
                                .font(.caption2)
                                .monospaced()
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .frame(maxHeight: 180)

                HStack(spacing: 16) {
                    Button(diagnosticsCopied ? "복사됨" : "진단 복사") { copyDiagnostics() }
                    Button("진단 새로고침") { refreshDiagnostics() }
                    Spacer(minLength: 0)
                }
                .font(.footnote)
            }
            .padding(.top, 4)
        }
        .font(.footnote)
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    private var diagnosticsSnapshot: LoginDiagnostics.Snapshot {
        LoginDiagnostics.Snapshot(
            system: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            idiom: Self.idiomName(UIDevice.current.userInterfaceIdiom),
            privateSettings: privateSettings,
            probe: chzzkProbe,
            cookies: cookieSummary
        )
    }

    private var diagnosticsLines: [String] {
        LoginDiagnostics.lines(for: diagnosticsSnapshot)
    }

    private func copyDiagnostics() {
        UIPasteboard.general.string = LoginDiagnostics.reportText(for: diagnosticsSnapshot)
        diagnosticsCopied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            diagnosticsCopied = false
        }
    }

    /// Same counter the "다시 확인" button uses, plus a fresh cookie read.
    private func refreshDiagnostics() {
        statusCheckCount += 1
        Task { @MainActor in
            cookieSummary = await LoginDiagnostics.readCookies()
        }
    }

    private static func idiomName(_ idiom: UIUserInterfaceIdiom) -> String {
        switch idiom {
        case .pad: return "pad"
        case .phone: return "phone"
        case .mac: return "mac"
        case .tv: return "tv"
        case .carPlay: return "carPlay"
        default: return "unspecified"
        }
    }
}

struct LoginWebView: UIViewRepresentable {
    let destination: LoginDestination
    let statusCheckCount: Int
    @Binding var loadError: String?
    @Binding var chzzkLoginStatus: ChzzkLoginStatus
    @Binding var chzzkProbe: ChzzkLoginProbe?
    @Binding var privateSettings: WebKitPrivateSettings.Report?
    @Binding var compatibilityWarning: String?

    /// Keeps popup navigations (target=_blank, window.open) inside the same
    /// web view. Without a UI delegate WebKit silently drops them, and Naver's
    /// find-id / sign-up links and some Google steps use them.
    final class Coordinator: NSObject, WKUIDelegate, WKNavigationDelegate {
        var loaded: LoginDestination?
        var onError: ((String?) -> Void)?
        var onChzzkLoginStatus: ((ChzzkLoginStatus) -> Void)?
        var onChzzkLoginProbe: ((ChzzkLoginProbe) -> Void)?
        var appliedStatusCheckCount = 0
        private var statusCheckTask: Task<Void, Never>?
        private var statusCheckGeneration = 0

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil, navigationAction.request.url != nil {
                webView.load(navigationAction.request)
            }
            return nil
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            onError?(nil)
            invalidateStatusCheck()
            onChzzkLoginStatus?(.waiting)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            checkLogin(in: webView)
        }

        func invalidateStatusCheck() {
            statusCheckGeneration += 1
            statusCheckTask?.cancel()
            statusCheckTask = nil
        }

        func checkLogin(in webView: WKWebView) {
            invalidateStatusCheck()
            guard loaded == .chzzk else {
                onChzzkLoginStatus?(.waiting)
                return
            }
            let pageHost = webView.url?.host?.lowercased()
            guard pageHost == "chzzk.naver.com" else {
                // Recorded too: "still on the Naver login page" is itself the
                // answer when a user reports that nothing happens.
                onChzzkLoginStatus?(.waiting)
                onChzzkLoginProbe?(ChzzkLoginProbe(status: .waiting, failure: "not-on-chzzk", pageHost: pageHost))
                return
            }
            let generation = statusCheckGeneration
            let inspectedURL = webView.url
            onChzzkLoginStatus?(.checking)
            statusCheckTask = Task { @MainActor [weak self, weak webView] in
                guard let self, let webView else { return }
                let probe = await LoginWebViewFactory.probeChzzkLogin(in: webView)
                guard !Task.isCancelled, self.statusCheckGeneration == generation,
                      self.loaded == .chzzk, webView.url == inspectedURL else { return }
                self.onChzzkLoginProbe?(probe)
                self.onChzzkLoginStatus?(probe.status)
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            reportLoadError(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            reportLoadError(error)
        }

        private func reportLoadError(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            onError?("페이지를 불러오지 못했습니다: \(error.localizedDescription)")
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let result = LoginWebViewFactory.make()
        let webView = result.webView
        webView.uiDelegate = context.coordinator
        webView.navigationDelegate = context.coordinator
        context.coordinator.onError = { message in
            DispatchQueue.main.async { loadError = message }
        }
        context.coordinator.onChzzkLoginStatus = { status in
            DispatchQueue.main.async { chzzkLoginStatus = status }
        }
        context.coordinator.onChzzkLoginProbe = { probe in
            DispatchQueue.main.async { chzzkProbe = probe }
        }
        context.coordinator.appliedStatusCheckCount = statusCheckCount
        DispatchQueue.main.async {
            privateSettings = result.privateSettings
            compatibilityWarning = result.privateSettings.trackingPreventionDisabled
                ? nil
                : "현재 환경에서는 방송 로그인 연결이 제한될 수 있습니다."
        }
        load(destination, in: webView, coordinator: context.coordinator)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.loaded != destination {
            load(destination, in: webView, coordinator: context.coordinator)
        } else if context.coordinator.appliedStatusCheckCount != statusCheckCount {
            context.coordinator.appliedStatusCheckCount = statusCheckCount
            context.coordinator.checkLogin(in: webView)
        }
    }

    private func load(_ destination: LoginDestination, in webView: WKWebView, coordinator: Coordinator) {
        coordinator.loaded = destination
        coordinator.invalidateStatusCheck()
        coordinator.onChzzkLoginStatus?(.waiting)
        webView.load(URLRequest(url: destination.url))
    }
}
