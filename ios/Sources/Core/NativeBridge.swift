import Foundation
import WebKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Persists `chrome.storage.local` items (JSON strings keyed by name).
final class ChromeStorage {
    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = "chrome.storage.local") {
        self.defaults = defaults
        self.key = key
    }

    func all() -> [String: String] {
        // Per-entry cast: one foreign value must not wipe every saved tile.
        (defaults.dictionary(forKey: key) ?? [:]).compactMapValues { $0 as? String }
    }

    func set(_ items: [String: String]) {
        var current = all()
        for (name, value) in items { current[name] = value }
        defaults.set(current, forKey: key)
    }

    func remove(_ keys: [String]) {
        var current = all()
        for name in keys { current.removeValue(forKey: name) }
        defaults.set(current, forKey: key)
    }
}

enum BridgeError: LocalizedError {
    case invalidMessage
    case unknownOperation(String)
    case forbiddenURL(String)
    case badResponse
    case responseTooLarge
    case wrongFrame

    var errorDescription: String? {
        switch self {
        case .invalidMessage: return "잘못된 브리지 메시지입니다."
        case .unknownOperation(let operation): return "지원하지 않는 브리지 작업입니다: \(operation)"
        case .forbiddenURL(let url): return "허용되지 않은 주소입니다: \(url)"
        case .badResponse: return "응답 형식이 올바르지 않습니다."
        case .responseTooLarge: return "응답이 너무 큽니다."
        case .wrongFrame: return "뷰어 페이지에서만 사용할 수 있습니다."
        }
    }
}

struct NativeFetchResult {
    let data: Data
    let response: HTTPURLResponse
}

struct NativeFetchPolicy: Sendable {
    let allowedHosts: Set<String>
    let maxResponseBytes: Int

    func allows(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased() else {
            return false
        }
        return allowedHosts.contains(host)
    }
}

/// Runs one data task per request so redirects and streaming byte counts can be
/// checked before URLSession reaches or buffers a forbidden/oversized response.
final class NativeFetchClient: @unchecked Sendable {
    private let configuration: URLSessionConfiguration
    private let policy: NativeFetchPolicy
    private let cookiePreparer: NativeFetchCookieRequestPreparer

    init(
        configuration: URLSessionConfiguration,
        policy: NativeFetchPolicy,
        cookiePreparer: NativeFetchCookieRequestPreparer = NativeFetchCookieRequestPreparer(
            policy: NativeFetchCookiePolicy(rootDomainByRequestHost: [:]),
            source: nil
        )
    ) {
        self.configuration = configuration.copy() as! URLSessionConfiguration
        self.policy = policy
        self.cookiePreparer = cookiePreparer
    }

    func data(for request: URLRequest, includeCookies: Bool = false) async throws -> NativeFetchResult {
        guard policy.allows(request.url) else {
            throw BridgeError.forbiddenURL(request.url?.absoluteString ?? "")
        }
        let prepared = await cookiePreparer.prepare(request, includeCookies: includeCookies)
        let delegate = NativeFetchTaskDelegate(
            policy: policy,
            cookiePreparer: cookiePreparer,
            includeCookies: includeCookies
        )
        return try await delegate.load(prepared, configuration: configuration)
    }
}

private final class NativeFetchTaskDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let policy: NativeFetchPolicy
    private let cookiePreparer: NativeFetchCookieRequestPreparer
    private let includeCookies: Bool
    private var data = Data()
    private var response: HTTPURLResponse?
    private var storedError: Error?
    private var continuation: CheckedContinuation<NativeFetchResult, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?

    init(
        policy: NativeFetchPolicy,
        cookiePreparer: NativeFetchCookieRequestPreparer,
        includeCookies: Bool
    ) {
        self.policy = policy
        self.cookiePreparer = cookiePreparer
        self.includeCookies = includeCookies
    }

    func load(
        _ request: URLRequest,
        configuration: URLSessionConfiguration
    ) async throws -> NativeFetchResult {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
            self.session = session
            let task = session.dataTask(with: request)
            self.task = task
            task.resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard policy.allows(request.url) else {
            storedError = BridgeError.forbiddenURL(request.url?.absoluteString ?? "")
            completionHandler(nil)
            task.cancel()
            return
        }
        // URLSession may copy request headers across a redirect. Recompute the
        // Cookie header for the destination so a cross-host redirect can never
        // inherit cookies selected for the source host.
        Task {
            let prepared = await cookiePreparer.prepare(request, includeCookies: includeCookies)
            completionHandler(prepared)
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            storedError = BridgeError.badResponse
            completionHandler(.cancel)
            return
        }
        self.response = http

        let isHead = dataTask.currentRequest?.httpMethod?.uppercased() == "HEAD"
        if !isHead, response.expectedContentLength > Int64(policy.maxResponseBytes) {
            storedError = BridgeError.responseTooLarge
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive newData: Data) {
        guard storedError == nil else { return }
        guard newData.count <= policy.maxResponseBytes - data.count else {
            storedError = BridgeError.responseTooLarge
            dataTask.cancel()
            return
        }
        data.append(newData)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let storedError {
            finish(.failure(storedError))
        } else if let error {
            finish(.failure(error))
        } else if let response {
            finish(.success(NativeFetchResult(data: data, response: response)))
        } else {
            finish(.failure(BridgeError.badResponse))
        }
    }

    private func finish(_ result: Result<NativeFetchResult, Error>) {
        guard let continuation else { return }
        self.continuation = nil
        self.task = nil
        let session = self.session
        self.session = nil
        continuation.resume(with: result)
        session?.finishTasksAndInvalidate()
    }
}

