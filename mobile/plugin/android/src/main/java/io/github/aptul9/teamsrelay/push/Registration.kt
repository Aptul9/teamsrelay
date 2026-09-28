package io.github.aptul9.teamsrelay.push

import android.content.Context
import android.os.Build
import android.util.Log
import android.webkit.CookieManager
import com.google.firebase.messaging.FirebaseMessaging
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import org.json.JSONObject

// The relay sends to this phone once it knows its Firebase token and whose phone it is. The web page cannot call the
// app, so the plugin posts the token itself with the session cookie of the page (POST /api/push/fcm), at each start,
// each return to the app, each sign-in or sign-out in its web page while it is on screen (PushPlugin) and each new
// token; the relay answers with the key of the phone. Without a session there (signed out, or a session the relay
// ended: signed out elsewhere, password changed), it asks the relay to forget the phone.
object Registration {
    fun sync(context: Context) {
        val app = context.applicationContext
        val origin = Store(app).relay
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
            .addOnSuccessListener { token -> thread { exchange(app, origin, token) } }
            .addOnFailureListener { e -> Log.w(TAG, "no Firebase token: $e") }
    }

    // The session cookie of the web page of the relay on this phone, "" without one: a sign-in after the relay ended the
    // session gets a new value under the same name
    fun session(context: Context): String {
        val origin = Store(context.applicationContext).relay
        if (origin.isEmpty()) return ""
        return (CookieManager.getInstance().getCookie(origin) ?: "").split(";").map { it.trim() }.firstOrNull { isSession(it) } ?: ""
    }

    private fun isSession(cookie: String) = cookie.substringBefore("=").endsWith("session_token")

    private fun hasSession(cookies: String) = cookies.split(";").any { isSession(it.trim()) }

    // The app changes server: the previous one forgets this phone (DELETE /api/push/fcm, the token is the proof), and its
    // key goes, so nothing it still sends opens here. A server that does not answer keeps sending: Firebase delivers,
    // the plugin drops those messages (no key of theirs).
    fun leave(context: Context, origin: String) {
        val store = Store(context.applicationContext)
        val token = store.token
        store.token = ""
        store.key = ""
        if (origin.isEmpty() || token.isEmpty()) return
        thread {
            try {
                val (status, _) = call("DELETE", "$origin/api/push/fcm", "", JSONObject().put("token", token))
                if (status != 200) Log.w(TAG, "previous server did not forget the phone: HTTP $status")
            } catch (e: Exception) {
                Log.w(TAG, "previous server not reached: $e")
            }
        }
    }

    private fun exchange(context: Context, origin: String, token: String) {
        val store = Store(context)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: ""
        try {
            if (hasSession(cookies)) {
                val (status, body) = call("POST", "$origin/api/push/fcm", cookies, JSONObject().put("token", token).put("name", "${Build.MANUFACTURER} ${Build.MODEL}"))
                // the app changed server meanwhile: this answer belongs to the previous one
                if (store.relay != origin) return
                when (status) {
                    200 -> {
                        store.key = JSONObject(body).getString("key")
                        store.token = token
                    }
                    // a session the relay ended (signed out elsewhere, password changed): as signed out
                    401, 403 -> forget(store, origin, token)
                    else -> Log.w(TAG, "registration refused by the relay: HTTP $status")
                }
            } else if (store.token.isNotEmpty()) {
                forget(store, origin, store.token)
            }
        } catch (e: Exception) {
            Log.w(TAG, "relay not reached: $e")
        }
    }

    // The relay forgets this phone, and its key goes: what it may still send is not opened. The app may have changed
    // server during the call: the key and token are then the next server's, and stay.
    private fun forget(store: Store, origin: String, token: String) {
        val (status, _) = call("DELETE", "$origin/api/push/fcm", "", JSONObject().put("token", token))
        if (status != 200) {
            Log.w(TAG, "the relay did not forget the phone: HTTP $status")
        } else if (store.relay == origin) {
            store.token = ""
            store.key = ""
        }
    }

    private fun call(method: String, url: String, cookies: String, body: JSONObject): Pair<Int, String> {
        val u = URL(url)
        val c = u.openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 15_000
            c.readTimeout = 15_000
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("Origin", "${u.protocol}://${u.authority}")
            if (cookies.isNotEmpty()) c.setRequestProperty("Cookie", cookies)
            c.outputStream.use { it.write(body.toString().toByteArray()) }
            val status = c.responseCode
            val text = (if (status < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return status to text
        } finally {
            c.disconnect()
        }
    }
}
