package io.github.aptul9.teamsrelay.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject

// How the messages of the relay show on the phone, the same content the web app's service worker gets (public/sw.js).
// A call that rings has one notification per account on the Calls channel, whose sound is the ringtone of the phone,
// repeated (FLAG_INSISTENT) until the call ends, the notification is tapped or the shade opened, and at most RING_FOR;
// once it ends a quiet notification says who called. A chat keeps one notification with its last lines; each relay
// alert (sign-in needed, check results, a missed call a check found) has one of its own.
object Notices {
    const val CALLS = "calls"
    const val CALLS_ENDED = "calls_ended"
    const val MESSAGES = "messages"
    const val ALERTS = "alerts"

    // the relay pushes a call for a minute at most while it rings (app/src/agent/logic/calls.ts)
    const val RING_FOR = 65_000L
    private const val LINES = 5
    private const val CALL_TAG = "call"

    // A channel keeps the sound it was created with: the user changes it in the Android settings of the app
    fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
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

    fun show(context: Context, d: JSONObject) {
        val acc = d.optInt("acc")
        when (d.optString("call")) {
            "ringing" -> ring(context, acc, d)
            "ended" -> ended(context, acc, d)
            else -> if (d.optString("tag").startsWith("chat-")) message(context, acc, d) else alert(context, acc, d.optString("title"), d.optString("body"))
        }
    }

    fun alert(context: Context, acc: Int, title: String, body: String) {
        val n = builder(context, ALERTS, acc, title, body).setStyle(NotificationCompat.BigTextStyle().bigText(body)).build()
        manager(context).notify("alert", (System.currentTimeMillis() % Int.MAX_VALUE).toInt(), n)
    }

    // A late message changes nothing: one of an older call, or a ringing one of a call already ended
    private fun ring(context: Context, acc: Int, d: JSONObject) {
        val store = Store(context)
        val since = d.optLong("ts")
        val (last, ended) = store.lastCall(acc)
        if (since < last || (since == last && ended)) return
        store.setLastCall(acc, since, false)
        val n = builder(context, CALLS, acc, d.optString("title"), d.optString("body"))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setTimeoutAfter(RING_FOR)
            .setWhen(since)
            .build()
        n.flags = n.flags or Notification.FLAG_INSISTENT
        manager(context).notify(CALL_TAG, acc, n)
    }

    // Cancelling the ringing notification stops its sound; the quiet one takes its place
    private fun ended(context: Context, acc: Int, d: JSONObject) {
        val store = Store(context)
        val since = d.optLong("ts")
        if (since < store.lastCall(acc).first) return
        store.setLastCall(acc, since, true)
        val nm = manager(context)
        nm.cancel(CALL_TAG, acc)
        nm.notify(CALL_TAG, acc, builder(context, CALLS_ENDED, acc, d.optString("title"), d.optString("body")).setWhen(since).build())
    }

    // The same line again (one message pushed twice) adds nothing and does not alert; a notification the user dismissed
    // starts over
    private fun message(context: Context, acc: Int, d: JSONObject) {
        val store = Store(context)
        val nm = manager(context)
        val tag = d.optString("tag")
        val body = d.optString("body")
        val shown = nm.activeNotifications.any { it.tag == tag }
        val before = if (shown) store.lines(tag) else emptyList()
        val again = body.isNotEmpty() && body in before
        val lines = if (again) before else (before + body).filter { it.isNotEmpty() }.takeLast(LINES)
        store.setLines(tag, lines)
        val style = NotificationCompat.InboxStyle()
        lines.forEach { style.addLine(it) }
        val n = builder(context, MESSAGES, acc, d.optString("title"), lines.lastOrNull() ?: "")
            .setStyle(style)
            .setOnlyAlertOnce(again)
            .build()
        nm.notify(tag, 0, n)
    }

    private fun builder(context: Context, channel: String, acc: Int, title: String, body: String): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_teamsrelay)
            .setContentTitle(title.ifEmpty { "TeamsRelay" })
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

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
}
