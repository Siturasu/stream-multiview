import AppKit
import Foundation
import WebKit

// macOS harness for the iPad wrapper.
//
// Loads the composed viewer in a real WKWebView (the same WebKit generation
// that ships with iPadOS 26.x on this machine's macOS 26.x), runs the shared
// ViewerScenario and prints its JSON report to stdout. Exit code 0 means
// every check passed (inconclusive checks are listed, not failed).
//
//   harness <webRoot> [--youtube VIDEO_ID|none] [--channel CHANNEL_ID] [--timeout SEC] [--keep] [--private none|all]

struct Options {
    var webRoot: URL
    var scenario = ScenarioOptions()
    var keepOpen = false
    var appFullscreen = false
    var privateOptions: WebKitPrivateSettings.Options = .all
}

func parseOptions() -> Options {
    var arguments = Array(CommandLine.arguments.dropFirst())
    func next(_ flag: String) -> String {
        guard !arguments.isEmpty else {
            fputs("\(flag) needs a value\n", stderr)
            exit(64)
        }
        return arguments.removeFirst()
    }
    guard !arguments.isEmpty else {
        fputs("usage: harness <webRoot> [--youtube VIDEO_ID|none] [--channel CHANNEL_ID] [--timeout SEC] [--keep] [--private none|all]\n", stderr)
        exit(64)
    }
    var options = Options(webRoot: URL(fileURLWithPath: arguments.removeFirst(), isDirectory: true))
    while !arguments.isEmpty {
        let flag = arguments.removeFirst()
        switch flag {
        case "--youtube":
            let value = next(flag)
            options.scenario.youtube = value == "none" ? nil : value
        case "--channel":
            options.scenario.channel = next(flag)
        case "--videos":
            options.scenario.chzzkVideos = next(flag).split(separator: ",").map(String.init)
        case "--timeout":
            options.scenario.timeout = Double(next(flag)) ?? options.scenario.timeout
        case "--keep":
            options.keepOpen = true
        case "--app-fullscreen":
            options.appFullscreen = true
        case "--private":
            options.privateOptions = next(flag) == "none" ? [] : .all
        default:
            fputs("unknown flag \(flag)\n", stderr)
            exit(64)
        }
    }
    return options
}

@MainActor
final class Harness {
    let scenario: ViewerScenario
    let window: NSWindow
    let keepOpen: Bool

    init(options: Options) throws {
        keepOpen = options.keepOpen
        let pageLog = PageLog()
        let assets = WebAssets(webRoot: options.webRoot, appFullscreen: options.appFullscreen)
        // Fresh chrome.storage every run: a remembered session from the
        // previous run would restore tiles before the scenario starts.
        let suite = "dev.siturasu.stream-multiview.harness"
        guard let defaults = UserDefaults(suiteName: suite) else {
            throw NSError(domain: "harness", code: 1, userInfo: [NSLocalizedDescriptionKey: "UserDefaults suite unavailable"])
        }
        defaults.removePersistentDomain(forName: suite)
        let bridge = NativeBridge(storage: ChromeStorage(defaults: defaults))
        let controller = try ViewerWebViewController(assets: assets, bridge: bridge, privateOptions: options.privateOptions) { userContent in
            ViewerScenario.instrument(userContent, pageLog: pageLog)
        }
        scenario = ViewerScenario(controller: controller, pageLog: pageLog, options: options.scenario)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1366, height: 1024),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Stream Multiview harness"
        window.contentView = controller.webView
        window.center()
        window.orderFrontRegardless()
        self.window = window
    }

    func run() async {
        let report = await scenario.run()
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            print(String(decoding: data, as: UTF8.self))
        }
        let passed = (report["passed"] as? Bool) ?? false
        if keepOpen {
            fputs("[harness] --keep: window stays open; press Ctrl-C to exit\n", stderr)
            return
        }
        exit(passed ? 0 : 1)
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let options = parseOptions()
var harness: Harness?
var watchdog: Task<Void, Never>?

Task { @MainActor in
    do {
        fputs("[harness] init\n", stderr)
        let instance = try Harness(options: options)
        harness = instance
        fputs("[harness] init done\n", stderr)
        if !options.keepOpen {
            // A hung WebKit call (or a swallowed ObjC exception) must not block
            // the caller forever.
            watchdog = Task.detached {
                try? await Task.sleep(nanoseconds: UInt64(options.scenario.timeout * 6 * 1_000_000_000))
                fputs("[harness] watchdog expired\n", stderr)
                exit(3)
            }
        }
        await instance.run()
        watchdog?.cancel()
    } catch {
        fputs("harness init failed: \(error.localizedDescription)\n", stderr)
        exit(2)
    }
}

application.run()
