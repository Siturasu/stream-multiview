import Foundation
import WebKit

/// Sites the user can sign in to from the app. Logging in at top level in a
/// web view that shares the default data store leaves the cookies where the
/// viewer's chzzk/YouTube frames can use them.
enum LoginDestination: CaseIterable, Hashable {
    case chzzk
    case youtube

    var title: String {
        switch self {
        case .chzzk: return "치지직 (네이버)"
        case .youtube: return "유튜브 (구글)"
        }
    }

    var url: URL {
        switch self {
        case .chzzk:
            return URL(string: "https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fchzzk.naver.com%2F")!
        case .youtube:
            return URL(string: "https://accounts.google.com/ServiceLogin?service=youtube&hl=ko&continue=https%3A%2F%2Fwww.youtube.com%2F")!
        }
    }
}

enum ChzzkLoginStatus: Equatable {
    case waiting
    case checking
    case signedIn
    case signedOut
    case unavailable

    var message: String {
        switch self {
        case .waiting: return "로그인 뒤 치지직 화면에서 상태를 확인합니다."
        case .checking: return "치지직 로그인 상태 확인 중…"
        case .signedIn: return "치지직 로그인이 확인됐습니다. 아래 치지직 화면을 한 번 누른 뒤 완료하세요."
        case .signedOut: return "치지직 로그인이 확인되지 않았습니다."
        case .unavailable: return "치지직 로그인 상태를 확인하지 못했습니다. 다시 확인을 눌러 주세요."
        }
    }

    /// Short identifier for the diagnostics report, separate from the user
    /// message so the wording can change without breaking a pasted report.
    var code: String {
        switch self {
        case .waiting: return "waiting"
        case .checking: return "checking"
        case .signedIn: return "signedIn"
        case .signedOut: return "signedOut"
        case .unavailable: return "unavailable"
        }
    }
}

/// One status check with the detail needed to tell HTTP failures, schema
/// failures and a real signed-out answer apart. Carries no cookie value,
/// account identifier, response body or URL query string.
struct ChzzkLoginProbe: Equatable {
    var status: ChzzkLoginStatus
    var httpStatus: Int?
    var apiCode: Int?
    var loggedIn: Bool?
    /// "not-on-chzzk", "fetch-error", "timeout", "http-<code>", "schema" or
    /// "js-error". Nil when the check answered.
    var failure: String?
    var checkedAt: Date
    /// Host only, never the path or query of the inspected page.
    var pageHost: String?

    init(
        status: ChzzkLoginStatus,
        httpStatus: Int? = nil,
        apiCode: Int? = nil,
        loggedIn: Bool? = nil,
        failure: String? = nil,
        checkedAt: Date = Date(),
        pageHost: String? = nil
    ) {
        self.status = status
        self.httpStatus = httpStatus
        self.apiCode = apiCode
        self.loggedIn = loggedIn
        self.failure = failure
        self.checkedAt = checkedAt
        self.pageHost = pageHost
    }
}

enum LoginWebViewFactory {
    struct Result {
        let webView: WKWebView
        let privateSettings: WebKitPrivateSettings.Report
    }

    @MainActor
    static func make() -> Result {
        let (configuration, privateSettings) = ViewerWebViewController.makeConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = ViewerConfiguration.userAgent
        webView.isInspectable = true
        return Result(webView: webView, privateSettings: privateSettings)
    }

    /// Existing callers keep the plain status; the diagnostics section uses
    /// `probeChzzkLogin` for the same check with its failure detail.
    @MainActor
    static func checkChzzkLogin(in webView: WKWebView) async -> ChzzkLoginStatus {
        await probeChzzkLogin(in: webView).status
    }

    /// Uses the same read-only endpoint as CHZZK's own web app and returns only
    /// its status code and login boolean. Account identifiers, cookie values and
    /// the rest of the response never cross the page-to-native boundary.
    @MainActor
    static func probeChzzkLogin(in webView: WKWebView) async -> ChzzkLoginProbe {
        let pageHost = webView.url?.host?.lowercased()
        guard pageHost == "chzzk.naver.com" else {
            return ChzzkLoginProbe(status: .waiting, failure: "not-on-chzzk", pageHost: pageHost)
        }
        do {
            let result = try await webView.callAsyncJavaScript(
                """
                const controller = new AbortController();
                let timedOut = false;
                const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
                try {
                  const response = await fetch(
                    \(WebAssets.jsString(ViewerConfiguration.chzzkUserStatusURL)),
                    {
                      method: "GET",
                      credentials: "include",
                      cache: "no-store",
                      headers: { Accept: "application/json" },
                      signal: controller.signal,
                    }
                  );
                  const httpStatus = response.status;
                  if (!response.ok) return { ok: false, httpStatus, failure: "http-" + httpStatus };
                  let payload = null;
                  try {
                    payload = await response.json();
                  } catch {
                    return { ok: false, httpStatus, failure: "schema" };
                  }
                  const apiCode = typeof payload?.code === "number" ? payload.code : null;
                  const loggedIn = typeof payload?.content?.loggedIn === "boolean" ? payload.content.loggedIn : null;
                  if (apiCode !== 200 || loggedIn === null) {
                    return { ok: false, httpStatus, apiCode, failure: "schema" };
                  }
                  return { ok: true, httpStatus, apiCode, loggedIn };
                } catch (error) {
                  const aborted = timedOut || error?.name === "AbortError";
                  return { ok: false, failure: aborted ? "timeout" : "fetch-error" };
                } finally {
                  clearTimeout(timeout);
                }
                """,
                arguments: [:],
                in: nil,
                contentWorld: .page
            )
            guard let payload = result as? [String: Any] else {
                return ChzzkLoginProbe(status: .unavailable, failure: "schema", pageHost: pageHost)
            }
            let httpStatus = payload["httpStatus"] as? Int
            let apiCode = payload["apiCode"] as? Int
            let loggedIn = payload["loggedIn"] as? Bool
            guard payload["ok"] as? Bool == true, let loggedIn else {
                return ChzzkLoginProbe(
                    status: .unavailable,
                    httpStatus: httpStatus,
                    apiCode: apiCode,
                    loggedIn: loggedIn,
                    failure: payload["failure"] as? String ?? "schema",
                    pageHost: pageHost
                )
            }
            return ChzzkLoginProbe(
                status: loggedIn ? .signedIn : .signedOut,
                httpStatus: httpStatus,
                apiCode: apiCode,
                loggedIn: loggedIn,
                pageHost: pageHost
            )
        } catch {
            return ChzzkLoginProbe(status: .unavailable, failure: "js-error", pageHost: pageHost)
        }
    }
}
