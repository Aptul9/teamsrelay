package io.github.aptul9.teamsrelay.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

// Firebase hands over here each message of the relay, the app open or not, and a new token when it changes
class PushService : FirebaseMessagingService() {
    override fun onCreate() {
        super.onCreate()
        Core.load(this)
    }

    // Registration tokens are deprecated since firebase-messaging 25.1.0 in favour of installation IDs (onRegistered),
    // but the HTTP v1 guide to send to one device still addresses tokens (2026-09-27): tokens until it does not
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) {
        Registration.sync()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Notices.show(this, JSONObject(Core.notice(JSONObject(message.data as Map<*, *>).toString(), Notices.shown(this))))
    }

    // Firebase dropped messages it kept for the phone (too many while it was offline)
    override fun onDeletedMessages() {
        Notices.alert(this, 0, "TeamsRelay", "Some notifications were lost while the phone was offline: open TeamsRelay.")
    }
}

const val TAG = "TeamsRelay"
