# Android client: Tauri app with Firebase push

Status: app shell built 2026-09-27 ([mobile/README.md](../../mobile/README.md)): start page, remote web app, debug APK in CI; push deferred on 2026-09-27, the plan below unchanged. Web Push stays for browsers and the installed PWA; this app adds a second kind of device. Android WebView has no Push API, so inside the app the web page gets no notifications until the plugin below exists.

## Goal

An Android app for TeamsRelay. Notifications arrive through Firebase Cloud Messaging and use what Android offers and Web Push does not: reply from the notification, one conversation notification per chat, channels with their own sound and importance. The app window shows the TeamsRelay web app. A user can keep the PWA on other devices: each device gets the notifications of its kind.

## Firebase, and the part Tauri does not provide

- FCM is the push transport of Android, and Chrome's Web Push already travels over it. The transport stays the same; the app changes how a notification is received, drawn and answered.
- The app uses the Firebase Android SDK directly, as any native Android app does: `com.google.firebase:firebase-messaging` through the Firebase BoM, and the `google-services` Gradle plugin.
- Tauri 2 has no push support: its `notification` plugin shows local notifications only. Kotlin code has to connect the Firebase SDK to the app. Community plugins do it (`tauri-plugin-notifications`, version 0.5 and several forks on 2026-09-26). This spec writes that code as a plugin of this repository: a few hundred lines of Kotlin, full control of data messages, notification layout and replies, no dependency on a 0.x plugin.

## Decisions

| Question | Choice | Not chosen |
|---|---|---|
| Relay | This web app, over public HTTPS (`https://<DOMAIN>`) | `teamsrelay-local` (one account, token API, phone reach not decided): open question |
| Window content | The relay URL, loaded as a remote page; the web app does not change | a UI bundled in the app: Next.js serves pages and API from one server, there is no static export |
| Native side and web page | No IPC from the remote page. The plugin registers the device and sends replies itself, with the session cookie of the app WebView (`CookieManager`) | Tauri remote capability (`remote.urls`): Tauri documents that on Android it cannot tell an `<iframe>` from the window, and the web app embeds the remote desktop in an iframe |
| Message type | FCM data message, Android priority `HIGH`, TTL `86400s`, no collapse key | notification message (drawn by the system while the app is in background: no MessagingStyle, no reply); a collapse key per chat (FCM keeps at most 4 collapse keys per device and throttles collapsible messages to a burst of 20, then 1 every 3 minutes) |
| Payload | Encrypted by the relay with AES-256-GCM, one key per device, handed to the app once at registration over HTTPS | text in clear in the FCM payload (readable by Google, where a Web Push payload is ciphertext); message id only with the text fetched from the relay (one more round trip before the notification, nothing shown while the relay is unreachable) |
| Firebase glue | Own Kotlin plugin in this repository | community plugin |
| Distribution | Signed APK, installed by hand | Play Store (developer account, review) |

## FCM message

The relay sends one FCM message per device and notification. FCM `data` values are strings.

| `data` key | Content |
|---|---|
| `v` | `1` |
| `iv` | 12 random bytes, base64url |
| `ct` | AES-256-GCM ciphertext and tag, base64url, of the JSON `{kind, acc, chat, title, body, ts}` |

`kind` is `message`, `alert` (session expired, check failed) or `status` (check passed). The payload stays under the 4096-byte FCM limit: titles are cut at 100 characters and bodies at 1000, as for ntfy.

## Notifications on the phone

| Kind | Channel | Layout |
|---|---|---|
| `message` | `messages`, importance high | one notification per account and chat: MessagingStyle with the last 5 lines kept by the app; actions Reply (RemoteInput) and Open |
| `alert` | `alerts`, importance high | one per account, replaced by the next |
| `status` | `status`, importance low | one per account, replaced by the next |

- Tap: opens the app on `/?a=<slot>`, as the Web Push notification does. Opening the chat itself needs a chat parameter the web app does not read today (`App.tsx` reads `a` only).
- Reply: the RemoteInput text goes to a WorkManager job (the Firebase docs give the receiving service a short window and point longer work to WorkManager), which posts `/api/send?a=<slot>` `{name, text}` with the session cookie. Success adds the text to the notification as own line; 401 shows "Open TeamsRelay to sign in again"; other failures show the error.
- `onDeletedMessages` (FCM dropped messages, for example more than 100 pending for the device): one notification "Some notifications were lost: open TeamsRelay".
- Android 13 and later: notification permission asked at first start.

