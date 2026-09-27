package io.github.aptul9.teamsrelay.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
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

// the launcher shortcut Change server (Shortcuts.kt): the start page shows its form instead of opening the server
const val ACTION_CHANGE_SERVER = "io.github.aptul9.teamsrelay.CHANGE_SERVER"

@InvokeArg
class RelayArgs {
    lateinit var origin: String
    // the address of the start page itself, where the shortcut Change server brings the window back
    var page: String? = null
}

// The window's side of the notifications. The bundled start page, the only page allowed to call it, hands over the
// address of the relay (relay) and asks what started the app (opened): the account of a tapped notification, or the
// launcher shortcut Change server. While the app runs, a tapped notification opens its account in the window at once,
// and the shortcut brings back the start page with its form. While the app is on screen, a sign-in or a sign-out in
// its web page registers the phone or has it forgotten within WATCH_MS: a page of the server cannot call the app.
// Android 13 and later: the notification permission is asked at first start.
@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var opened = 0
    private var change = false
    private var startPage = ""
    private val main = Handler(Looper.getMainLooper())
    private var signedIn = false

    private val watch = object : Runnable {
        override fun run() {
            val now = Registration.signedIn(activity)
            if (now != signedIn) Registration.sync(activity)
            signedIn = now
            main.postDelayed(this, WATCH_MS)
        }
    }

    override fun load(webView: WebView) {
        this.webView = webView
        Notices.channels(activity)
        Shortcuts.publish(activity)
        // a task Android brings back from the recent apps comes with the intent that first started it: not asked again
        val intent = activity.intent?.takeIf { (it.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0 }
        opened = accountOf(intent)
        change = intent?.action == ACTION_CHANGE_SERVER
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
        }
        Registration.sync(activity)
    }

    override fun onNewIntent(intent: Intent) {
        if (intent.action == ACTION_CHANGE_SERVER) {
            change = true
            // a load of its own, not a jump to #change on the same page: an open still under way (a server that does
            // not answer) stops, and the form shows
            if (startPage.isNotEmpty()) webView?.post { webView?.loadUrl("$startPage?change=1#change") }
            return
        }
        val acc = accountOf(intent)
        val origin = Store(activity).relay
        if (acc > 0 && origin.isNotEmpty()) webView?.post { webView?.loadUrl("$origin/?a=$acc") }
    }

    override fun onResume(activity: AppCompatActivity) {
        // an activity created again (a change of font or display size) has a WebView of its own
        webViewIn(activity.window.decorView)?.let { webView = it }
        Registration.sync(activity)
        signedIn = Registration.signedIn(activity)
        main.removeCallbacks(watch)
        main.postDelayed(watch, WATCH_MS)
    }

    override fun onPause(activity: AppCompatActivity) {
        main.removeCallbacks(watch)
    }

    @Command
    fun relay(invoke: Invoke) {
        val args = invoke.parseArgs(RelayArgs::class.java)
        if (!args.page.isNullOrEmpty()) startPage = args.page ?: ""
        val store = Store(activity)
        // another server: the previous one forgets this phone
        if (store.relay != args.origin) Registration.leave(activity, store.relay)
        store.relay = args.origin
        Registration.sync(activity)
        invoke.resolve()
    }

    @Command
    fun opened(invoke: Invoke) {
        val ret = JSObject()
        ret.put("acc", opened)
        ret.put("change", change)
        opened = 0
        change = false
        invoke.resolve(ret)
    }

    private fun accountOf(intent: Intent?): Int = intent?.getIntExtra(EXTRA_ACC, 0) ?: 0

    private fun webViewIn(v: View): WebView? =
        when (v) {
            is WebView -> v
            is ViewGroup -> (0 until v.childCount).firstNotNullOfOrNull { webViewIn(v.getChildAt(it)) }
            else -> null
        }

    companion object {
        private const val WATCH_MS = 10_000L
    }
}
