package dev.siturasu.streammultiview

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps content out of the display cutout (the Fold's cover-screen camera
 * hole) while the app draws edge-to-edge with the system bars hidden. The
 * cutout insets become padding on the given root view, so the viewer's top
 * bar and tile controls never sit under the punch hole; the video area loses
 * only that strip. System bars that the user swipes in temporarily overlay
 * the content and are not added.
 */
object CutoutPadding {
    fun apply(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            view.setPadding(cutout.left, cutout.top, cutout.right, cutout.bottom)
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }
}
