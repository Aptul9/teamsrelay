package io.github.aptul9.teamsrelay.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// the account a tapped notification opens, in the intent that starts the app
const val EXTRA_ACC = "io.github.aptul9.teamsrelay.acc"

@InvokeArg
class RelayArgs {
    lateinit var origin: String
}

// The window's side of the notifications. The bundled start page, the only page allowed to call it, hands over the
// address of the relay (relay) and asks which account a notification tapped at launch opens (opened); a notification
// tapped while the app runs opens its account in the window at once. Android 13 and later: the notification
// permission is asked at first start.
@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var opened = 0

    override fun load(webView: WebView) {
        this.webView = webView
        Notices.channels(activity)
        opened = accountOf(activity.intent)
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
        }
        Registration.sync(activity)
    }

    override fun onNewIntent(intent: Intent) {
        val acc = accountOf(intent)
        val origin = Store(activity).relay
        if (acc > 0 && origin.isNotEmpty()) webView?.post { webView?.loadUrl("$origin/?a=$acc") }
    }

    override fun onResume(activity: AppCompatActivity) {
        Registration.sync(activity)
    }

    @Command
    fun relay(invoke: Invoke) {
        val args = invoke.parseArgs(RelayArgs::class.java)
        Store(activity).relay = args.origin
        Registration.sync(activity)
        invoke.resolve()
    }

    @Command
    fun opened(invoke: Invoke) {
        val ret = JSObject()
        ret.put("acc", opened)
        opened = 0
        invoke.resolve(ret)
    }

    private fun accountOf(intent: Intent?): Int = intent?.getIntExtra(EXTRA_ACC, 0) ?: 0
}
