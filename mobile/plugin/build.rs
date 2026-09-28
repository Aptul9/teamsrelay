// Commands of the Kotlin plugin the start page calls: relay (the address of the server and of the start page), opened
// (what started the app: the account of a tapped notification, the launcher shortcut Change server). Each one gets an
// allow-<command> permission (capabilities/default.json).
const COMMANDS: &[&str] = &["relay", "opened"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
