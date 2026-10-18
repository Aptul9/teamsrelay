package io.github.aptul9.teamsrelay.push

import android.content.Context

// The shared Rust of the app (mobile/core, through plugin/src/android.rs): it keeps the server, the Firebase token the
// server knows and the key of the phone, opens what the server sends and decides what it shows, and makes the requests
// to the server. This side hands it what only Android has: the Firebase token, the cookies of the WebView, the
// notifications on screen. Its library is the app's own, loaded here too: Firebase may start the push service with no
// window, before the app loaded it.
object Core {
    @Volatile private var loaded = false

    fun load(context: Context) {
        if (loaded) return
        synchronized(this) {
            if (loaded) return
            // the [lib] name of src-tauri/Cargo.toml
            System.loadLibrary("teamsrelay_mobile_lib")
            // out of the backups: a token or a key restored on another phone means nothing there
            init(context.noBackupFilesDir.path)
            loaded = true
        }
    }

    @JvmStatic private external fun init(dir: String)

    // the origin of the server, "" before the start page named one
    @JvmStatic external fun relay(): String

    // another server than before: the previous one forgets this phone
    @JvmStatic external fun useRelay(origin: String)

    // the session cookie of the web page among the cookies of the server, "" without one
    @JvmStatic external fun session(cookies: String): String

    // registers the phone, or has it forgotten when signed out: off the main thread, it waits for the server
    @JvmStatic external fun sync(origin: String, token: String, cookies: String, name: String)

    // what a message of Firebase shows, as JSON (Notices.show): data, the data of the message; shown, Notices.shown
    @JvmStatic external fun notice(data: String, shown: String): String

    // the ringing call taken in the app: later pushes of its ring change nothing
    @JvmStatic external fun stopRing(acc: Int, since: Long)

    // Answer on a ringing call: whether the server took it. Off the main thread, it waits for the server.
    @JvmStatic external fun answer(origin: String, cookies: String, acc: Int, since: Long): Boolean

    // a picture of the server (the logo of the company of an account), empty when it could not be loaded; off the
    // main thread, it waits for the server
    @JvmStatic external fun picture(origin: String, cookies: String, acc: Int, file: String): ByteArray
}
