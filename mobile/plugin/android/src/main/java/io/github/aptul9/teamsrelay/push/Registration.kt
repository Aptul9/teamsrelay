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
// each return to the app and each new token; the relay answers with the key of the phone. Without a session there
// (signed out), it asks the relay to forget the phone.
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
        messaging.token.addOnSuccessListener { token -> thread { exchange(app, origin, token) } }
    }

    private fun exchange(context: Context, origin: String, token: String) {
        val store = Store(context)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: ""
        val signedIn = cookies.split(";").any { it.trim().substringBefore("=").endsWith("session_token") }
        try {
            if (signedIn) {
                val (status, body) = call("POST", "$origin/api/push/fcm", cookies, JSONObject().put("token", token).put("name", "${Build.MANUFACTURER} ${Build.MODEL}"))
                if (status == 200) {
                    store.key = JSONObject(body).getString("key")
                    store.token = token
                } else {
                    Log.w(TAG, "registration refused by the relay: HTTP $status")
                }
            } else if (store.token.isNotEmpty()) {
                val (status, _) = call("DELETE", "$origin/api/push/fcm", "", JSONObject().put("token", store.token))
                if (status == 200) store.token = ""
            }
        } catch (e: Exception) {
            Log.w(TAG, "relay not reached: $e")
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
