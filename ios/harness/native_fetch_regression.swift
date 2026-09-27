import Darwin
import Foundation

private enum FixtureError: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): return message
        }
    }
}

private final class FixtureURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var requestedURLs: [URL] = []
    private static var stoppedURLs: [URL] = []
    private static var cookieNamesByURL: [String: Set<String>] = [:]

    static func reset() {
        lock.lock()
        requestedURLs = []
        stoppedURLs = []
        cookieNamesByURL = [:]
        lock.unlock()
    }

    static func requests() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        return requestedURLs
    }

    static func stops() -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        return stoppedURLs
    }

    static func cookieNames(for url: URL) -> Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return cookieNamesByURL[url.absoluteString] ?? []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.lock.lock()
        Self.requestedURLs.append(url)
        let names = Set(
            (request.value(forHTTPHeaderField: "Cookie") ?? "")
                .split(separator: ";")
                .compactMap { pair in
                    pair.split(separator: "=", maxSplits: 1).first.map {
                        $0.trimmingCharacters(in: .whitespaces)
                    }
                }
        )
        Self.cookieNamesByURL[url.absoluteString] = names
        Self.lock.unlock()

        switch url.path {
        case "/redirect-allowed":
            redirect(to: URL(string: "https://allowed.test/ordinary")!)
        case "/redirect-blocked":
            redirect(to: URL(string: "https://blocked.test/must-not-load")!)
        case "/redirect-cross-host":
            redirect(to: URL(string: "https://other.test/ordinary")!)
        case "/oversized-unknown":
            // Leave the response open: the client must reject/cancel before
            // EOF, rather than checking the size after downloading it all.
            send(status: 200, headers: [:], chunks: [
                Data(repeating: 97, count: 3_000_000),
                Data(repeating: 98, count: 2_000_000),
            ], finish: false)
        case "/oversized-declared":
            // An explicit MIME type prevents CFNetwork's sniffing stage from
            // waiting for body bytes before it delivers the response headers.
            send(status: 200, headers: ["Content-Length": "5000000", "Content-Type": "application/octet-stream"], chunks: [], finish: false)
        case "/head":
            send(status: 200, headers: ["Content-Length": "5000000"], chunks: [])
        default:
            send(status: 200, headers: ["X-Fixture": "ordinary"], chunks: [Data("fixture-ok".utf8)])
        }
    }

    override func stopLoading() {
        guard let url = request.url else { return }
        Self.lock.lock()
        Self.stoppedURLs.append(url)
        Self.lock.unlock()
    }

    private func redirect(to target: URL) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 302,
            httpVersion: "HTTP/1.1",
            headerFields: ["Location": target.absoluteString]
        )!
        client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
    }

    private func send(status: Int, headers: [String: String], chunks: [Data], finish: Bool = true) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        if finish { client?.urlProtocolDidFinishLoading(self) }
    }
}

@main
private enum NativeFetchRegression {
    static func main() async {
        do {
            try await testOrdinaryResponse()
            print("PASS ordinary response")
            try await testAllowedRedirect()
            print("PASS allowed redirect")
            try await testBlockedRedirectNeverLoadsTarget()
            print("PASS blocked redirect")
            try await testUnknownLengthActualLimit()
            print("PASS unknown-length limit")
            try await testDeclaredLengthLimit()
            print("PASS declared-length limit")
            try await testHeadKeepsBodylessSemantics()
            print("PASS HEAD response")
            try testCookieMatchingPolicy()
            print("PASS cookie matching policy")
            try await testCredentialsOmitSendsNoCookies()
            print("PASS credentials omit")
            try await testExplicitIncludeSendsOnlyMatchingCookies()
            print("PASS explicit credentials include")
            try await testCrossHostRedirectRecomputesCookies()
            print("PASS redirect cookie isolation")
            print("PASS native fetch regression")
        } catch {
            fputs("FAIL native fetch regression: \(error)\n", stderr)
            exit(1)
        }
    }

