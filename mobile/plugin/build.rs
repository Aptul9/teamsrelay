// Commands of the Kotlin plugin the start page calls: relay (the address of the server), opened (the account of the
// notification that opened the app). Each one gets an allow-<command> permission (capabilities/default.json).
const COMMANDS: &[&str] = &["relay", "opened"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
