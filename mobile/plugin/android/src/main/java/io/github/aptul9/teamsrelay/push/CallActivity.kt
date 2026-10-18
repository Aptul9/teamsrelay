package io.github.aptul9.teamsrelay.push

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView

// what the ring screen shows of the call, in the intent of the notification that opens it (Notices.ring)
const val EXTRA_TITLE = "io.github.aptul9.teamsrelay.title"
const val EXTRA_BODY = "io.github.aptul9.teamsrelay.body"
const val EXTRA_ANSWER = "io.github.aptul9.teamsrelay.answer"

// A ringing call full screen, over the lock screen too: Android opens it from the notification of the call (its
// full-screen intent, Notices.ring) while the phone is locked or its screen is off, and shows that notification as a
// heads-up one while the phone is in use. Who calls, Answer where the account can take the call from the app, and
// Decline, which silences this phone only: the server has no decline, Teams rings on elsewhere until the call ends. The
// notification goes on ringing meanwhile, and the screen closes once it is gone: the call ended, was answered or
// declined, or RING_FOR passed.
class CallActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private var acc = 0
    private var since = 0L

    private val watch = object : Runnable {
        override fun run() {
            if (Notices.ringing(this@CallActivity, acc)) main.postDelayed(this, 1000) else finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Core.load(this)
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        show(intent)
    }

    // another call rings while this screen is up: it shows that one
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        show(intent)
    }

    override fun onResume() {
        super.onResume()
        main.post(watch)
    }

    override fun onPause() {
        super.onPause()
        main.removeCallbacks(watch)
    }

    private fun show(intent: Intent) {
        acc = intent.getIntExtra(EXTRA_ACC, 0)
        since = intent.getLongExtra(EXTRA_SINCE, 0L)
        Log.i(TAG, "ring screen of the call of account $acc")
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(button("Decline", 0xFFD93F4C.toInt()) { decline() }, LinearLayout.LayoutParams(0, dp(64), 1f))
            if (intent.getBooleanExtra(EXTRA_ANSWER, false)) {
                addView(Space(context), LinearLayout.LayoutParams(dp(16), 0))
                addView(button("Answer", 0xFF2E9E5B.toInt()) { answer() }, LinearLayout.LayoutParams(0, dp(64), 1f))
            }
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(0xFF15151C.toInt())
                setPadding(dp(24), dp(112), dp(24), dp(80))
                addView(text(intent.getStringExtra(EXTRA_TITLE), 28f, Color.WHITE), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
                addView(text(intent.getStringExtra(EXTRA_BODY), 16f, 0xFFB4B4C8.toInt()), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) })
                addView(Space(context), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
                addView(buttons, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            },
        )
    }

    private fun decline() {
        Notices.stopRing(this, acc, since)
        finish()
    }

    // The phone unlocks first, then the app takes the call as from Answer on the notification (PushPlugin)
    private fun answer() {
        val take = {
            startActivity(Notices.answerIntent(this, acc, since).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
        }
        val keyguard = getSystemService(KeyguardManager::class.java)
        if (!keyguard.isKeyguardLocked) return take()
        keyguard.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = take()
            },
        )
    }

    private fun text(value: String?, size: Float, color: Int) = TextView(this).apply {
        text = value ?: ""
        textSize = size
        setTextColor(color)
        gravity = Gravity.CENTER
    }

    private fun button(label: String, color: Int, onClick: () -> Unit) = Button(this).apply {
        text = label
        textSize = 18f
        isAllCaps = false
        setTextColor(Color.WHITE)
        background = GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(32).toFloat()
        }
        setOnClickListener { onClick() }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
}

// Decline on the notification of a ringing call: this phone stops ringing, as from the ring screen
class DeclineReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Core.load(context)
        Notices.stopRing(context, intent.getIntExtra(EXTRA_ACC, 0), intent.getLongExtra(EXTRA_SINCE, 0L))
    }
}
