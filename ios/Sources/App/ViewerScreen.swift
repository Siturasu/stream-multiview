import SwiftUI
import UIKit
import WebKit

/// Full-screen viewer. The status bar and home indicator stay hidden while
/// watching, and the idle timer is off so the screen never sleeps mid-stream.
/// The "계정" button in the viewer's top bar opens the login screen; when it
/// closes, stream/chat frames refresh so they pick up the new cookies.
struct ViewerScreen: View {
    @State private var showLogin = false
    @State private var reloadCount = 0

    var body: some View {
        ViewerWebView(reloadCount: reloadCount, onOpenLogin: { showLogin = true })
            .ignoresSafeArea()
            .background(Color.black)
            .statusBarHidden(true)
            .persistentSystemOverlays(.hidden)
            .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
            .fullScreenCover(isPresented: $showLogin, onDismiss: { reloadCount += 1 }) {
                LoginScreen()
            }
    }
}

/// Harness mode: launched with `-svHarness` (or SV_HARNESS=1) the app runs the
/// shared ViewerScenario on iPadOS WebKit and writes the JSON report to
/// Documents/sv-harness-report.json (read it with `xcrun simctl
/// get_app_container booted <bundle id> data`). Options come from the
/// environment: SV_YOUTUBE (video id or "none"), SV_CIME (channel slug or
/// "none"), SV_CHANNEL, SV_TIMEOUT.
enum HarnessMode {
    static var isEnabled: Bool {
        let process = ProcessInfo.processInfo
        return process.arguments.contains("-svHarness") || process.environment["SV_HARNESS"] == "1"
    }

    static var options: ScenarioOptions {
        let environment = ProcessInfo.processInfo.environment
        var options = ScenarioOptions()
        if let youtube = environment["SV_YOUTUBE"] { options.youtube = youtube == "none" ? nil : youtube }
        if let cime = environment["SV_CIME"] { options.cime = cime == "none" ? nil : cime }
        if let channel = environment["SV_CHANNEL"], !channel.isEmpty { options.channel = channel }
        if let videos = environment["SV_VIDEOS"] { options.chzzkVideos = videos.split(separator: ",").map(String.init) }
        if let timeout = environment["SV_TIMEOUT"].flatMap(Double.init) { options.timeout = timeout }
        return options
    }

    static var reportURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("sv-harness-report.json")
    }
}

struct ViewerWebView: UIViewRepresentable {
    let reloadCount: Int
    let onOpenLogin: () -> Void

    final class Coordinator {
        var controller: ViewerWebViewController?
        var scenario: ViewerScenario?
        var appliedReloadCount = 0
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        context.coordinator.appliedReloadCount = reloadCount

        do {
            let assets = WebAssets(webRoot: Bundle.main.resourceURL ?? Bundle.main.bundleURL)
            if HarnessMode.isEnabled {
                let controller = try makeHarnessController(assets: assets, coordinator: context.coordinator)
                pin(controller.webView, to: container)
            } else {
                let bridge = NativeBridge()
                bridge.openLoginHandler = onOpenLogin
                let controller = try ViewerWebViewController(assets: assets, bridge: bridge)
                controller.errorHandler = { message in
                    NSLog("[StreamMultiview] %@", message)
                }
                NSLog("[StreamMultiview] private settings: %@", controller.privateSettings.dictionary.description)
                context.coordinator.controller = controller
                pin(controller.webView, to: container)
                try controller.loadViewer()
            }
        } catch {
            let label = UILabel()
            label.numberOfLines = 0
            label.textAlignment = .center
            label.textColor = .white
            label.font = .preferredFont(forTextStyle: .body)
            label.text = "뷰어를 불러오지 못했습니다.\n\(error.localizedDescription)"
            pin(label, to: container, inset: 32)
        }
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        guard context.coordinator.appliedReloadCount != reloadCount else { return }
        context.coordinator.appliedReloadCount = reloadCount
        guard let controller = context.coordinator.controller else { return }
        Task { @MainActor in
            do {
                try await controller.refreshStreamsAfterLogin()
            } catch {
                controller.errorHandler?("stream refresh after login failed: \(error.localizedDescription)")
            }
        }
    }

    @MainActor
    private func makeHarnessController(assets: WebAssets, coordinator: Coordinator) throws -> ViewerWebViewController {
        let pageLog = PageLog()
        let suite = "dev.siturasu.stream-multiview.harness"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        let bridge = NativeBridge(storage: ChromeStorage(defaults: defaults))
        let controller = try ViewerWebViewController(assets: assets, bridge: bridge) { userContent in
            ViewerScenario.instrument(userContent, pageLog: pageLog)
        }
        let scenario = ViewerScenario(controller: controller, pageLog: pageLog, options: HarnessMode.options)
        scenario.log = { line in NSLog("[svHarness] %@", line) }
        coordinator.controller = controller
        coordinator.scenario = scenario
        try? FileManager.default.removeItem(at: HarnessMode.reportURL)
        Task { @MainActor in
            let report = await scenario.run()
            let data = (try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data()
            try? data.write(to: HarnessMode.reportURL)
            NSLog("[svHarness] REPORT %@", String(decoding: data, as: UTF8.self))
            NSLog("[svHarness] DONE passed=%@", ((report["passed"] as? Bool) ?? false) ? "true" : "false")
        }
        return controller
    }

    private func pin(_ view: UIView, to container: UIView, inset: CGFloat = 0) {
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: inset),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -inset),
            view.topAnchor.constraint(equalTo: container.topAnchor, constant: inset),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -inset),
        ])
    }
}
