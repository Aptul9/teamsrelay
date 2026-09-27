package io.github.aptul9.teamsrelay.push

import android.content.Context
import java.io.File
import org.json.JSONArray

// What the plugin keeps on the phone: the address of the relay and the Firebase token it knows the phone by, the last
// lines of each chat notification, the last call of each account. The key of the phone, which opens the messages of
// the relay, stays out of the backups.
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("push", Context.MODE_PRIVATE)
    private val keyFile = File(context.noBackupFilesDir, "push-key")

    var relay: String
        get() = prefs.getString("relay", "") ?: ""
        set(v) = prefs.edit().putString("relay", v).apply()

    // "" while the relay knows no token of this phone
    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v).apply()

    var key: String
        get() = if (keyFile.exists()) keyFile.readText() else ""
        set(v) = keyFile.writeText(v)

    fun lines(tag: String): List<String> {
        val a = JSONArray(prefs.getString("lines:$tag", "[]"))
        return (0 until a.length()).map { a.getString(it) }
    }

    fun setLines(tag: String, lines: List<String>) = prefs.edit().putString("lines:$tag", JSONArray(lines).toString()).apply()

    // The last call of an account: when it started ringing (ms, as the relay sends it) and whether it ended
    fun lastCall(acc: Int): Pair<Long, Boolean> = prefs.getLong("call:$acc", 0L) to prefs.getBoolean("ended:$acc", false)

    fun setLastCall(acc: Int, since: Long, ended: Boolean) = prefs.edit().putLong("call:$acc", since).putBoolean("ended:$acc", ended).apply()
}
