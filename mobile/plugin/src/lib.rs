// Notifications of TeamsRelay on Android. The Kotlin side (android/) receives the Firebase messages of the relay and
// shows them, and registers the phone with the relay; the bundled start page calls its two commands, the pages of the
// server none (no capability names a remote URL).
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("push")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("io.github.aptul9.teamsrelay.push", "PushPlugin")?;
            Ok(())
        })
        .build()
}
