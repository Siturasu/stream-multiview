import Foundation
import WebKit

/// One persistent WebKit session shared by the login and viewer web views and
/// by the native bridge when a caller explicitly requests credentials.
@MainActor
enum SharedWebSession {
    static let dataStore = WKWebsiteDataStore.default()

    static func synchronizeCookies() async {
        // Crossing the WKHTTPCookieStore process boundary gives pending cookie
        // writes a chance to settle before the login sheet is dismissed.
        _ = await dataStore.httpCookieStore.allCookies()
    }
}

/// Loads cookies without exposing their values to JavaScript or diagnostics.
struct NativeFetchCookieSource: Sendable {
    let load: @MainActor @Sendable () async -> [HTTPCookie]
}

/// Selects only cookies WebKit could send to an explicitly credentialed HTTPS
/// request. Native bridge requests are cross-site relative to the local viewer,
/// so cookies with an explicit Lax or Strict policy are never forwarded.
struct NativeFetchCookiePolicy: Sendable {
    /// Each request host is paired with the narrowest parent cookie domain it
    /// may accept. This rejects public-suffix or unrelated-domain cookies even
    /// if a malformed cookie somehow reached the WebKit store.
    let rootDomainByRequestHost: [String: String]

    func matchingCookies(
        for url: URL,
        from cookies: [HTTPCookie],
        now: Date = Date()
    ) -> [HTTPCookie] {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              let allowedRoot = rootDomainByRequestHost[host] else {
            return []
        }

        return cookies.filter { cookie in
            guard domainMatches(cookie: cookie, requestHost: host, allowedRoot: allowedRoot),
                  pathMatches(cookiePath: cookie.path, requestPath: url.path(percentEncoded: true)),
                  !cookie.isSecure || url.scheme?.lowercased() == "https",
                  cookie.expiresDate.map({ $0 > now }) ?? true else {
                return false
            }

            // Foundation exposes explicit SameSite=Lax/Strict, but represents
            // an unrestricted cookie as nil. Preserve explicit restrictions;
            // do not rewrite the cookie's SameSite attribute.
            return cookie.sameSitePolicy == nil
        }
        .sorted {
            if $0.path.count != $1.path.count { return $0.path.count > $1.path.count }
            return $0.name < $1.name
        }
    }

    private func domainMatches(
        cookie: HTTPCookie,
        requestHost: String,
        allowedRoot: String
    ) -> Bool {
        let rawDomain = cookie.domain.lowercased()
        let domain = rawDomain.hasPrefix(".") ? String(rawDomain.dropFirst()) : rawDomain
        guard !domain.isEmpty,
              domain == allowedRoot || domain.hasSuffix(".\(allowedRoot)") else {
            return false
        }

        if rawDomain.hasPrefix(".") {
            return requestHost == domain || requestHost.hasSuffix(".\(domain)")
        }
        // WKHTTPCookieStore preserves host-only cookies without a leading dot.
        return requestHost == domain
    }

    private func pathMatches(cookiePath: String, requestPath: String) -> Bool {
        let cookiePath = cookiePath.hasPrefix("/") ? cookiePath : "/"
        let requestPath = requestPath.isEmpty ? "/" : requestPath
        guard requestPath.hasPrefix(cookiePath) else { return false }
        if requestPath == cookiePath || cookiePath.hasSuffix("/") { return true }
        let boundary = requestPath.index(requestPath.startIndex, offsetBy: cookiePath.count)
        return boundary < requestPath.endIndex && requestPath[boundary] == "/"
    }
}

struct NativeFetchCookieRequestPreparer: Sendable {
    let policy: NativeFetchCookiePolicy
    let source: NativeFetchCookieSource?

    func prepare(_ original: URLRequest, includeCookies: Bool) async -> URLRequest {
        var request = original
        // Redirect requests can inherit the previous Cookie header. Always
        // remove it before considering cookies for the new destination.
        request.setValue(nil, forHTTPHeaderField: "Cookie")
        guard includeCookies, let source, let url = request.url else { return request }

        let cookies = await source.load()
        let matching = policy.matchingCookies(for: url, from: cookies)
        guard !matching.isEmpty,
              let value = HTTPCookie.requestHeaderFields(with: matching)["Cookie"] else {
            return request
        }
        request.setValue(value, forHTTPHeaderField: "Cookie")
        return request
    }
}
