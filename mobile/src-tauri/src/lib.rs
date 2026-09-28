// The window opens the bundled start page (../start), which keeps the address of the TeamsRelay server and
// navigates to it. No capability names a remote URL, so the pages of the server get no access to Tauri: only the start
// page calls the push plugin (capabilities/default.json), which receives the notifications of the server.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_push::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