## Registration

1. First start: a page bundled in the app asks for the relay address and keeps it, then the window navigates to the relay. The shell keeps it in `localStorage` of the bundled page; the plugin will need it natively, through a plugin command (bundled code, trusted IPC).
2. The user signs in to the web app in the window, as in a browser.
3. After each page load on the relay origin with a session cookie, and when Firebase hands a new token (`onNewToken`), the plugin posts `POST /api/push/fcm` `{token}` with the cookie. Newer Firebase SDKs describe Firebase Installation IDs delivered by `onRegistered()`: follow the Firebase docs current at build time.
4. The relay stores the device for the session user and answers `{key}`: 32 random bytes, base64url, generated per device. The plugin keeps it in storage protected by the Android Keystore.
5. Sign-out from the web app in the window: `DELETE /api/push/fcm` `{token}`.

## Relay changes

| File | Change |
|---|---|
| `app/src/lib/appdb.ts` | FCM devices in `push_subscriptions`: `endpoint` `fcm:<token>`, `sub` `{"fcm":{"token","key"}}`. Same owner scoping, count and removal as Web Push devices |
| `app/src/app/api/push/fcm/route.ts` | `POST` registers (key generated, returned once), `DELETE` unregisters; session user only |
| `app/src/agent/push/fcm.ts` | Sender: FCM HTTP v1 through `firebase-admin` with a service account key file; data message, priority `HIGH`, TTL `86400s`, payload encrypted with the device key |
| `app/src/agent/push/notifier.ts` | Each target by kind, Web Push or FCM, with the same retry rules; `UNREGISTERED` (404) and `messaging/registration-token-not-registered` remove the device |
| `app/src/agent/config.ts`, `docker-compose.yml`, `.env.example` | `FCM_CREDENTIALS`: path of the service account key file, mounted read-only like `vapid/`; unset means FCM off |
| `app/src/components/Settings.tsx` | The device list shows the kind |
| `docs/` | api, configuration, security, setup (installing the APK) |

The service account key and `google-services.json` stay out of git. The service account gets a role limited to sending FCM messages, never a project-wide Editor or Owner role.

## App

| Path | Content |
|---|---|
| `mobile/src-tauri/` | Tauri 2 project: one window, the start page, plugin registration. `gen/android` is edited by hand (signing, Firebase Gradle plugin) and committed, as the Tauri signing guide edits it |
| `mobile/plugin/` | Kotlin plugin (`@TauriPlugin`): `FirebaseMessagingService`, channels, notification builder, reply receiver and WorkManager job, cookie reader, key storage, `setRelay` command |
| `mobile/start/` | The bundled start page |

Build machine: Android Studio with SDK Platform, Platform-Tools, Build-Tools, Command-line Tools and NDK; `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`; `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`. None of it was installed on the development laptop on 2026-09-26. The debug APK of the shell is built by `.github/workflows/android.yml` on the GitHub runner, which carries SDK and NDK; release builds and signing stay local.

## Tests

- Relay: sender against a fake FCM transport (priority, TTL, no collapse key, payload decrypted with the device key); removal on `UNREGISTERED`; retry on 429 and 5xx; registration answers 401 without a session and keeps devices per user.
- Plugin: JVM unit tests for decryption with a vector produced by the relay code, the last 5 lines per chat, the reply request with the cookie.
- On a phone: Doze forced with `adb shell dumpsys deviceidle force-idle`, then an incoming message (second account or colleague), time to notification noted; app removed from recents, then a message; phone offline for an hour, then back; reply from the notification in the self chat only.

## Effort

3 to 5 days, estimated: toolchain and scaffold 0.5 to 1, plugin 1.5 to 2, relay 1, signing and phone tests 0.5 to 1.

## Open questions

- Relay: this web app, or `teamsrelay-local`, whose page keeps a bearer token instead of a session cookie (the start page would hand the token to the plugin).
- Who keeps the signing key. The package name of the shell is `io.github.aptul9.teamsrelay`: changing it after a first install means a new app on the phone.

## Out of scope

iOS (APNs, Apple developer account), desktop builds, Play Store, native screens, reading chats without the web app.
