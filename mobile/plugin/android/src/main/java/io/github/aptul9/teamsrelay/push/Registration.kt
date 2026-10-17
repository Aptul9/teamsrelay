package io.github.aptul9.teamsrelay.push

import android.os.Build
import android.util.Log
import android.webkit.CookieManager
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.concurrent.thread

// The relay sends to this phone once it knows its Firebase token and whose phone it is. The web page cannot call the
// app, so the plugin hands the token and the cookies of the page to the shared Rust (Core.sync, mobile/core/src/
// server.rs), which posts them to the relay, at each start, each return to the app, each sign-in or sign-out in its web
// page while it is on screen (PushPlugin) and each new token; signed out, the relay forgets the phone.
object Registration {
    fun sync() {
        val origin = Core.relay()
        if (origin.isEmpty()) return
        val messaging =
            try {
                FirebaseMessaging.getInstance()
            } catch (e: IllegalStateException) {
                Log.w(TAG, "Firebase is not configured in this build: no notifications")
                return
            }
        // the token API, deprecated since firebase-messaging 25.1.0: see PushService.onNewToken
        @Suppress("DEPRECATION")
        messaging.token
            .addOnSuccessListener { token -> thread { Core.sync(origin, token, cookies(origin), "${Build.MANUFACTURER} ${Build.MODEL}") } }
            .addOnFailureListener { e -> Log.w(TAG, "no Firebase token: $e") }
    }

    // The session cookie of the web page of the relay on this phone, "" without one: a sign-in after the relay ended the
    // session gets a new value under the same name
    fun session(): String = Core.session(cookies(Core.relay()))

    // The cookies of the web page of a relay, as the WebView keeps them
    fun cookies(origin: String): String = if (origin.isEmpty()) "" else CookieManager.getInstance().getCookie(origin) ?: ""
}
