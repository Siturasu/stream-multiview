package dev.siturasu.streammultiview

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.addCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** Sites the user can sign in to (same URLs as ios/Sources/Core/LoginWebViewFactory.swift). */
private enum class LoginDestination(val url: String) {
    CHZZK("https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fchzzk.naver.com%2F"),
    YOUTUBE("https://accounts.google.com/ServiceLogin?service=youtube&hl=ko&continue=https%3A%2F%2Fwww.youtube.com%2F"),
}

/**
 * In-app login (mirrors ios/Sources/App/LoginScreen.swift). Its WebView shares
 * the app-wide CookieManager jar with the viewer, so cookies from a top-level
 * Naver/Google sign-in are there for the chzzk and YouTube frames afterwards.
 *
 * This is a real browser session: navigation is never blocked, and popups
 * (target=_blank / window.open, used by Naver's find-id and some Google steps)
 * are folded back into the same WebView instead of being handed to the system
 * browser, where the cookies would land outside the app.
 *
 * The activity declares configChanges in the manifest, so a rotation or a
 * Samsung DeX window resize only relayouts the WebView held in `webView`.
 */
class LoginActivity : AppCompatActivity(), WebViewCompat.WebMessageListener {
    private lateinit var webViewContainer: FrameLayout
    private lateinit var versionLabel: TextView
    private lateinit var chzzkButton: Button
    private lateinit var youtubeButton: Button
    private lateinit var statusRow: View
    private lateinit var statusLabel: TextView
    private lateinit var recheckButton: Button
    private lateinit var errorLabel: TextView
    private lateinit var hintLabel: TextView
    private lateinit var diagnosticsToggle: Button
    private lateinit var diagnosticsBody: View
    private lateinit var diagnosticsText: TextView
    private lateinit var copyButton: Button

    private var webView: WebView? = null
    private var destination = LoginDestination.CHZZK
    private var status = ChzzkLoginStatus.WAITING
    private var probe: ChzzkLoginProbe? = null
    private var loadError: String? = null
    private var diagnosticsExpanded = false

    /** Bumped per check so a late answer from a previous page is discarded. */
    private var probeGeneration = 0
    private var probeHost: String? = null
    private var probeTimeout: Runnable? = null
    private var probeBridgeReady = false

    private var naverCookies: List<LoginDiagnostics.CookieNames>? = null
    private var youtubeCookieCount: Int? = null
    private var cookiesReadAt: Long? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setTitle(R.string.login_title)
        setContentView(R.layout.activity_login)
        CutoutPadding.apply(findViewById(android.R.id.content))

        webViewContainer = findViewById(R.id.web_view_container)
        versionLabel = findViewById(R.id.version_line)
        chzzkButton = findViewById(R.id.button_chzzk)
        youtubeButton = findViewById(R.id.button_youtube)
        statusRow = findViewById(R.id.status_row)
        statusLabel = findViewById(R.id.status_message)
        recheckButton = findViewById(R.id.button_recheck)
        errorLabel = findViewById(R.id.error_message)
        hintLabel = findViewById(R.id.hint_message)
        diagnosticsToggle = findViewById(R.id.diagnostics_toggle)
        diagnosticsBody = findViewById(R.id.diagnostics_body)
        diagnosticsText = findViewById(R.id.diagnostics_text)
        copyButton = findViewById(R.id.button_copy_diagnostics)

        // Which build is installed is the first thing a device report needs,
        // so it shows before a site is picked.
        versionLabel.text = WrapperConfig.versionLine(this)
        chzzkButton.setOnClickListener { select(LoginDestination.CHZZK) }
        youtubeButton.setOnClickListener { select(LoginDestination.YOUTUBE) }
        findViewById<Button>(R.id.button_done).setOnClickListener { finishLogin() }
        recheckButton.setOnClickListener { checkLogin(currentHost()) }
        diagnosticsToggle.setOnClickListener {
            diagnosticsExpanded = !diagnosticsExpanded
            render()
        }
        copyButton.setOnClickListener { copyDiagnostics() }
        findViewById<Button>(R.id.button_refresh_diagnostics).setOnClickListener {
            readCookies()
            checkLogin(currentHost())
        }

