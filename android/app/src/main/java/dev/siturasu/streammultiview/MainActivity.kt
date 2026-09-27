package dev.siturasu.streammultiview

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Full-screen viewer. Keeps the screen on, hides the system bars, hosts HTML5
 * fullscreen, and reopens the viewer if the render process dies. Resizable and
 * config-change tolerant so folding/unfolding and Samsung DeX window changes
 * only relayout the WebView.
 */
class MainActivity : AppCompatActivity(), ViewerHost {
    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private var controller: ViewerWebViewController? = null
    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    private val loginLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        controller?.refreshStreamsAfterLogin()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        container = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(container)
        CutoutPadding.apply(container)
        hideSystemBars()
        createWebView()
        onBackPressedDispatcher.addCallback(this) {
            if (fullscreenView != null) fullscreenCallback?.onCustomViewHidden() else moveTaskToBack(true)
        }
    }

    private fun createWebView() {
        val view = WebView(this)
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val bridge = NativeBridge(this).apply {
            openLoginHandler = { loginLauncher.launch(Intent(this@MainActivity, LoginActivity::class.java)) }
        }
        val controller = ViewerWebViewController(this, view, WebAssets(this), bridge, this)
        controller.configure()
        if (!controller.documentStartScriptsSupported || !controller.messageListenerSupported) {
            showError("이 기기의 WebView가 너무 오래됐습니다. Play 스토어에서 Android System WebView를 업데이트해 주세요.")
        }
        controller.loadViewer()
        webView = view
        this.controller = controller
    }

    private fun showError(message: String) {
        val label = TextView(this).apply {
            text = message
            setTextColor(Color.WHITE)
            textSize = 16f
            setPadding(48, 48, 48, 48)
        }
        container.addView(label, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, container).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // MARK: ViewerHost

    override fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView?.visibility = View.GONE
        hideSystemBars()
    }

    override fun hideFullscreen() {
        fullscreenView?.let { container.removeView(it) }
        fullscreenView = null
        fullscreenCallback = null
        webView?.visibility = View.VISIBLE
        hideSystemBars()
    }

    override fun renderProcessGone() {
        webView?.let {
            container.removeView(it)
            it.destroy()
        }
        webView = null
        controller = null
        createWebView()
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