/// Native side of `window.webkit.messageHandlers.stellaViewNative`.
///
/// Operations (see ios-web/chrome-shim.js):
///   storage.getAll / storage.set {items} / storage.remove {keys}
///   fetch {url, method, headers}   -> {status, url, headers, body}
///   openURL {url}
///   openLogin                        (shows the in-app login screen)
///   log {text}
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    let storage: ChromeStorage
    private let fetchClient: NativeFetchClient
    var logHandler: ((String) -> Void)?
    var openLoginHandler: (() -> Void)?

    init(storage: ChromeStorage = ChromeStorage()) {
        self.storage = storage
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = ViewerConfiguration.requestTimeout
        configuration.timeoutIntervalForResource = ViewerConfiguration.requestTimeout * 2
        // WebKit owns the only persistent cookie jar. URLSession must not keep
        // a second jar or attach cookies behind the explicit credentials gate.
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.httpAdditionalHeaders = [
            "User-Agent": ViewerConfiguration.userAgent,
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        ]
        fetchClient = NativeFetchClient(
            configuration: configuration,
            policy: NativeFetchPolicy(
                allowedHosts: ViewerConfiguration.nativeFetchHosts,
                maxResponseBytes: ViewerConfiguration.maxResponseBytes
            ),
            cookiePreparer: NativeFetchCookieRequestPreparer(
                policy: NativeFetchCookiePolicy(rootDomainByRequestHost: [
                    "api.chzzk.naver.com": "naver.com",
                    "www.youtube.com": "youtube.com",
                ]),
                source: NativeFetchCookieSource {
                    await SharedWebSession.dataStore.httpCookieStore.allCookies()
                }
            )
        )
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        // The handler is visible to every frame in the page world; only the
        // viewer document itself may use it.
        guard message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == ViewerConfiguration.viewerHost else {
            replyHandler(nil, BridgeError.wrongFrame.localizedDescription)
            return
        }
        guard let body = message.body as? [String: Any], let operation = body["op"] as? String else {
            replyHandler(nil, BridgeError.invalidMessage.localizedDescription)
            return
        }
        Task { @MainActor in
            do {
                let result = try await self.handle(operation: operation, body: body)
                replyHandler(result, nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }

    private func handle(operation: String, body: [String: Any]) async throws -> Any? {
        switch operation {
        case "storage.getAll":
            return ["items": storage.all()]
        case "storage.set":
            guard let items = body["items"] as? [String: String] else { throw BridgeError.invalidMessage }
            storage.set(items)
            return ["ok": true]
        case "storage.remove":
            guard let keys = body["keys"] as? [String] else { throw BridgeError.invalidMessage }
            storage.remove(keys)
            return ["ok": true]
        case "fetch":
            return try await fetch(body)
        case "openURL":
            guard let value = body["url"] as? String,
                  let url = URL(string: value),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http" else {
                throw BridgeError.forbiddenURL((body["url"] as? String) ?? "")
            }
            open(url)
            return ["ok": true]
        case "openLogin":
            openLoginHandler?()
            return ["ok": openLoginHandler != nil]
        case "log":
            logHandler?((body["text"] as? String) ?? "")
            return ["ok": true]
        default:
            throw BridgeError.unknownOperation(operation)
        }
    }

    private func fetch(_ body: [String: Any]) async throws -> [String: Any] {
        let value = (body["url"] as? String) ?? ""
        guard let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              ViewerConfiguration.nativeFetchHosts.contains(host) else {
            throw BridgeError.forbiddenURL(value)
        }

        var request = URLRequest(url: url)
        request.httpMethod = (body["method"] as? String)?.uppercased() ?? "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let headers = body["headers"] as? [String: String] {
            let reserved: Set<String> = ["user-agent", "host", "content-length", "cookie"]
            for (name, headerValue) in headers where !reserved.contains(name.lowercased()) {
                request.setValue(headerValue, forHTTPHeaderField: name)
            }
        }

        // Preserve Fetch credentials semantics. Existing metadata requests use
        // `omit`; only an explicit `include` may read from the WebKit cookie jar.
        let includeCookies = (body["credentials"] as? String) == "include"
        let result = try await fetchClient.data(for: request, includeCookies: includeCookies)
        let data = result.data
        let http = result.response

        var headers: [String: String] = [:]
        let hiddenResponseHeaders: Set<String> = ["set-cookie", "set-cookie2"]
        for (name, headerValue) in http.allHeaderFields {
            if let name = name as? String, let headerValue = headerValue as? String {
                let normalizedName = name.lowercased()
                if !hiddenResponseHeaders.contains(normalizedName) {
                    headers[normalizedName] = headerValue
                }
            }
        }
        return [
            "status": http.statusCode,
            "url": http.url?.absoluteString ?? value,
            "headers": headers,
            "body": String(decoding: data, as: UTF8.self),
        ]
    }

    private func open(_ url: URL) {
        #if canImport(UIKit)
        UIApplication.shared.open(url)
        #elseif canImport(AppKit)
        NSWorkspace.shared.open(url)
        #endif
    }
}
