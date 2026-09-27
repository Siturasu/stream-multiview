package dev.siturasu.streammultiview

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Outcome of one CHZZK status check (mirrors ios/Sources/Core/LoginWebViewFactory.swift). */
enum class ChzzkLoginStatus {
    WAITING,
    CHECKING,
    SIGNED_IN,
    SIGNED_OUT,
    UNAVAILABLE;

    /**
     * Short identifier for the diagnostics report, separate from the user
     * message so the wording can change without breaking a pasted report.
     */
    val code: String
        get() = when (this) {
            WAITING -> "waiting"
            CHECKING -> "checking"
            SIGNED_IN -> "signedIn"
            SIGNED_OUT -> "signedOut"
            UNAVAILABLE -> "unavailable"
        }
}

/**
 * One status check with the detail needed to tell HTTP failures, schema
 * failures and a real signed-out answer apart. Carries no cookie value,
 * account identifier, response body or URL query string.
 */
data class ChzzkLoginProbe(
    val status: ChzzkLoginStatus,
    val httpStatus: Int? = null,
    val apiCode: Int? = null,
    val loggedIn: Boolean? = null,
    /** "not-on-chzzk", "fetch-error", "timeout", "http-<code>", "schema" or "bridge". */
    val failure: String? = null,
    val checkedAt: Long = System.currentTimeMillis(),
    /** Host only, never the path or query of the inspected page. */
    val pageHost: String? = null,
)

/**
 * Privacy-safe diagnostics for the in-app login screen (mirrors
 * ios/Sources/Core/LoginDiagnostics.swift).
 *
 * On a real phone we cannot tell which build is installed, which WebView is
 * behind it, or which login stage failed. This collects exactly that: version,
 * device, WebView package, what the CHZZK status probe answered and which
 * cookie names exist in the shared cookie jar.
 *
 * Cookie values, account identifiers, response bodies, headers and URL query
 * strings are never read here, so the whole report can be pasted into a chat.
 * Everything below is plain Kotlin: no Android types, so the format can be
 * exercised on the JVM.
 */
object LoginDiagnostics {
    /** Naver's session pair. Their absence means a top-level sign-in never landed here. */
    val LOGIN_COOKIE_NAMES = setOf("NID_AUT", "NID_SES")

    /** Cookie names read for one URL. Values never leave CookieManager. */
    data class CookieNames(val label: String, val names: List<String>)

    data class Snapshot(
        val version: String,
        /** "Android 15 (SDK 35) samsung SM-S928N". */
        val device: String? = null,
        /** versionName of the installed WebView package. */
        val webViewVersion: String? = null,
        val probe: ChzzkLoginProbe? = null,
        val naverCookies: List<CookieNames>? = null,
        /** Counted only. Listing Google cookie names adds nothing here. */
        val youtubeCookieCount: Int? = null,
        val cookiesReadAt: Long? = null,
    )

    /** "a=1; b=2" -> ["a", "b"]. The part after the first "=" is dropped unread. */
    fun cookieNames(cookieHeader: String?): List<String> =
        cookieHeader.orEmpty()
            .split(";")
            .mapNotNull { part -> part.substringBefore("=").trim().takeIf { it.isNotEmpty() } }
            .distinct()

    fun hasLoginCookies(snapshot: Snapshot): Boolean =
        snapshot.naverCookies?.any { row -> row.names.any { it in LOGIN_COOKIE_NAMES } } == true

    /**
     * The probe says signed in but NID_AUT/NID_SES are nowhere to be found:
     * the session lives only in memory, so "로그인 상태 유지" is what the user needs.
     */
    fun needsKeepSignedInHint(snapshot: Snapshot): Boolean =
        snapshot.probe?.status == ChzzkLoginStatus.SIGNED_IN &&
            snapshot.naverCookies != null &&
            !hasLoginCookies(snapshot)

    /**
     * One ordered list drives both the on-screen section and the copied text,
     * so what the user reads is what the user pastes.
     */
    fun lines(snapshot: Snapshot): List<String> {
        val lines = mutableListOf(snapshot.version)
        lines += "기기: ${snapshot.device ?: "확인 전"}"
        lines += "WebView: ${snapshot.webViewVersion ?: "확인 전"}"

        val probe = snapshot.probe
        if (probe == null) {
            lines += "상태: 아직 확인하지 않았습니다."
        } else {
            lines += "상태: ${probe.status.code} (${time(probe.checkedAt)})"
            lines += "응답: HTTP ${probe.httpStatus ?: "-"}" +
                ", code ${probe.apiCode ?: "-"}" +
                ", loggedIn ${probe.loggedIn ?: "-"}" +
                ", 실패 ${probe.failure ?: "-"}"
            lines += "페이지: ${probe.pageHost ?: "-"}"
        }

        val naver = snapshot.naverCookies
        if (naver == null) {
            lines += "쿠키: 아직 읽지 않았습니다."
        } else {
            lines += "네이버 쿠키 (${snapshot.cookiesReadAt?.let { time(it) } ?: "-"} 기준)"
            for (row in naver) {
                val names = row.names.joinToString(", ") { name ->
                    if (name in LOGIN_COOKIE_NAMES) "*$name" else name
                }
                lines += "  ${row.label}: ${names.ifEmpty { "없음" }}"
            }
            lines += "  이름만 표시합니다. Android는 HttpOnly, SameSite 같은 속성을 알려주지 않습니다."
            snapshot.youtubeCookieCount?.let { lines += "구글 쿠키: ${it}개 (www.youtube.com)" }
            if (needsKeepSignedInHint(snapshot)) {
                lines += "경고: 로그인은 확인됐는데 NID_AUT/NID_SES가 보이지 않습니다."
            }
        }

        return lines
    }

    fun reportText(snapshot: Snapshot): String = lines(snapshot).joinToString("\n")

    private fun time(millis: Long): String = TIME_FORMAT.format(Date(millis))

    private val TIME_FORMAT = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
}
