package io.github.aptul9.teamsrelay.push

import android.util.Base64
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

// Firebase hands over here each message of the relay, the app open or not, and a new token when it changes
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Registration.sync(applicationContext)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        val key = Store(this).key
        if (d["v"] != "1" || key.isEmpty()) return
        try {
            Notices.show(this, JSONObject(Seal.open(b64(key), b64(d["iv"] ?: ""), b64(d["ct"] ?: ""))))
        } catch (e: Exception) {
            Log.w(TAG, "message of the relay not opened: $e")
        }
    }

    // Firebase dropped messages it kept for the phone (too many while it was offline)
    override fun onDeletedMessages() {
        Notices.alert(this, 0, "TeamsRelay", "Some notifications were lost while the phone was offline: open TeamsRelay.")
    }

    private fun b64(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}

const val TAG = "TeamsRelay"
