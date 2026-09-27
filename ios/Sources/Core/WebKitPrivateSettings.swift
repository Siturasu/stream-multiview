import Foundation
import WebKit

/// Private WebKit switch that lets cookies from a top-level login (Naver,
/// Google) reach the third-party chzzk/YouTube frames inside the viewer.
///
/// WebKit's tracking prevention blocks third-party cookies, so a chzzk iframe
/// under the viewer origin would play as a logged-out visitor even after
/// signing in to Naver in the app. Chrome extensions never hit this because
/// the extension page shares the browser profile. The switch is SPI; it is
/// looked up at runtime and the outcome is reported so the harness can
/// measure what applied. This is a personal sideloaded app; App Review rules
/// do not apply.
///
/// Not used: `WKWebViewConfiguration._setShouldRelaxThirdPartyCookieBlocking:`
/// (what WebKit applies to its own extension pages). Outside Safari it raises
/// NSInternalInconsistencyException, which the harness surfaced as a silent
/// hang; it would crash the app at launch.
enum WebKitPrivateSettings {
    struct Options: OptionSet {
        let rawValue: Int
        /// WKWebsiteDataStore._resourceLoadStatisticsEnabled = NO
        static let disableTrackingPrevention = Options(rawValue: 1 << 0)
        static let all: Options = [.disableTrackingPrevention]
    }

    struct Report {
        var trackingPreventionDisabled = false

        var dictionary: [String: Bool] {
            ["trackingPreventionDisabled": trackingPreventionDisabled]
        }
    }

    /// Must run after `configuration.websiteDataStore` is set.
    @discardableResult
    static func apply(to configuration: WKWebViewConfiguration, options: Options = .all) -> Report {
        var report = Report()
        if options.contains(.disableTrackingPrevention) {
            report.trackingPreventionDisabled = setBool(
                configuration.websiteDataStore, selector: "_setResourceLoadStatisticsEnabled:", value: false
            )
        }
        return report
    }

    private static func setBool(_ object: NSObject, selector name: String, value: Bool) -> Bool {
        let selector = NSSelectorFromString(name)
        guard object.responds(to: selector), let implementation = object.method(for: selector) else {
            return false
        }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(implementation, to: Setter.self)(object, selector, value)
        return true
    }
}
