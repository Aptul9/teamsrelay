package io.github.aptul9.teamsrelay.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

// How the messages of the relay show on the phone. What each one shows is decided by the shared Rust (Core.notice,
// mobile/core/src/notice.rs), drawn here: a call that rings has one notification per account on the Calls channel,
// full screen over the lock screen (CallActivity), whose sound is the ringtone of the phone, repeated (FLAG_INSISTENT) until the call ends, the notification is tapped
// or the shade opened, and at most RING_FOR; once it ends a quiet notification says who called. A chat keeps one
// notification with its newest message; each relay alert (sign-in needed, check results, a missed call a check found)
// has one of its own. Each one shows the logo of the company of its account, and where the owner has more than one
// account its name and tint, the notifications of one account bundled together (a call that rings apart).
object Notices {
    const val CALLS = "calls"
    const val CALLS_ENDED = "calls_ended"
    const val MESSAGES = "messages"
    const val ALERTS = "alerts"

    // the relay pushes a call for a minute at most while it rings (app/src/agent/logic/calls.ts)
    const val RING_FOR = 65_000L
    private const val CALL_TAG = "call"
    // the summary of the notifications of an account, one per account (id: the account)
    private const val GROUP_TAG = "group"
    // size of a logo or mark, px
    private const val ICON = 128
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

    // The account a notification is for, as drawn: its organization (sub-text, tint and bundle, where the owner has
    // more than one account) and the logo of its company, or in its place a mark with the initials of the organization
    private class Account(val org: String, val tint: Int, val logo: Bitmap?)

    // plan: what Core.notice decided. Off the main thread: the logo of an account not seen yet is loaded from the server.
    fun show(context: Context, plan: JSONObject) {
        val acc = plan.optInt("acc")
        val title = plan.optString("title")
        val body = plan.optString("body")
        val account = plan.optJSONObject("account")?.let { account(context, acc, it) }
        when (plan.optString("show")) {
            "ring" -> ring(context, acc, title, body, plan.optLong("since"), plan.optBoolean("answer"), account)
            "ended" -> ended(context, acc, title, body, plan.optLong("since"), account)
            "message" -> message(context, plan.optString("tag"), acc, title, body, plan.optLong("ts"), plan.optBoolean("again"), account)
            "alert" -> alert(context, acc, title, body, account)
            else -> Log.i(TAG, "nothing shown: ${plan.optString("why")}")
        }
    }

    private fun account(context: Context, acc: Int, a: JSONObject): Account {
        val org = a.optString("org")
        val tint = Color.HSVToColor(floatArrayOf(a.optInt("hue").toFloat(), 0.6f, 0.7f))
        val logo = logo(context, acc, a.optString("logo")) ?: if (org.isNotEmpty()) mark(tint, a.optString("initials")) else null
        return Account(org, tint, logo)
    }

    // The logo of the company of an account, kept in the cache of the app once loaded (a new logo comes under a new name)
    private fun logo(context: Context, acc: Int, file: String): Bitmap? {
        if (file.isEmpty()) return null
        val cached = File(context.cacheDir, "logos/$file")
        val bytes =
            if (cached.exists()) cached.readBytes()
            else Core.relay().takeIf { it.isNotEmpty() }?.let { Core.picture(it, Registration.cookies(it), acc, file) } ?: ByteArray(0)
        val image = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
        if (!cached.exists()) {
            cached.parentFile?.mkdirs()
            cached.writeBytes(bytes)
        }
        return round(image)
    }

