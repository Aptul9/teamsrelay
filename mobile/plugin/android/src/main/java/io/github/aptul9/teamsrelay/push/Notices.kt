package io.github.aptul9.teamsrelay.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject

// How the messages of the relay show on the phone. What each one shows is decided by the shared Rust (Core.notice,
// mobile/core/src/notice.rs), drawn here: a call that rings has one notification per account on the Calls channel,
// whose sound is the ringtone of the phone, repeated (FLAG_INSISTENT) until the call ends, the notification is tapped
// or the shade opened, and at most RING_FOR; once it ends a quiet notification says who called. A chat keeps one
// notification with its newest message; each relay alert (sign-in needed, check results, a missed call a check found)
// has one of its own.
object Notices {
    const val CALLS = "calls"
    const val CALLS_ENDED = "calls_ended"
    const val MESSAGES = "messages"
    const val ALERTS = "alerts"

    // the relay pushes a call for a minute at most while it rings (app/src/agent/logic/calls.ts)
    const val RING_FOR = 65_000L
    private const val CALL_TAG = "call"
    // the time the message of a chat notification was sent, kept in it
    private const val EXTRA_TS = "io.github.aptul9.teamsrelay.ts"

    // A channel keeps the sound it was created with: the user changes it in the Android settings of the app
    fun channels(context: Context) {
        val ringtone = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val calls = NotificationChannel(CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A Teams call ringing: the ringtone repeats until the call ends"
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), ringtone)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 800)
        }
        val ended = NotificationChannel(CALLS_ENDED, "Calls ended", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Who called, once the call stopped ringing"
        }
        val messages = NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "New Teams messages, one notification per chat"
        }
        val alerts = NotificationChannel(ALERTS, "TeamsRelay", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Sign-in needed, results of the checks, missed calls found by a check"
        }
        manager(context).createNotificationChannels(listOf(calls, ended, messages, alerts))
    }

    // plan: what Core.notice decided
    fun show(context: Context, plan: JSONObject) {
        val acc = plan.optInt("acc")
        val title = plan.optString("title")
        val body = plan.optString("body")
        when (plan.optString("show")) {
            "ring" -> ring(context, acc, title, body, plan.optLong("since"), plan.optBoolean("answer"))
            "ended" -> ended(context, acc, title, body, plan.optLong("since"))
            "message" -> message(context, plan.optString("tag"), acc, title, body, plan.optLong("ts"), plan.optBoolean("again"))
            "alert" -> alert(context, acc, title, body)
            else -> Log.i(TAG, "nothing shown: ${plan.optString("why")}")
        }
    }

    // The notifications of the app on screen, for Core.notice: the text and the time of the newest message of a chat
    // are the ones there, nothing of the chats is kept on the phone
    fun shown(context: Context): String =
        JSONArray(
            manager(context).activeNotifications.map {
                JSONObject()
                    .put("tag", it.tag ?: "")
                    .put("ts", it.notification.extras.getLong(EXTRA_TS))
                    .put("text", it.notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: "")
            },
        ).toString()

    fun alert(context: Context, acc: Int, title: String, body: String) {
        val n = builder(context, ALERTS, acc, title, body).setStyle(NotificationCompat.BigTextStyle().bigText(body)).build()
        manager(context).notify("alert", (System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
    }

    // A call of an account that can take it from the app (answer) offers Answer, which takes it in the app (PushPlugin)
    private fun ring(context: Context, acc: Int, title: String, body: String, since: Long, answer: Boolean) {
        val b = builder(context, CALLS, acc, title, body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setTimeoutAfter(RING_FOR)
            .setWhen(since)
        if (answer) b.addAction(0, "Answer", answer(context, acc, since))
        val n = b.build()
        n.flags = n.flags or Notification.FLAG_INSISTENT
        manager(context).notify(CALL_TAG, acc, n)
    }

    // Answer taken in the app: the ringtone stops at once, and pushes of the ring still on their way change nothing; the
    // end of the call from the relay replaces the notification
    fun stopRing(context: Context, acc: Int, since: Long) {
        Core.stopRing(acc, since)
        manager(context).cancel(CALL_TAG, acc)
    }

    // Cancelling the ringing notification stops its sound; the quiet one takes its place
    private fun ended(context: Context, acc: Int, title: String, body: String, since: Long) {
        val nm = manager(context)
        nm.cancel(CALL_TAG, acc)
        nm.notify(CALL_TAG, acc, builder(context, CALLS_ENDED, acc, title, body).setWhen(since).build())
    }

    // A chat shows its newest message, with the time it was sent (ts); again: the same text as on screen, which does
    // not alert
    private fun message(context: Context, tag: String, acc: Int, title: String, body: String, ts: Long, again: Boolean) {
        val b = builder(context, MESSAGES, acc, title, body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setOnlyAlertOnce(again)
            .addExtras(Bundle().apply { putLong(EXTRA_TS, ts) })
        if (ts > 0) b.setWhen(ts).setShowWhen(true)
        manager(context).notify(tag, 0, b.build())
    }

    private fun builder(context: Context, channel: String, acc: Int, title: String, body: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_teamsrelay)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open(context, acc))

    // A tap opens the app on the account the notification comes from (acc: its slot on the relay)
    private fun open(context: Context, acc: Int): PendingIntent {
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_ACC, acc)
        }
        return PendingIntent.getActivity(context, acc, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // Answer opens the app, or brings it to the front, with the call to take: its account and when it started ringing
    private fun answer(context: Context, acc: Int, since: Long): PendingIntent {
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).apply {
            action = ACTION_ANSWER
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_ACC, acc)
            putExtra(EXTRA_SINCE, since)
        }
        return PendingIntent.getActivity(context, acc, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
}
