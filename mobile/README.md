# TeamsRelay for Android

A Tauri 2 app that shows the TeamsRelay web app of a server in an app window. Status: app shell. Notifications through Firebase are specified in [2026-09-26-android-client.md](../docs/design/2026-09-26-android-client.md) and deferred (2026-09-27): the web app installed from Chrome stays the device that receives notifications.

## What it does

- First start: a page bundled with the app asks for the address of the TeamsRelay server, keeps it (`localStorage` of the bundled page) and opens it. `https://` only; `http://` is accepted for `localhost` and `127.0.0.1`, to reach a local stack through `adb reverse tcp:8090 tcp:8090`, and works only in debug builds (the Tauri Android template allows clear text for the debug build type only).
- Next starts: the saved server opens directly.
- Changing the server: Android Settings, Apps, TeamsRelay, Storage, **Clear storage** (it also signs out). Back from the first server page right after typing the address shows the form again: tested in Chrome; in the app the Back button calls `webView.goBack()` while the WebView has history (Tauri 2.12 `AppPlugin.kt`), not tried on a device yet.
- The server page runs in the app WebView with its own session cookie. No Tauri capability names a remote URL, so the server page cannot call Tauri.
- No notifications inside the app: Android WebView has no Push API and no service worker notifications (MDN compatibility data), and the Settings page of the web app says the browser does not support push notifications.
- No downloads inside the app: Tauri 2.12 sets no download listener on the Android WebView, so attachment downloads of the web app do nothing. Open files in Teams or in the PWA.

## Layout

| Path | Content |
|---|---|
| `start/` | The bundled start page: `index.html`, `start.js`, `relay.js` (address rules), `start.css`, `icon.png` |
| `src-tauri/` | Tauri project: `tauri.conf.json` (identifier `io.github.aptul9.teamsrelay`, CSP of the start page), `src/lib.rs` (entry point), `icons/` (made by `npx tauri icon ../app/public/static/icon-512.png`) |
| `src-tauri/gen/android` | Android project made by `npx tauri android init`; not in git yet. It gets committed once edited by hand (signing, Firebase) |
| `test/` | `npm test`: address rules, and the start page in headless Google Chrome |

## Build

Requirements, as in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): Node 26, Rust with `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`, a JDK 17 or later, Android SDK (Platform, Platform-Tools, Build-Tools, Command-line Tools) and NDK, with `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` set. Installing the SDK and NDK means accepting the Android SDK license (`sdkmanager --licenses`).

```bash
npm ci
npx tauri android init
npx tauri icon ../app/public/static/icon-512.png
npx tauri android build --debug --apk --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`tauri icon` runs after `android init`: it writes the launcher icons into the Android project only when the project exists, otherwise the APK carries the Tauri default icon. On Windows, Rust has to use the MSVC host toolchain with the Microsoft C++ Build Tools: the GNU toolchain stops on the Windows dependencies of the build scripts (`dlltool` cannot create import libraries without binutils). A release build needs a signing key, configured in `src-tauri/gen/android` as in the [Tauri signing guide](https://v2.tauri.app/distribute/sign/android/); the key and `keystore.properties` stay out of git.

## CI

[`.github/workflows/android.yml`](../.github/workflows/android.yml) runs the tests and builds the debug APK for arm64 on pull requests that touch `mobile/` and on demand (Actions, **Android app**, Run workflow), with the Android SDK and NDK of the GitHub runner. The APK is the artifact `teamsrelay-android-debug`, kept 14 days. It is signed with a debug key made on the runner for that run: installing the APK of another run over it needs the app removed first (`adb uninstall io.github.aptul9.teamsrelay`), which also clears the saved server and the session.