    // The logo inside a white disc: the logos of the sign-in pages of Microsoft are drawn for white
    private fun round(image: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(ICON, ICON, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply { color = Color.WHITE }
        c.drawCircle(ICON / 2f, ICON / 2f, ICON / 2f, paint)
        c.clipPath(Path().apply { addCircle(ICON / 2f, ICON / 2f, ICON / 2f, Path.Direction.CW) })
        val inset = ICON * 0.1f
        c.drawBitmap(image, null, RectF(inset, inset, ICON - inset, ICON - inset), paint)
        return out
    }

    // The initials of the organization on its tint, where its company has no logo
    private fun mark(tint: Int, initials: String): Bitmap {
        val out = Bitmap.createBitmap(ICON, ICON, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = tint }
        c.drawCircle(ICON / 2f, ICON / 2f, ICON / 2f, paint)
        paint.color = Color.WHITE
        paint.textAlign = Paint.Align.CENTER
        paint.textSize = ICON * 0.4f
        paint.typeface = Typeface.DEFAULT_BOLD
        c.drawText(initials, ICON / 2f, ICON / 2f - (paint.ascent() + paint.descent()) / 2, paint)
        return out
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

    fun alert(context: Context, acc: Int, title: String, body: String) = alert(context, acc, title, body, null)

    private fun alert(context: Context, acc: Int, title: String, body: String, account: Account?) {
        val b = builder(context, ALERTS, acc, title, body, account).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        manager(context).notify("alert", (System.currentTimeMillis() % Int.MAX_VALUE).toInt(), b.build())
        summary(context, ALERTS, acc, account)
    }

    // A call rings full screen over the lock screen (CallActivity) where the phone is locked or its screen off, as a
    // heads-up notification while it is in use, or as that alone where Android does not let the app (Android 14 and
    // later, see PushPlugin). One of an account that can take it from the app (answer) is an incoming call with Answer,
    // which takes it in the app (PushPlugin), and Decline, which silences this phone only
    private fun ring(context: Context, acc: Int, title: String, body: String, since: Long, answer: Boolean, account: Account?) {
        val onDecline = decline(context, acc, since)
        val b = builder(context, CALLS, acc, title, body, account).setGroup(null)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setTimeoutAfter(RING_FOR)
            .setWhen(since)
            .setFullScreenIntent(screen(context, acc, title, body, since, answer), true)
        if (answer) {
            // the logo in place of a picture of the caller; the name of the account where the call style shows sub-text
            val caller = Person.Builder().setName(title).apply { account?.logo?.let { setIcon(IconCompat.createWithBitmap(it)) } }.build()
            val style = NotificationCompat.CallStyle.forIncomingCall(caller, onDecline, answer(context, acc, since))
            account?.org?.takeIf { it.isNotEmpty() }?.let { style.setVerificationText(it) }
            b.setStyle(style)
        } else b.addAction(0, "Decline", onDecline)
        val n = b.build()
        n.flags = n.flags or Notification.FLAG_INSISTENT
        manager(context).notify(CALL_TAG, acc, n)
    }

    // Whether the call of the account still rings: its notification on the Calls channel is on screen
    fun ringing(context: Context, acc: Int): Boolean =
        manager(context).activeNotifications.any { it.tag == CALL_TAG && it.id == acc && it.notification.channelId == CALLS }

    // Answer taken in the app: the ringtone stops at once, and pushes of the ring still on their way change nothing; the
    // end of the call from the relay replaces the notification
    fun stopRing(context: Context, acc: Int, since: Long) {
        Core.stopRing(acc, since)
        manager(context).cancel(CALL_TAG, acc)
    }

    // Cancelling the ringing notification stops its sound; the quiet one takes its place
    private fun ended(context: Context, acc: Int, title: String, body: String, since: Long, account: Account?) {
        val nm = manager(context)
        nm.cancel(CALL_TAG, acc)
        nm.notify(CALL_TAG, acc, builder(context, CALLS_ENDED, acc, title, body, account).setWhen(since).build())
        summary(context, CALLS_ENDED, acc, account)
    }

    // A chat shows its newest message, with the time it was sent (ts); again: the same text as on screen, which does
    // not alert
    private fun message(context: Context, tag: String, acc: Int, title: String, body: String, ts: Long, again: Boolean, account: Account?) {
        val b = builder(context, MESSAGES, acc, title, body, account)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setOnlyAlertOnce(again)
            .addExtras(Bundle().apply { putLong(EXTRA_TS, ts) })
        if (ts > 0) b.setWhen(ts).setShowWhen(true)
        manager(context).notify(tag, 0, b.build())
        summary(context, MESSAGES, acc, account)
    }

    private fun builder(context: Context, channel: String, acc: Int, title: String, body: String, account: Account? = null): NotificationCompat.Builder {
        val b = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_teamsrelay)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open(context, acc))
        if (account == null) return b
        account.logo?.let { b.setLargeIcon(it) }
        if (account.org.isNotEmpty()) b.setSubText(account.org).setColor(account.tint).setGroup(group(acc))
        return b
    }

    private fun group(acc: Int) = "account-$acc"

    // The summary that bundles the notifications of an account where the owner has more than one, quiet: the
    // notifications in it alert. Posted after the one it bundles.
    private fun summary(context: Context, channel: String, acc: Int, account: Account?) {
        if (account == null || account.org.isEmpty()) return
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_teamsrelay)
            .setSubText(account.org)
            .setColor(account.tint)
            .setGroup(group(acc))
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setAutoCancel(true)
            .setContentIntent(open(context, acc))
            .build()
        manager(context).notify(GROUP_TAG, acc, n)
    }

    // A tap opens the app on the account the notification comes from (acc: its slot on the relay)
    private fun open(context: Context, acc: Int): PendingIntent {
        val intent = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_ACC, acc)
        }
        return PendingIntent.getActivity(context, acc, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // Answer opens the app, or brings it to the front, with the call to take: its account and when it started ringing
    fun answerIntent(context: Context, acc: Int, since: Long): Intent =
        (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).apply {
            action = ACTION_ANSWER
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_ACC, acc)
            putExtra(EXTRA_SINCE, since)
        }

    private fun answer(context: Context, acc: Int, since: Long): PendingIntent =
        PendingIntent.getActivity(context, acc, answerIntent(context, acc, since), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    // Decline: this phone stops ringing (DeclineReceiver)
    private fun decline(context: Context, acc: Int, since: Long): PendingIntent {
        val intent = Intent(context, DeclineReceiver::class.java).putExtra(EXTRA_ACC, acc).putExtra(EXTRA_SINCE, since)
        return PendingIntent.getBroadcast(context, acc, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    // The ring screen of the call (CallActivity), which Android opens itself
    private fun screen(context: Context, acc: Int, title: String, body: String, since: Long, answer: Boolean): PendingIntent {
        val intent = Intent(context, CallActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_ACC, acc)
            .putExtra(EXTRA_SINCE, since)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_BODY, body)
            .putExtra(EXTRA_ANSWER, answer)
        return PendingIntent.getActivity(context, acc, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
}
