package dev.siturasu.streammultiview

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.View
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream

/** Host callbacks the activity provides (fullscreen surface, render-process recovery). */
interface ViewerHost {
    fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback)
    fun hideFullscreen()
    fun renderProcessGone()
}

/**
 * Configures the WebView that hosts the viewer (mirrors
 * ios/Sources/Core/ViewerWebViewController.swift):
 * - serves the viewer from assets under https://chzzk.naver.com/__stellaview/,
 * - injects the extension's content scripts into chzzk/YouTube frames at
 *   document start (page world), and the native bridge into the viewer,
 * - desktop Chrome UA, third-party cookies (Google cookies for YouTube frames),
 *   autoplay without gesture, HTML5 fullscreen through the activity.
 */
class ViewerWebViewController(
    private val activity: Activity,
    val webView: WebView,
    private val assets: WebAssets,
    val bridge: NativeBridge,
    private val host: ViewerHost,
) {
    val documentStartScriptsSupported: Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    val messageListenerSupported: Boolean =
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    fun configure() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.userAgentString = WrapperConfig.userAgent(activity)
        WrapperConfig.applyDesktopClientHints(settings)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportMultipleWindows(true)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        // Personal app: keep the DevTools socket so the harness can drive it.
        WebView.setWebContentsDebuggingEnabled(true)

        if (documentStartScriptsSupported) {
            WebViewCompat.addDocumentStartJavaScript(webView, assets.chzzkPageScript(), WrapperConfig.CHZZK_ORIGIN_RULES)
            WebViewCompat.addDocumentStartJavaScript(webView, assets.youtubeVolumeFrameScript(), WrapperConfig.YOUTUBE_ORIGIN_RULES)
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                assets.frameActivityScript(),
                WrapperConfig.CHZZK_ORIGIN_RULES + WrapperConfig.YOUTUBE_ORIGIN_RULES,
            )
        }
        if (messageListenerSupported) {
            WebViewCompat.addWebMessageListener(webView, WrapperConfig.NATIVE_OBJECT_NAME, WrapperConfig.CHZZK_ORIGIN_RULES, bridge)
        }

        webView.setBackgroundColor(Color.BLACK)
        webView.webViewClient = ViewerWebViewClient()
        webView.webChromeClient = ViewerChromeClient()
    }

    fun loadViewer() {
        webView.loadUrl(WrapperConfig.VIEWER_URL)
    }

    /** Reloads only the stream/chat frames after an in-app login (same JS as iOS). */
    fun refreshStreamsAfterLogin() {
        webView.evaluateJavascript(REFRESH_AFTER_LOGIN_JS, null)
    }

    private fun openExternally(uri: Uri) {
        if (uri.scheme != "https" && uri.scheme != "http") return
        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
    }

    private fun isViewerAsset(uri: Uri): Boolean =
        uri.scheme == "https" && uri.host == WrapperConfig.VIEWER_HOST &&
            (uri.path ?: "").startsWith(WrapperConfig.VIEWER_PATH_PREFIX)

    private inner class ViewerWebViewClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if (!isViewerAsset(uri)) return null
            val relative = (uri.path ?: "").removePrefix(WrapperConfig.VIEWER_PATH_PREFIX)
            return try {
                val data = if (relative == "viewer.html") assets.viewerHTML().toByteArray(Charsets.UTF_8) else assets.bytes(relative)
                WebResourceResponse(
                    WebAssets.mimeType(relative), "utf-8", 200, "OK",
                    mapOf("Cache-Control" to "no-store"),
                    ByteArrayInputStream(data),
                )
            } catch (error: WebAssets.AssetError) {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            if (isViewerAsset(request.url)) return false
            // The main frame must stay on the composed viewer; hand everything else to the browser.
            openExternally(request.url)
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            host.renderProcessGone()
            return true
        }
    }

    private inner class ViewerChromeClient : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            host.showFullscreen(view, callback)
        }

        override fun onHideCustomView() {
            host.hideFullscreen()
        }

        // target=_blank / window.open: capture the URL and open it outside.
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val probe = WebView(activity)
            probe.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    openExternally(request.url)
                    view.destroy()
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = probe
            resultMsg.sendToTarget()
            return true
        }
    }

    companion object {
        val REFRESH_AFTER_LOGIN_JS = """
            (() => {
              const buttons = document.querySelectorAll('.tile-actions button[data-action="reload"]');
              buttons.forEach((button) => {
                const tile = button.closest('.stream-tile');
                if (tile?.dataset.key?.startsWith('youtube:')) {
                  const frame = tile.querySelector('.stream-frame');
                  if (frame) frame.src = frame.src;
                } else {
                  button.click();
                }
              });
              const chat = document.querySelector('#chat-frame');
              const chatSource = chat?.getAttribute('src');
              if (chatSource && chatSource !== 'about:blank') chat.src = chatSource;
              return buttons.length;
            })()
        """.trimIndent()
    }
}
