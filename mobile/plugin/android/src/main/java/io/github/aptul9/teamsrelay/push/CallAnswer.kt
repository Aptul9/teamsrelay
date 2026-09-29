package io.github.aptul9.teamsrelay.push

import android.content.Context
import android.util.Log
import android.webkit.CookieManager
import org.json.JSONObject

// Answer on the notification of a ringing call, as Answer on the notification of the web app (public/sw.js): the relay
// queues the answer of that call (POST /api/call/answer with the session cookie of the web page) and its agent clicks
// Accept in Teams; the window then opens the account with call=1 and plays the sound of the call.
object CallAnswer {
    // Whether the relay took the answer: the call still rings there, and the session is the owner's
    fun post(context: Context, acc: Int, since: Long): Boolean {
        val origin = Store(context).relay
        if (origin.isEmpty() || acc <= 0 || since <= 0) return false
        val cookies = CookieManager.getInstance().getCookie(origin) ?: ""
        return try {
            val (status, body) = Registration.call("POST", "$origin/api/call/answer?a=$acc", cookies, JSONObject().put("since", since))
            if (status != 200) Log.w(TAG, "answer refused by the relay: HTTP $status $body")
            status == 200
        } catch (e: Exception) {
            Log.w(TAG, "answer: relay not reached: $e")
            false
        }
    }
}