        createWebView()
        readCookies()
        render()

        // Back is the same commit as 완료: the cookies are already written.
        onBackPressedDispatcher.addCallback(this) { finishLogin() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val view = WebView(this)
        webViewContainer.addView(
            view,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        view.setBackgroundColor(Color.BLACK)

        val settings: WebSettings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.userAgentString = WrapperConfig.userAgent(this)
        WrapperConfig.applyDesktopClientHints(settings)
        WrapperConfig.installDesktopIdentityScript(view)
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportMultipleWindows(true)
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.allowFileAccess = false
        settings.allowContentAccess = false

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, true)
        }

        // The probe reports back through an origin-scoped listener: only
        // chzzk.naver.com frames ever see the JS object.
        probeBridgeReady = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (probeBridgeReady) {
            WebViewCompat.addWebMessageListener(view, PROBE_OBJECT_NAME, WrapperConfig.CHZZK_ORIGIN_RULES, this)
        }

        view.webViewClient = LoginWebViewClient()
        view.webChromeClient = LoginChromeClient()
        webView = view
        view.loadUrl(destination.url)
    }

    private fun select(next: LoginDestination) {
        if (destination == next) return
        destination = next
        cancelProbe()
        probe = null
        status = ChzzkLoginStatus.WAITING
        loadError = null
        webView?.loadUrl(next.url)
        render()
    }

    private fun finishLogin() {
        CookieManager.getInstance().flush()
        setResult(RESULT_OK)
        finish()
    }

    // MARK: CHZZK status probe

    private fun currentHost(): String? = webView?.url?.let { Uri.parse(it).host?.lowercase() }

    private fun cancelProbe() {
        probeGeneration += 1
        probeTimeout?.let { mainHandler.removeCallbacks(it) }
        probeTimeout = null
    }

    /**
     * Runs the same read-only check as CHZZK's own web app and keeps only its
     * status code and login boolean. Account identifiers, cookie values and the
     * rest of the response never cross the page-to-native boundary.
     */
    private fun checkLogin(host: String?) {
        cancelProbe()
        val view = webView ?: return
        if (destination != LoginDestination.CHZZK) {
            status = ChzzkLoginStatus.WAITING
            render()
            return
        }
        if (host != WrapperConfig.VIEWER_HOST) {
            // Recorded too: "still on the Naver login page" is itself the
            // answer when a user reports that nothing happens.
            status = ChzzkLoginStatus.WAITING
            probe = ChzzkLoginProbe(status, failure = "not-on-chzzk", pageHost = host)
            render()
            return
        }
        if (!probeBridgeReady) {
            status = ChzzkLoginStatus.UNAVAILABLE
            probe = ChzzkLoginProbe(status, failure = "bridge", pageHost = host)
            render()
            return
        }
        probeHost = host
        status = ChzzkLoginStatus.CHECKING
        render()
        view.evaluateJavascript(probeScript(probeGeneration), null)
        val generation = probeGeneration
        val timeout = Runnable {
            if (generation != probeGeneration) return@Runnable
            status = ChzzkLoginStatus.UNAVAILABLE
            probe = ChzzkLoginProbe(status, failure = "timeout", pageHost = probeHost)
            render()
        }
        probeTimeout = timeout
        mainHandler.postDelayed(timeout, PROBE_TIMEOUT_MS)
    }

    /** Answer of the probe script, on the UI thread. */
    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame || sourceOrigin.scheme != "https" || sourceOrigin.host != WrapperConfig.VIEWER_HOST) return
        val payload = runCatching { JSONObject(message.data ?: return) }.getOrNull() ?: return
        if (payload.optInt("generation", -1) != probeGeneration) return
        cancelProbe()

        val loggedIn = payload.boolOrNull("loggedIn")
        val ok = payload.optBoolean("ok", false)
        status = when {
            ok && loggedIn == true -> ChzzkLoginStatus.SIGNED_IN
            ok && loggedIn == false -> ChzzkLoginStatus.SIGNED_OUT
            else -> ChzzkLoginStatus.UNAVAILABLE
        }
        probe = ChzzkLoginProbe(
            status = status,
            httpStatus = payload.intOrNull("httpStatus"),
            apiCode = payload.intOrNull("apiCode"),
            loggedIn = loggedIn,
            failure = if (status == ChzzkLoginStatus.UNAVAILABLE) payload.stringOrNull("failure") ?: "schema" else null,
            pageHost = probeHost,
        )
        // The keep-signed-in hint compares the answer against the cookie jar.
        readCookies()
        render()
    }

    private fun probeScript(generation: Int): String = """
        (() => {
          const post = (payload) => {
            payload.generation = $generation;
            try { $PROBE_OBJECT_NAME.postMessage(JSON.stringify(payload)); } catch (error) {}
          };
          const probe = async () => {
            const controller = new AbortController();
            let timedOut = false;
            const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
            try {
              const response = await fetch(${WebAssets.jsString(WrapperConfig.CHZZK_USER_STATUS_URL)}, {
                method: "GET",
                credentials: "include",
                cache: "no-store",
                headers: { Accept: "application/json" },
                signal: controller.signal,
              });
              const httpStatus = response.status;
              if (!response.ok) return { ok: false, httpStatus, failure: "http-" + httpStatus };
              let payload = null;
              try {
                payload = await response.json();
              } catch (error) {
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
          };
          probe().then(post, () => post({ ok: false, failure: "fetch-error" }));
        })();
    """.trimIndent()

    // MARK: Diagnostics

    /** Names only. Values stay inside CookieManager and are never read. */
    private fun readCookies() {
        val manager = CookieManager.getInstance()
        naverCookies = NAVER_COOKIE_URLS.map { (label, url) ->
            LoginDiagnostics.CookieNames(label, LoginDiagnostics.cookieNames(manager.getCookie(url)))
        }
        youtubeCookieCount = LoginDiagnostics.cookieNames(manager.getCookie(YOUTUBE_COOKIE_URL)).size
        cookiesReadAt = System.currentTimeMillis()
    }

    private fun snapshot() = LoginDiagnostics.Snapshot(
        version = WrapperConfig.versionLine(this),
        device = "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) ${Build.MANUFACTURER} ${Build.MODEL}",
        webViewVersion = WebViewCompat.getCurrentWebViewPackage(this)?.versionName,
        probe = probe,
        naverCookies = naverCookies,
        youtubeCookieCount = youtubeCookieCount,
        cookiesReadAt = cookiesReadAt,
    )

    private fun copyDiagnostics() {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(
            ClipData.newPlainText(getString(R.string.login_diagnostics_clip_label), LoginDiagnostics.reportText(snapshot())),
        )
        copyButton.setText(R.string.login_diagnostics_copied)
        mainHandler.postDelayed({ copyButton.setText(R.string.login_diagnostics_copy) }, COPY_LABEL_RESET_MS)
    }

    // MARK: Rendering

    private fun render() {
        val snapshot = snapshot()
        styleDestination(chzzkButton, destination == LoginDestination.CHZZK)
        styleDestination(youtubeButton, destination == LoginDestination.YOUTUBE)

        statusRow.visibility = if (destination == LoginDestination.CHZZK) View.VISIBLE else View.GONE
        statusLabel.setText(statusMessage(status))
        statusLabel.setTextColor(if (status == ChzzkLoginStatus.SIGNED_IN) COLOR_OK else COLOR_SECONDARY)
        recheckButton.isEnabled = status != ChzzkLoginStatus.CHECKING
        recheckButton.alpha = if (recheckButton.isEnabled) 1f else 0.5f

        errorLabel.visibility = if (loadError == null) View.GONE else View.VISIBLE
        errorLabel.text = loadError.orEmpty()

        val showHint = destination == LoginDestination.CHZZK && LoginDiagnostics.needsKeepSignedInHint(snapshot)
        hintLabel.visibility = if (showHint) View.VISIBLE else View.GONE

        diagnosticsToggle.setText(
            if (diagnosticsExpanded) R.string.login_diagnostics_hide else R.string.login_diagnostics_show,
        )
        diagnosticsBody.visibility = if (diagnosticsExpanded) View.VISIBLE else View.GONE
        if (diagnosticsExpanded) diagnosticsText.text = LoginDiagnostics.reportText(snapshot)
    }

    private fun styleDestination(button: Button, selected: Boolean) {
        button.setBackgroundColor(if (selected) COLOR_SELECTED else COLOR_SURFACE)
        button.setTextColor(if (selected) Color.WHITE else COLOR_SECONDARY)
    }

    private fun statusMessage(status: ChzzkLoginStatus): Int = when (status) {
        ChzzkLoginStatus.WAITING -> R.string.login_status_waiting
        ChzzkLoginStatus.CHECKING -> R.string.login_status_checking
        ChzzkLoginStatus.SIGNED_IN -> R.string.login_status_signed_in
        ChzzkLoginStatus.SIGNED_OUT -> R.string.login_status_signed_out
        ChzzkLoginStatus.UNAVAILABLE -> R.string.login_status_unavailable
    }

    // MARK: WebView clients

    private inner class LoginWebViewClient : WebViewClient() {
        // A real sign-in walks through nid.naver.com, accounts.google.com and
        // their redirects: nothing here is off limits.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = false

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            loadError = null
            cancelProbe()
            status = ChzzkLoginStatus.WAITING
            render()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            checkLogin(url?.let { Uri.parse(it).host?.lowercase() })
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            // A cancelled load is what a redirect or a fast retap looks like.
            val description = error.description?.toString().orEmpty()
            if (description.contains("ERR_ABORTED", ignoreCase = true)) return
            loadError = getString(R.string.login_load_error, description.ifEmpty { error.errorCode.toString() })
            render()
        }
    }

    private inner class LoginChromeClient : WebChromeClient() {
        /**
         * Naver and Google open some steps with target=_blank. A popup window
         * would leave the user stranded, so the transport WebView only captures
         * the URL and the main login WebView loads it.
         */
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val capture = WebView(this@LoginActivity)
            capture.settings.javaScriptEnabled = true
            capture.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(inner: WebView, request: WebResourceRequest): Boolean {
                    webView?.loadUrl(request.url.toString())
                    inner.post { inner.destroy() }
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = capture
            resultMsg.sendToTarget()
            return true
        }
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        webView?.let {
            webViewContainer.removeView(it)
            it.destroy()
        }
        webView = null
        super.onDestroy()
    }

    private companion object {
        /** JS object injected into chzzk.naver.com frames for the probe answer. */
        const val PROBE_OBJECT_NAME = "stellaViewLoginProbe"

        /** Native backstop: the page timeout is 8 s, so anything past this is lost. */
        const val PROBE_TIMEOUT_MS = 10_000L
        const val COPY_LABEL_RESET_MS = 1_500L

        val NAVER_COOKIE_URLS = listOf(
            "chzzk.naver.com" to "https://chzzk.naver.com",
            "nid.naver.com" to "https://nid.naver.com",
        )
        const val YOUTUBE_COOKIE_URL = "https://www.youtube.com"

        val COLOR_SELECTED = 0xFF1F6FEB.toInt()
        val COLOR_SURFACE = 0xFF1C1C1E.toInt()
        val COLOR_SECONDARY = 0xFF9E9E9E.toInt()
        val COLOR_OK = 0xFF4CAF50.toInt()

        fun JSONObject.intOrNull(key: String): Int? = if (isNull(key)) null else optInt(key)
        fun JSONObject.boolOrNull(key: String): Boolean? = if (isNull(key)) null else optBoolean(key)
        fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }
    }
}