    private static func makeClient(cookies: [HTTPCookie] = []) -> NativeFetchClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureURLProtocol.self]
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 3
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        return NativeFetchClient(
            configuration: configuration,
            policy: NativeFetchPolicy(allowedHosts: ["allowed.test", "other.test"], maxResponseBytes: 4_000_000),
            cookiePreparer: NativeFetchCookieRequestPreparer(
                policy: NativeFetchCookiePolicy(rootDomainByRequestHost: [
                    "allowed.test": "allowed.test",
                    "other.test": "other.test",
                ]),
                source: NativeFetchCookieSource { cookies }
            )
        )
    }

    private static func request(_ path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: URL(string: "https://allowed.test\(path)")!)
        request.httpMethod = method
        return request
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw FixtureError.failed(message) }
    }

    private static func testOrdinaryResponse() async throws {
        FixtureURLProtocol.reset()
        let result = try await makeClient().data(for: request("/ordinary"))
        try require(result.response.statusCode == 200, "ordinary status")
        try require(String(decoding: result.data, as: UTF8.self) == "fixture-ok", "ordinary body")
        try require(result.response.value(forHTTPHeaderField: "X-Fixture") == "ordinary", "ordinary headers")
    }

    private static func testAllowedRedirect() async throws {
        FixtureURLProtocol.reset()
        let result = try await makeClient().data(for: request("/redirect-allowed"))
        try require(result.response.url?.absoluteString == "https://allowed.test/ordinary", "allowed redirect URL")
        try require(String(decoding: result.data, as: UTF8.self) == "fixture-ok", "allowed redirect body")
    }

    private static func testBlockedRedirectNeverLoadsTarget() async throws {
        FixtureURLProtocol.reset()
        do {
            _ = try await makeClient().data(for: request("/redirect-blocked"))
            throw FixtureError.failed("blocked redirect unexpectedly succeeded")
        } catch BridgeError.forbiddenURL(let url) {
            try require(url == "https://blocked.test/must-not-load", "blocked redirect error URL")
        }
        try require(
            !FixtureURLProtocol.requests().contains(where: { $0.host == "blocked.test" }),
            "blocked redirect target was requested"
        )
        // didCompleteWithError may resume our continuation before URLProtocol
        // receives its stopLoading callback on its own queue.
        for _ in 0..<50 {
            if FixtureURLProtocol.stops().contains(where: { $0.path == "/redirect-blocked" }) { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try require(
            FixtureURLProtocol.stops().contains(where: { $0.path == "/redirect-blocked" }),
            "blocked redirect source task was not cancelled"
        )
    }

    private static func testUnknownLengthActualLimit() async throws {
        FixtureURLProtocol.reset()
        do {
            _ = try await makeClient().data(for: request("/oversized-unknown"))
            throw FixtureError.failed("unknown-length oversized response unexpectedly succeeded")
        } catch BridgeError.responseTooLarge {
            return
        }
    }

    private static func testDeclaredLengthLimit() async throws {
        FixtureURLProtocol.reset()
        do {
            _ = try await makeClient().data(for: request("/oversized-declared"))
            throw FixtureError.failed("declared oversized response unexpectedly succeeded")
        } catch BridgeError.responseTooLarge {
            return
        }
    }

    private static func testHeadKeepsBodylessSemantics() async throws {
        FixtureURLProtocol.reset()
        let result = try await makeClient().data(for: request("/head", method: "HEAD"))
        try require(result.response.statusCode == 200, "HEAD status")
        try require(result.data.isEmpty, "HEAD body")
    }

    private static func cookie(
        _ name: String,
        domain: String,
        path: String = "/",
        secure: Bool = true,
        expires: Date? = Date().addingTimeInterval(3_600),
        sameSite: HTTPCookieStringPolicy? = nil
    ) throws -> HTTPCookie {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .domain: domain,
            .path: path,
            .name: name,
            .value: "redacted-test-value",
        ]
        if secure { properties[.secure] = "TRUE" }
        if let expires { properties[.expires] = expires }
        if let sameSite { properties[.sameSitePolicy] = sameSite.rawValue }
        guard let cookie = HTTPCookie(properties: properties) else {
            throw FixtureError.failed("could not create test cookie named \(name)")
        }
        return cookie
    }

    private static func testCookieMatchingPolicy() throws {
        let policy = NativeFetchCookiePolicy(rootDomainByRequestHost: [
            "api.allowed.test": "allowed.test",
        ])
        let now = Date()
        let candidates = try [
            cookie("domain", domain: ".allowed.test", path: "/private"),
            cookie("host", domain: "api.allowed.test"),
            cookie("nonsecure", domain: ".allowed.test", secure: false),
            cookie("wrong-host-only", domain: "allowed.test"),
            cookie("sibling", domain: ".other.test"),
            cookie("broad", domain: ".test"),
            cookie("wrong-path", domain: ".allowed.test", path: "/priv"),
            cookie("expired", domain: ".allowed.test", expires: now.addingTimeInterval(-1)),
            cookie("lax", domain: ".allowed.test", sameSite: .sameSiteLax),
            cookie("strict", domain: ".allowed.test", sameSite: .sameSiteStrict),
        ]
        let matching = Set(policy.matchingCookies(
            for: URL(string: "https://api.allowed.test/private/item")!,
            from: candidates,
            now: now
        ).map(\.name))
        try require(matching == ["domain", "host", "nonsecure"], "cookie domain/path/expiry/SameSite selection")

        let pathBoundary = policy.matchingCookies(
            for: URL(string: "https://api.allowed.test/privateer")!,
            from: [try cookie("private", domain: ".allowed.test", path: "/private")],
            now: now
        )
        try require(pathBoundary.isEmpty, "cookie path matched without a slash boundary")
        let encodedSlash = policy.matchingCookies(
            for: URL(string: "https://api.allowed.test/private%2Fitem")!,
            from: [try cookie("private", domain: ".allowed.test", path: "/private")],
            now: now
        )
        try require(encodedSlash.isEmpty, "cookie path treated an encoded slash as a boundary")
        let insecure = policy.matchingCookies(
            for: URL(string: "http://api.allowed.test/private/item")!,
            from: [try cookie("secure", domain: ".allowed.test")],
            now: now
        )
        try require(insecure.isEmpty, "secure cookie matched an insecure request")
    }

    private static func testCredentialsOmitSendsNoCookies() async throws {
        FixtureURLProtocol.reset()
        let target = URL(string: "https://allowed.test/ordinary")!
        _ = try await makeClient(cookies: [
            try cookie("session", domain: "allowed.test"),
        ]).data(for: URLRequest(url: target), includeCookies: false)
        try require(FixtureURLProtocol.cookieNames(for: target).isEmpty, "credentials omit sent a cookie")
    }

    private static func testExplicitIncludeSendsOnlyMatchingCookies() async throws {
        FixtureURLProtocol.reset()
        let target = URL(string: "https://allowed.test/private/item")!
        _ = try await makeClient(cookies: [
            try cookie("matching", domain: "allowed.test", path: "/private"),
            try cookie("wrong-path", domain: "allowed.test", path: "/other"),
            try cookie("restricted", domain: "allowed.test", sameSite: .sameSiteLax),
        ]).data(for: URLRequest(url: target), includeCookies: true)
        try require(
            FixtureURLProtocol.cookieNames(for: target) == ["matching"],
            "credentials include did not restrict cookies to the matching request"
        )
    }

    private static func testCrossHostRedirectRecomputesCookies() async throws {
        FixtureURLProtocol.reset()
        let source = URL(string: "https://allowed.test/redirect-cross-host")!
        let target = URL(string: "https://other.test/ordinary")!
        _ = try await makeClient(cookies: [
            try cookie("source-session", domain: "allowed.test"),
            try cookie("target-session", domain: "other.test"),
        ]).data(for: URLRequest(url: source), includeCookies: true)
        try require(
            FixtureURLProtocol.cookieNames(for: source) == ["source-session"],
            "source request did not receive its own cookie"
        )
        try require(
            FixtureURLProtocol.cookieNames(for: target) == ["target-session"],
            "redirect reused a cookie selected for another host"
        )
    }
}
