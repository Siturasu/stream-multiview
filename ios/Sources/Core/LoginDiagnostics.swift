import Foundation
import WebKit

/// Privacy-safe diagnostics for the in-app login screen.
///
/// On a real iPad we cannot tell which build is installed or which login stage
/// failed. This collects exactly that: bundle version, whether the tracking
/// prevention switch applied, what the CHZZK status probe answered, and which
/// session cookies exist in the shared data store.
///
/// Cookie values, account identifiers, response bodies, headers and URL query
/// strings are never read here. Only names, hosts, cookie attributes and status
/// codes, so the whole report can be pasted into a chat.
enum LoginDiagnostics {
    /// Naver's session pair. Their absence is the clearest sign that a
    /// top-level sign-in never reached this data store.
    static let loginCookieNames: Set<String> = ["NID_AUT", "NID_SES"]

    /// "Stream Multiview 0.1.2 (3)" for the installed bundle.
    static var versionLine: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "Stream Multiview \(short) (\(build))"
    }

    // MARK: - Cookies

    struct CookieRow: Equatable, Identifiable {
        var name: String
        var domain: String
        var path: String
        var isSecure: Bool
        var isHTTPOnly: Bool
        /// "none" / "lax" / "strict", or "unset" when the cookie has no policy.
        var sameSite: String
        /// "session" or an ISO 8601 instant.
        var expires: String
        var isLoginCookie: Bool

        var id: String { "\(name)|\(domain)|\(path)" }
    }

    struct CookieSummary: Equatable {
        var rows: [CookieRow] = []
        /// Counted only. Listing Google cookie names adds nothing here.
        var googleCookieCount = 0
        var readAt = Date()

        /// NID_AUT/NID_SES present but without an expiry: WebKit drops them
        /// when the app terminates. Naver's "로그인 상태 유지" makes them persistent.
        var loginCookiesAreSessionOnly: Bool {
            let login = rows.filter(\.isLoginCookie)
            return !login.isEmpty && login.allSatisfy { $0.expires == "session" }
        }
    }

    @MainActor
    static func readCookies(now: Date = Date()) async -> CookieSummary {
        summarize(await SharedWebSession.dataStore.httpCookieStore.allCookies(), now: now)
    }

    /// Split from `readCookies` so the shape can be exercised without WebKit.
    static func summarize(_ cookies: [HTTPCookie], now: Date = Date()) -> CookieSummary {
        var summary = CookieSummary(readAt: now)
        for cookie in cookies {
            let domain = cookie.domain.lowercased()
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            if covers(bare, "naver.com") {
                summary.rows.append(
                    CookieRow(
                        name: cookie.name,
                        domain: cookie.domain,
                        path: cookie.path,
                        isSecure: cookie.isSecure,
                        isHTTPOnly: cookie.isHTTPOnly,
                        sameSite: sameSiteLabel(cookie),
                        expires: expiryLabel(cookie),
                        isLoginCookie: loginCookieNames.contains(cookie.name)
                    )
                )
            } else if covers(bare, "google.com") || covers(bare, "youtube.com") {
                summary.googleCookieCount += 1
            }
        }
        summary.rows.sort {
            if $0.isLoginCookie != $1.isLoginCookie { return $0.isLoginCookie }
            if $0.name != $1.name { return $0.name < $1.name }
            return $0.domain < $1.domain
        }
        return summary
    }

    private static func covers(_ bareDomain: String, _ root: String) -> Bool {
        bareDomain == root || bareDomain.hasSuffix(".\(root)")
    }

    /// Foundation only models Lax and Strict; it reports `SameSite=None` and a
    /// missing attribute the same way, so both read as "unset" here.
    private static func sameSiteLabel(_ cookie: HTTPCookie) -> String {
        guard let raw = cookie.sameSitePolicy?.rawValue.lowercased(), !raw.isEmpty else { return "unset" }
        if raw.contains("strict") { return "strict" }
        if raw.contains("lax") { return "lax" }
        if raw.contains("none") { return "none" }
        return raw
    }

    private static func expiryLabel(_ cookie: HTTPCookie) -> String {
        guard let expires = cookie.expiresDate else { return "session" }
        return isoFormatter.string(from: expires)
    }

    // MARK: - Report

    struct Snapshot {
        var version = LoginDiagnostics.versionLine
        /// "iPadOS 26.6.2" from the app layer; Core has no UIKit.
        var system: String?
        /// "pad", "phone", … from UIUserInterfaceIdiom.
        var idiom: String?
        var privateSettings: WebKitPrivateSettings.Report?
        var probe: ChzzkLoginProbe?
        var cookies: CookieSummary?
    }

    /// One ordered list drives both the on-screen section and the copied text,
    /// so what the user reads is what the user pastes.
    static func lines(for snapshot: Snapshot) -> [String] {
        var lines = [snapshot.version]

        var device = snapshot.system ?? "기기 정보 없음"
        if let idiom = snapshot.idiom { device += " (\(idiom))" }
        lines.append("기기: \(device)")

        if let settings = snapshot.privateSettings {
            lines.append("추적 방지 해제: \(settings.trackingPreventionDisabled ? "적용됨" : "적용 안 됨")")
        } else {
            lines.append("추적 방지 해제: 확인 전")
        }

        if let probe = snapshot.probe {
            lines.append("상태: \(probe.status.code) (\(timeFormatter.string(from: probe.checkedAt)))")
            lines.append(
                "응답: HTTP \(probe.httpStatus.map(String.init) ?? "-")"
                    + ", code \(probe.apiCode.map(String.init) ?? "-")"
                    + ", loggedIn \(probe.loggedIn.map { $0 ? "true" : "false" } ?? "-")"
                    + ", 실패 \(probe.failure ?? "-")"
            )
            lines.append("페이지: \(probe.pageHost ?? "-")")
        } else {
            lines.append("상태: 아직 확인하지 않았습니다.")
        }

        if let cookies = snapshot.cookies {
            lines.append("네이버 쿠키 \(cookies.rows.count)개 (\(timeFormatter.string(from: cookies.readAt)) 기준)")
            if cookies.rows.isEmpty {
                lines.append("  없음")
            } else {
                lines.append(contentsOf: cookies.rows.map(cookieLine))
            }
            lines.append("구글 쿠키: \(cookies.googleCookieCount)개")
            if cookies.loginCookiesAreSessionOnly {
                lines.append("로그인 쿠키가 세션 전용입니다. 네이버 로그인 화면의 '로그인 상태 유지'를 켜면 앱을 다시 켜도 유지됩니다.")
            }
        } else {
            lines.append("쿠키: 아직 읽지 않았습니다.")
        }

        return lines
    }

    /// Attributes only, one cookie per line. "*" marks NID_AUT / NID_SES.
    static func cookieLine(_ row: CookieRow) -> String {
        var flags: [String] = []
        if row.isSecure { flags.append("secure") }
        if row.isHTTPOnly { flags.append("httpOnly") }
        return "\(row.isLoginCookie ? "*" : "-") \(row.name) | \(row.domain)\(row.path)"
            + " | \(flags.isEmpty ? "평문" : flags.joined(separator: "+"))"
            + " | ss=\(row.sameSite) | \(row.expires)"
    }

    static func reportText(for snapshot: Snapshot) -> String {
        lines(for: snapshot).joined(separator: "\n")
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()
}
