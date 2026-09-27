package dev.siturasu.streammultiview

import android.content.Context
import org.json.JSONObject

/**
 * Reads the shared web assets (staged by Gradle under assets/web/) and composes
 * the viewer document and the document-start scripts. Mirrors
 * ios/Sources/Core/WebAssets.swift, except that modules are not inlined: the
 * WebView serves every file under https://chzzk.naver.com/__stellaview/ from
 * assets, so relative module imports resolve naturally.
 */
class WebAssets(private val context: Context) {
    class AssetError(message: String) : Exception(message)

    fun text(relativePath: String): String {
        val normalized = relativePath.trimStart('/')
        if (normalized.contains("..")) throw AssetError("웹 루트 밖의 경로입니다: $relativePath")
        return try {
            context.assets.open("web/$normalized").bufferedReader(Charsets.UTF_8).use { it.readText() }
        } catch (error: Exception) {
            throw AssetError("웹 자산이 없습니다: $relativePath")
        }
    }

    fun bytes(relativePath: String): ByteArray {
        val normalized = relativePath.trimStart('/')
        if (normalized.contains("..")) throw AssetError("웹 루트 밖의 경로입니다: $relativePath")
        return try {
            context.assets.open("web/$normalized").use { it.readBytes() }
        } catch (error: Exception) {
            throw AssetError("웹 자산이 없습니다: $relativePath")
        }
    }

    fun exists(relativePath: String): Boolean = runCatching {
        context.assets.open("web/${relativePath.trimStart('/')}").close()
    }.isSuccess

    /**
     * viewer.html with: the touch overrides stylesheet, the fullscreen bootstrap
     * globals (iOS CSS adapter off: Android uses WebChromeClient fullscreen), and
     * the chrome API shim module placed before viewer.js.
     */
    fun viewerHTML(): String {
        var html = text("viewer.html")
        html = replaceOnce(
            html,
            """<link rel="stylesheet" href="viewer.css">""",
            """<link rel="stylesheet" href="viewer.css">""" + "\n" +
                """    <link rel="stylesheet" href="ios-web/ios-overrides.css">"""
        )
        html = replaceOnce(
            html,
            """<meta name="viewport" content="width=device-width, initial-scale=1">""",
            """<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">"""
        )
        html = replaceOnce(
            html,
            """<script type="module" src="viewer.js"></script>""",
            "<script>$fullscreenBootstrap</script>\n" +
                """    <script type="module" src="ios-web/chrome-shim.js"></script>""" + "\n" +
                """    <script type="module" src="viewer.js"></script>"""
        )
        return html
    }

    /** Page-world script for chzzk.naver.com frames (the top viewer document is skipped). */
    fun chzzkPageScript(): String {
        val main = text("content/chzzk-main.js")
        val sessionAccess = text("ios-web/session-access-frame.js")
        val css = text("content/chzzk-embed.css")
        return """
            (() => {
              if (location.hostname !== "chzzk.naver.com" || window.self === window.top) return;
              globalThis.__stellaViewViewerOrigin = ${jsString(WrapperConfig.VIEWER_ORIGIN)};
              globalThis.__stellaViewChzzkStatusURL = ${jsString(WrapperConfig.CHZZK_USER_STATUS_URL)};
              globalThis.__stellaViewManagedFrame = window.self !== window.top &&
                /^\/(?:live|video)\//.test(location.pathname) && !/\/chat\/?$/.test(location.pathname);
              try {
                const style = document.createElement("style");
                style.id = "sv-embed-style";
                style.textContent = ${jsString(css)};
                (document.head || document.documentElement).append(style);
              } catch {}
            $main
            $sessionAccess
            })();
        """.trimIndent()
    }

    /** Page-world script for YouTube embed frames: per-tile volume via the viewer's message. */
    fun youtubeVolumeFrameScript(): String {
        val script = text("content/youtube-volume-frame.js")
        return """
            (() => {
              if (location.hostname !== "www.youtube.com" || window.self === window.top) return;
              globalThis.__stellaViewViewerOrigin = ${jsString(WrapperConfig.VIEWER_ORIGIN)};
            $script
            })();
        """.trimIndent()
    }

    /** Extension content script that relays pointer activity; needs chrome.runtime.getURL only. */
    fun frameActivityScript(): String {
        val script = text("content/frame-activity.js")
        val base = jsString(WrapperConfig.VIEWER_ORIGIN + "/")
        return """
            (function (chrome) {
            $script
            })({ runtime: { getURL: (path) => new URL(path, $base).href } });
        """.trimIndent()
    }

    private val fullscreenBootstrap: String
        get() = "globalThis.__stellaViewIOSFullscreenAdapter = false;" +
            "globalThis.__stellaViewFullscreenParentOrigin = ${jsString(WrapperConfig.VIEWER_ORIGIN)};"

    private fun replaceOnce(html: String, marker: String, replacement: String): String {
        val index = html.indexOf(marker)
        if (index < 0) throw AssetError("viewer.html에서 교체 지점을 찾지 못했습니다: $marker")
        return html.substring(0, index) + replacement + html.substring(index + marker.length)
    }

    companion object {
        /** JSON encoding doubles as a JS string literal. */
        fun jsString(value: String): String = JSONObject.quote(value)

        fun mimeType(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "png" -> "image/png"
            "svg" -> "image/svg+xml"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
    }
}
