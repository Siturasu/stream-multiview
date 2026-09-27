package dev.siturasu.streammultiview

import android.content.Context
import android.webkit.WebSettings

/**
 * Fixed identity of the wrapped viewer page (mirrors ios/Sources/Core/ViewerConfiguration.swift).
 *
 * The viewer is served from app assets under https://chzzk.naver.com/__stellaview/ by
 * intercepting requests in the WebView. That gives the document the CHZZK origin:
 * Naver's login cookies (NID_AUT/NID_SES) are SameSite=Lax, which never reach a
 * cross-site iframe, so the stream frames must be same-site with the viewer. The
 * main frame never really navigates to chzzk.naver.com: every main-frame navigation
 * outside the viewer path is cancelled or handed to the system browser.
 */
object WrapperConfig {
    const val VIEWER_HOST = "chzzk.naver.com"
    const val VIEWER_ORIGIN = "https://$VIEWER_HOST"
    const val VIEWER_PATH_PREFIX = "/__stellaview/"
    const val VIEWER_URL = "$VIEWER_ORIGIN${VIEWER_PATH_PREFIX}viewer.html"

    /** JS object name injected by WebViewCompat.addWebMessageListener (see chrome-shim.js). */
    const val NATIVE_OBJECT_NAME = "stellaViewNative"

    /** Same read-only endpoint CHZZK's own web app uses for the login boolean. */
    const val CHZZK_USER_STATUS_URL = "https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus"

    /** Hosts the viewer page may fetch through the native bridge. */
    val NATIVE_FETCH_HOSTS = setOf("api.chzzk.naver.com", "www.youtube.com")

    const val REQUEST_TIMEOUT_MS = 12_000
    const val MAX_RESPONSE_BYTES = 4_000_000

    /** Origins that receive the document-start scripts and, for the viewer, the bridge. */
    val CHZZK_ORIGIN_RULES = setOf("https://chzzk.naver.com")
    val YOUTUBE_ORIGIN_RULES = setOf("https://www.youtube.com")

    /**
     * Desktop Chrome identity built from the installed WebView's own Chromium version.
     * The default WebView UA carries "; wv" and "Mobile": CHZZK redirects any UA
     * containing "mobile" to m.chzzk.naver.com (360p, no quality preference key) and
     * Google refuses sign-in inside a WebView it can recognise.
     */
    fun userAgent(context: Context): String {
        val default = runCatching { WebSettings.getDefaultUserAgent(context) }.getOrDefault("")
        val chromeMajor = Regex("""Chrome/(\d+)""").find(default)?.groupValues?.get(1) ?: "140"
        return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/$chromeMajor.0.0.0 Safari/537.36"
    }

    /**
     * A custom UA string does not change the UA client hints WebView sends
     * (Sec-CH-UA brands, Sec-CH-UA-Mobile, Sec-CH-UA-Platform) nor the JS
     * navigator.userAgentData. The defaults still carry an "Android WebView"
     * brand and mobile=?1, which is exactly what Google's sign-in uses to
     * refuse embedded web views ("이 브라우저 또는 앱은 안전하지 않을 수 있습니다").
     * Present the same desktop Chrome identity as the UA string, and stop the
     * X-Requested-With header (older WebViews add the package name to every
     * request; newer ones only for allowlisted origins).
     */
    fun applyDesktopClientHints(settings: WebSettings) {
        val chromeMajor = Regex("""Chrome/(\d+)""").find(settings.userAgentString ?: "")?.groupValues?.get(1) ?: "140"
        if (androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.USER_AGENT_METADATA)) {
            runCatching {
                val fullVersion = "$chromeMajor.0.0.0"
                fun brand(name: String, major: String, full: String) =
                    androidx.webkit.UserAgentMetadata.BrandVersion.Builder()
                        .setBrand(name).setMajorVersion(major).setFullVersion(full).build()
                val metadata = androidx.webkit.UserAgentMetadata.Builder()
                    .setBrandVersionList(
                        listOf(
                            brand("Chromium", chromeMajor, fullVersion),
                            brand("Google Chrome", chromeMajor, fullVersion),
                            brand("Not-A.Brand", "24", "24.0.0.0"),
                        )
                    )
                    .setFullVersion(fullVersion)
                    .setPlatform("Linux")
                    .setPlatformVersion("6.6.0")
                    .setArchitecture("x86")
                    .setBitness(64)
                    .setModel("")
                    .setMobile(false)
                    .setWow64(false)
                    .build()
                androidx.webkit.WebSettingsCompat.setUserAgentMetadata(settings, metadata)
            }
        }
        val allowListSupported = androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)
        if (allowListSupported) {
            val result = runCatching { androidx.webkit.WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet()) }
            val current = runCatching { androidx.webkit.WebSettingsCompat.getRequestedWithHeaderOriginAllowList(settings) }.getOrNull()
            android.util.Log.i("StreamMultiview", "X-Requested-With allowlist set=${result.isSuccess} now=$current")
        } else {
            android.util.Log.i("StreamMultiview", "X-Requested-With allowlist unsupported by this WebView")
        }
    }

    /**
     * Google's sign-in refuses embedded web views ("browser or app may not be
     * secure"). Beyond the UA string and client hints, its page script reads
     * navigator/window properties that still look like a WebView: no
     * window.chrome object, "Linux aarch64" platform, touch points. This
     * document-start script, injected only into the login WebView for Google
     * origins, presents the corresponding desktop Chrome values.
     */
    val DESKTOP_IDENTITY_ORIGIN_RULES = setOf("https://accounts.google.com", "https://*.google.com", "https://www.youtube.com")

    val desktopIdentityScript: String = """
        (() => {
          const define = (target, name, value) => {
            try { Object.defineProperty(target, name, { get: () => value, configurable: true }); } catch {}
          };
          define(navigator, "platform", "Linux x86_64");
          define(navigator, "maxTouchPoints", 0);
          define(navigator, "pdfViewerEnabled", true);
          try { delete Window.prototype.ontouchstart; } catch {}
          try { delete window.ontouchstart; } catch {}
          try { delete Window.prototype.orientation; } catch {}
          try { delete window.orientation; } catch {}
          if (typeof window.chrome !== "object") {
            const chrome = {
              app: {
                isInstalled: false,
                InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
                RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
                getDetails() { return null; },
                getIsInstalled() { return false; },
              },
              runtime: {
                OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
                PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
                PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
                RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
                connect() {}, sendMessage() {},
              },
              csi() { return {}; },
              loadTimes() { return {}; },
            };
            try { Object.defineProperty(window, "chrome", { value: chrome, configurable: true, writable: true }); } catch {}
          }
        })();
    """.trimIndent()

    fun installDesktopIdentityScript(webView: android.webkit.WebView) {
        if (!androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.DOCUMENT_START_SCRIPT)) return
        runCatching { androidx.webkit.WebViewCompat.addDocumentStartJavaScript(webView, desktopIdentityScript, DESKTOP_IDENTITY_ORIGIN_RULES) }
    }

    /** "Stream Multiview 0.1.0 (1)" for the installed build. */
    fun versionLine(context: Context): String {
        val info = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0)
        }.getOrNull()
        val name = info?.versionName ?: "?"
        val code = info?.longVersionCode ?: 0L
        return "Stream Multiview $name ($code)"
    }
}
