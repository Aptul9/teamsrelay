package io.github.aptul9.teamsrelay.push

import android.app.Activity
import android.content.Intent
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat

// The launcher shortcut Change server (long press on the app icon): it opens the app on the form of the start page with
// the address in use, also when the server does not answer or no longer lets the app in. A dynamic shortcut, published
// at each start: it brings back the running app (single top, clear top), where a static one always starts it again,
// and it needs no edit of the Android project that `tauri android init` generates.
object Shortcuts {
    private const val ID = "change-server"

    fun publish(activity: Activity) {
        val intent = Intent(activity, activity.javaClass)
            .setAction(ACTION_CHANGE_SERVER)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val shortcut = ShortcutInfoCompat.Builder(activity, ID)
            .setShortLabel("Server")
            .setLongLabel("Change server")
            .setIcon(IconCompat.createWithResource(activity, R.drawable.ic_shortcut_server))
            .setIntent(intent)
            .build()
        try {
            ShortcutManagerCompat.pushDynamicShortcut(activity, shortcut)
        } catch (e: Exception) {
            Log.w(TAG, "launcher shortcut not published: $e")
        }
    }
}
