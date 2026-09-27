package dev.siturasu.streammultiview

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** Persists chrome.storage.local items (JSON strings keyed by name). */
class ChromeStorage(context: Context, name: String = "chrome.storage.local") {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    fun all(): Map<String, String> =
        prefs.all.mapNotNull { (key, value) -> (value as? String)?.let { key to it } }.toMap()

    fun set(items: Map<String, String>) {
        prefs.edit().apply { items.forEach { (key, value) -> putString(key, value) } }.apply()
    }

    fun remove(keys: List<String>) {
        prefs.edit().apply { keys.forEach { remove(it) } }.apply()
    }

    fun clear() = prefs.edit().clear().apply()
}

/**
 * Native side of `window.stellaViewNative` (androidx WebMessageListener), the
 * Android transport of ios-web/chrome-shim.js. Requests are JSON
 * `{id, op, ...payload}`; replies are `{id, result}` or `{id, error}`.
 *
 * Operations: storage.getAll / storage.set {items} / storage.remove {keys},
 * fetch {url, method, headers} -> {status, url, headers, body}, openURL {url},
 * openLogin, log {text}. The listener object is injected into every
 * chzzk.naver.com frame, including the stream iframes, so only the main frame
 * may use it.
 */
class NativeBridge(
    private val context: Context,
    val storage: ChromeStorage = ChromeStorage(context),
) : WebViewCompat.WebMessageListener {
    var openLoginHandler: (() -> Unit)? = null
    var logHandler: ((String) -> Unit)? = null

    private val executor = Executors.newFixedThreadPool(4)
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        val request = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        val id = request.opt("id") ?: return
        if (!isMainFrame || sourceOrigin.scheme != "https" || sourceOrigin.host != WrapperConfig.VIEWER_HOST) {
            reply(replyProxy, id, error = "뷰어 페이지에서만 사용할 수 있습니다.")
            return
        }
        val op = request.optString("op")
        when (op) {
            // UI-thread operations answer immediately.
            "openURL" -> {
                val url = request.optString("url")
                val uri = Uri.parse(url)
                if (uri.scheme == "https" || uri.scheme == "http") {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    reply(replyProxy, id, result = JSONObject().put("ok", true))
                } else {
                    reply(replyProxy, id, error = "허용되지 않은 주소입니다: $url")
                }
            }
            "openLogin" -> {
                val handler = openLoginHandler
                handler?.invoke()
                reply(replyProxy, id, result = JSONObject().put("ok", handler != null))
            }
            "log" -> {
                logHandler?.invoke(request.optString("text"))
                reply(replyProxy, id, result = JSONObject().put("ok", true))
            }
            else -> executor.execute {
                val outcome = runCatching { handle(op, request) }
                mainHandler.post {
                    outcome
                        .onSuccess { reply(replyProxy, id, result = it) }
                        .onFailure { reply(replyProxy, id, error = it.message ?: "요청을 처리하지 못했습니다.") }
                }
            }
        }
    }

    private fun handle(op: String, request: JSONObject): Any = when (op) {
        "storage.getAll" -> JSONObject().put("items", JSONObject(storage.all()))
        "storage.set" -> {
            val items = request.optJSONObject("items") ?: throw IllegalArgumentException("잘못된 브리지 메시지입니다.")
            storage.set(items.keys().asSequence().associateWith { items.optString(it) })
            JSONObject().put("ok", true)
        }
        "storage.remove" -> {
            val keys = request.optJSONArray("keys") ?: throw IllegalArgumentException("잘못된 브리지 메시지입니다.")
            storage.remove((0 until keys.length()).map { keys.optString(it) })
            JSONObject().put("ok", true)
        }
        "fetch" -> fetch(request)
        else -> throw IllegalArgumentException("지원하지 않는 브리지 작업입니다: $op")
    }

    /**
     * Plain HttpURLConnection without a cookie jar (the viewer's own fetch is
     * blocked by CORS for these hosts). Redirects are followed manually so
     * every hop is checked against the allowlist.
     */
    private fun fetch(request: JSONObject): JSONObject {
        var url = URL(request.optString("url"))
        val method = request.optString("method", "GET").uppercase()
        val headers = request.optJSONObject("headers")
        val reserved = setOf("user-agent", "host", "content-length", "cookie")
        var redirects = 0
        while (true) {
            if (url.protocol != "https" || url.host.lowercase() !in WrapperConfig.NATIVE_FETCH_HOSTS) {
                throw IllegalArgumentException("허용되지 않은 주소입니다: $url")
            }
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = method
                instanceFollowRedirects = false
                connectTimeout = WrapperConfig.REQUEST_TIMEOUT_MS
                readTimeout = WrapperConfig.REQUEST_TIMEOUT_MS
                useCaches = false
                setRequestProperty("User-Agent", WrapperConfig.userAgent(context))
                setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7")
                headers?.keys()?.forEach { name ->
                    if (name.lowercase() !in reserved) setRequestProperty(name, headers.optString(name))
                }
            }
            try {
                val status = connection.responseCode
                if (status in 300..399 && redirects < 5) {
                    val location = connection.getHeaderField("Location") ?: throw IllegalStateException("응답 형식이 올바르지 않습니다.")
                    url = URL(url, location)
                    redirects += 1
                    continue
                }
                val declared = connection.contentLengthLong
                if (declared > WrapperConfig.MAX_RESPONSE_BYTES) throw IllegalStateException("응답이 너무 큽니다.")
                val stream = (if (status >= 400) connection.errorStream else connection.inputStream) ?: InputStream.nullInputStream()
                val body = readLimited(stream, WrapperConfig.MAX_RESPONSE_BYTES)
                val responseHeaders = JSONObject()
                connection.headerFields.forEach { (name, values) ->
                    if (name != null) responseHeaders.put(name.lowercase(), values.joinToString(", "))
                }
                return JSONObject()
                    .put("status", status)
                    .put("url", url.toString())
                    .put("headers", responseHeaders)
                    .put("body", String(body, Charsets.UTF_8))
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun readLimited(stream: InputStream, limit: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        stream.use {
            while (true) {
                val read = it.read(buffer)
                if (read < 0) break
                if (output.size() + read > limit) throw IllegalStateException("응답이 너무 큽니다.")
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }

    private fun reply(proxy: JavaScriptReplyProxy, id: Any, result: Any? = null, error: String? = null) {
        val payload = JSONObject().put("id", id)
        if (error != null) payload.put("error", error) else payload.put("result", result ?: JSONObject.NULL)
        if (Looper.myLooper() == Looper.getMainLooper()) proxy.postMessage(payload.toString())
        else mainHandler.post { proxy.postMessage(payload.toString()) }
    }

    @Suppress("unused")
    private fun JSONArray.strings(): List<String> = (0 until length()).map { optString(it) }
}
