# TeamsRelay for Android

A Tauri 2 app that shows the TeamsRelay web app of a server in an app window and receives its notifications through Firebase Cloud Messaging: a Teams call rings with the ringtone of the phone, locked or not, until it ends. Design: [2026-09-26-android-client.md](../docs/design/2026-09-26-android-client.md). Setting up Firebase: [setup.md](../docs/setup.md#android-app).

## What it does

- First start: a page bundled with the app asks for the address of the TeamsRelay server, keeps it (`localStorage` of the bundled page) and opens it. `https://` only; `http://` is accepted for `localhost` and `127.0.0.1`, to reach a local stack through `adb reverse tcp:8090 tcp:8090`, and works only in debug builds (the Tauri Android template allows clear text for the debug build type only).
- Next starts: the saved server opens directly.
- Changing the server, both ways bring back the form of the start page with the address in use (`#change`):
  - long press on the app icon, **Change server**: a launcher shortcut the push plugin publishes at each start (`Shortcuts.kt`, dynamic; it brings back the running app, and a start page still waiting for a server that does not answer loads again with the form). It works when the server does not answer or no longer lets the app in;
  - **Change server** in the account menu of the web app, and under its sign-in form: the start page opens the server with its own address (`?app=http://tauri.localhost/`, the origin Tauri 2.12 serves the bundled page from on Android), which the web app keeps on the device and links back to. The server page itself still cannot call Tauri.
  - The previous server forgets the phone when it answers (`DELETE /api/push/fcm` with the token), and the key it gave is dropped: what it may still send is not opened. The new server reaches the phone only if it uses the Firebase project the APK was built with (`GOOGLE_SERVICES_JSON`); another project answers `SENDER_ID_MISMATCH` and the server forgets the phone. Android Settings, Apps, TeamsRelay, Storage, **Clear storage** starts from scratch (it also signs out).
- Back from the first server page right after typing the address shows the form again: tested in Chrome; in the app the Back button calls `webView.goBack()` while the WebView has history (Tauri 2.12 `AppPlugin.kt`), not tried on a device yet.
- The server page runs in the app WebView with its own session cookie. No Tauri capability names a remote URL, so the server page cannot call Tauri: only the bundled start page calls the push plugin (`src-tauri/capabilities/default.json`).
- Android WebView has no Push API and no service worker notifications (MDN compatibility data): the notifications come from the push plugin (`plugin/`), not from the web page, whose Settings still say the browser does not support push notifications.
- No downloads inside the app: Tauri 2.12 sets no download listener on the Android WebView, so attachment downloads of the web app do nothing. Open files in Teams or in the PWA.

## Notifications

- **Registration**: at each start of the app, each return to it, each sign-in or sign-out in its web page while it is on screen (checked every 10 s: a page of the server cannot call the app) and each new Firebase token, the plugin posts the token to `POST /api/push/fcm` of the server with the session cookie of the web page (Android `CookieManager`); the server answers the key of the phone. Signed out (no session cookie, or a session the server refuses), it asks the server to forget the phone (`DELETE /api/push/fcm`) and drops the key. The server also forgets a phone when the session that registered it ends, so **Sign out every other device** in Settings stops a lost phone, and sends to a phone only while that session runs (30 days, as any sign-in of the web app): once it has run out the phone gets nothing until it is signed in again.
- **Messages**: FCM data messages at high priority, sealed by the server with the key of the phone (AES-256-GCM); the plugin opens them (`Seal.kt`) and draws the notification (`Notices.kt`), also with the app closed (`PushService.kt`, started by Firebase).
- **Android 8.0** (API 26) or later: the ringtone of a call comes from its notification channel.
- **Channels**: **Calls** (importance high, sound the ringtone of the phone, repeated with `FLAG_INSISTENT` until the call ends, the notification is tapped or the shade opened, cut after 65 s), **Calls ended** (quiet: who called, for how long), **Messages** (one notification per chat with its last 5 lines, read back from the notification on screen: nothing of the chats is kept on the phone), **TeamsRelay** (sign-in needed, checks, missed calls a check found). The sound of each channel is changed in the Android settings of the app.
- **Tap**: opens the web app on the account of the notification (`/?a=N`), from the start page when the tap started the app, in the window at once when it runs.
- **Permission**: Android 13 and later ask for the notification permission at the first start.
- **Registration token**: the plugin uses the FCM registration token (`FirebaseMessaging.token`, `onNewToken`), deprecated since firebase-messaging 25.1.0 in favour of installation IDs (`onRegistered`); tokens keep working, and on 2026-09-27 the FCM HTTP v1 guide to send to one device still addresses tokens only ([firebase-android-sdk issue 8316](https://github.com/firebase/firebase-android-sdk/issues/8316)). Moving to installation IDs changes the plugin and the sender together once that guide covers them.
- **Firebase settings**: `scripts/firebase-values.mjs` writes the values of `google-services.json` (repository secret `GOOGLE_SERVICES_JSON` in CI) as string resources of the plugin, which the Firebase SDK reads at start; built without them, the app works and receives no notifications (logcat tag `TeamsRelay`: `Firebase is not configured in this build`).

## Layout

| Path | Content |
|---|---|
| `start/` | The bundled start page: `index.html`, `start.js`, `relay.js` (address rules), `start.css`, `icon.png` |
| `src-tauri/` | Tauri project: `tauri.conf.json` (identifier `io.github.aptul9.teamsrelay`, CSP of the start page), `src/lib.rs` (entry point, push plugin), `capabilities/default.json` (the start page may call the plugin), `icons/` (made by `npx tauri icon ../app/public/static/icon-512.png`) |
| `plugin/` | Tauri plugin `push`: Rust glue (`src/lib.rs`, commands `relay` and `opened`) and the Kotlin of Android (`android/`: Firebase service, channels, registration, decryption, launcher shortcut; JVM tests in `android/src/test`) |
| `scripts/firebase-values.mjs` | `google-services.json` to the string resources of the plugin |
| `src-tauri/gen/android` | Android project made by `npx tauri android init`, not in git: the plugin brings its Kotlin, manifest entries and Firebase settings, so the generated project needs no edit |
| `test/` | `npm test`: address rules, Firebase values, and the start page in headless Google Chrome (with a stand-in for the plugin) |

## Build

Requirements, as in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): Node 26, Rust with `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`, a JDK 17 or later, Android SDK (Platform, Platform-Tools, Build-Tools, Command-line Tools) and NDK, with `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` set. Installing the SDK and NDK means accepting the Android SDK license (`sdkmanager --licenses`).

```bash
npm ci
npx tauri android init
npx tauri icon ../app/public/static/icon-512.png
node scripts/firebase-values.mjs <path of google-services.json> plugin/android/src/main/res/values/google-services.xml
npx tauri android build --debug --apk --target aarch64
(cd src-tauri/gen/android && ./gradlew :tauri-plugin-push:testDebugUnitTest)
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`tauri icon` runs after `android init`: it writes the launcher icons into the Android project only when the project exists, otherwise the APK carries the Tauri default icon. On Windows, Rust has to use the MSVC host toolchain with the Microsoft C++ Build Tools: the GNU toolchain stops on the Windows dependencies of the build scripts (`dlltool` cannot create import libraries without binutils). A release build needs a signing key, configured in `src-tauri/gen/android` as in the [Tauri signing guide](https://v2.tauri.app/distribute/sign/android/); the key and `keystore.properties` stay out of git.

## CI

[`.github/workflows/android.yml`](../.github/workflows/android.yml) runs the tests, writes the Firebase settings from the secret `GOOGLE_SERVICES_JSON` (a warning without it), builds the debug APK for arm64 and runs the JVM tests of the plugin, on pull requests that touch `mobile/` and on demand (Actions, **Android app**, Run workflow), with the Android SDK and NDK of the GitHub runner. The APK is the artifact `teamsrelay-android-debug`, kept 14 days. It is signed with a debug key made on the runner for that run: installing the APK of another run over it needs the app removed first (`adb uninstall io.github.aptul9.teamsrelay`), which also clears the saved server and the session.
