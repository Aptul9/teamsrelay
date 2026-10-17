// Notifications of TeamsRelay on Android. The Kotlin side (android/) receives the Firebase messages of the relay, draws
// the notifications and hands the WebView its pages; what the messages say and the requests to the relay are the shared
// Rust of the app (../core), which Kotlin calls through android.rs. The bundled start page calls the two commands of
// the plugin, the pages of the server none (no capability names a remote URL).
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
mod android;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("push")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("io.github.aptul9.teamsrelay.push", "PushPlugin")?;
            Ok(())
        })
        .build()
}
