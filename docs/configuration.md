# Configuration

Every setting is in `.env`, next to `docker-compose.yml`. Template: [.env.example](../.env.example). After a change: `docker compose up -d`.

| Variable | Required | Meaning |
|---|---|---|
| `DOMAIN` | yes | Public name of the server. Caddy gets the certificate for it; the web app builds its URL from it (`https://DOMAIN`). |
| `BETTER_AUTH_SECRET` | yes | Signs the sessions of the web app, at least 32 characters (`openssl rand -hex 32`). Changing it signs every user out. `SESSION_SECRET` of the previous release is accepted instead. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first start | Administrator defined in `.env`. Created at the first start, when it also takes over the accounts of the single-user release; at every start it is made administrator again and `ADMIN_PASSWORD` becomes its password, which signs it out of every device when the value changed. Its password cannot be changed in the app. At least 10 characters. Once users exist they may be removed: no administrator is then kept in line with `.env`. |
| `ADMIN_NAME` | no | Display name of the administrator of `.env`, used when it is created. Default `Administrator`. |
| `APP_URL` | no | Public URL of the web app when it differs from `https://DOMAIN`. |
| `MCP_TOKEN` | no | Bearer token of the MCP endpoint `/mcp` for AI clients, read tools only, acting as the administrator of `.env` ([mcp.md](mcp.md)). Empty: only OAuth sign-ins reach `/mcp` (off as well when the address of the app is plain HTTP on a host other than `localhost`). Otherwise at least 32 characters (`openssl rand -hex 32`) with `ADMIN_EMAIL` set, or the web app does not start. |
| `SLOT_COUNT` | no | Teams accounts of the server, at most 100. Default 4. An account runs its browser and its agent in the browsers container only while it exists and is not stopped. |
| `ACCOUNTS_PER_USER` | no | Teams accounts one user may add. Empty: up to `SLOT_COUNT`. |
| `RELAY_QUOTA_MB` | no | Room of an account on another computer on the server for the images and attachments its relay uploads, in MB. Default 2048. Past it the server refuses its new files (the relay logs them once and sends them again when a later sync names them), and the app shows them missing meanwhile. Pictures no row names any more leave the server after each sync and give their room back; attachments stay until the account is removed. |
| `DESKTOP_USER`, `DESKTOP_PASS` | no | Password of the remote desktop. Leave empty: the desktop is behind the web app login and opens only for users with a Teams account. |
| `DESKTOP_URL` | no | Address of the remote desktop of account `{n}`. Default `/api/desktop/{n}`, which brings the window of the account to the front of `/desktop/`. |
| `VAPID_SUBJECT` | no | Contact required by the Web Push standard, `mailto:` or `https:` URL. Used by the agents, and by the web app for the accounts on another computer. |
| `TZ` | no | Time zone of the automatic checks (8-11 and 17-20). Default `UTC`. |
| `HTTPS_PORT`, `HTTPS_BIND` | no | Port and bind address of Caddy for HTTPS. Default `443` on `0.0.0.0`. |
| `OCR_DOMAIN` | no | Name Caddy serves the upper-manager photo reader on (container `upper-manager-ocr`, its own compose project on this network). Default `http://ocr.localhost`, which serves nothing real. |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | no | Notifications through ntfy as well (`NTFY_ENABLED=1` and a topic). Every account of the server posts to the same topic, the accounts on another computer included (the web app sends theirs). A call rings there at priority 5 and turns quiet (priority 2) when it ends: with the ntfy setting *Keep alerting for highest priority* the phone rings until the notification is swiped or opened. |

## Agent environment

Set per account by the supervisor of the browsers container, not in `.env`. The agent checks these at start (`app/src/agent/config.ts`) and stops with the name of the wrong variable.

| Variable | Default | Meaning |
|---|---|---|
| `CDP` | `http://localhost:9222` | DevTools of the browser of the account; the supervisor sets `http://127.0.0.1:(9221+N)` |
| `ACCOUNT` | `1` | Account number |
| `DB_PATH` | `/data/1/messages.db` | Database of the slot; images go to `media/`, attachments to `files/` and images to send to `uploads/` next to it |
| `APP_DB` | `/data/app.db` | Shared database of the web app, read for the slot owner and their devices |
| `VAPID_PRIVATE`, `VAPID_APPKEY` | `/vapid/private_key.pem`, `/vapid/appkey.txt` | Push keys. Without the private key push is off; a private key that does not match the public key stops the agent |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | From `.env`, `mailto:` or `https://` |
| `FCM_CREDENTIALS` | `/fcm/service-account.json` | Service account key of the Firebase project, for the phones of the Android app (`mobile/`). A missing file leaves FCM off; a file that is not a service account key stops the agent |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | `0`, `https://ntfy.sh`, empty | From `.env`; `NTFY_ENABLED` is `0` or `1` |
| `TZ` | `UTC` | From `.env`: time zone of the automatic checks |

The supervisor sets the paths under `/root`: `DB_PATH` `/root/data/N/messages.db`, `APP_DB` `/root/data/app.db`, the VAPID keys in `/root/vapid`, `FCM_CREDENTIALS` `/root/fcm/service-account.json`.

Push notifications are kept by the push service for up to 24 hours when a device is offline, then dropped.

## Supervisor environment

Set by `docker-compose.yml` and the browsers image. The supervisor checks these at start (`app/src/supervisor/config.ts`).

| Variable | Default | Meaning |
|---|---|---|
| `SLOT_COUNT` | `4` | From `.env`: accounts 1 to `SLOT_COUNT` |
| `PUID`, `PGID` | `1000` | Owner of the profiles and of the desktop session; the browsers run as this user |
| `CONTROL_SOCKET` | `/root/run/control.sock` | Socket of the control API, in the volume `control` |
| `PROFILES_DIR` | `/profiles` | Profile directories, `config/` of the host |
| `DATA_DIR`, `VAPID_DIR`, `FCM_DIR` | `/root/data`, `/root/vapid`, `/root/fcm` | Passed to the agents |
| `TZ`, `LANG`, `LANGUAGE`, `LC_ALL` | | Passed to the browsers when set; `TZ`, `VAPID_SUBJECT` and `NTFY_*` to the agents |

## Remote desktop

Set by `docker-compose.yml` for Selkies, the remote desktop of the browsers container (`/desktop/`).

| Variable | Value | Meaning |
|---|---|---|
| `SUBFOLDER` | `/desktop/` | Path Caddy publishes it on, only to users with a Teams account |
| `SELKIES_ENCODER` | `jpeg` | JPEG frames: without a GPU (ARM VMs) the H.264 of the browser decoder gets no frame |
| `SELKIES_MICROPHONE_ENABLED` | `true` | The microphone of the viewer can reach Teams, for a call answered from the app. The start of the browsers container then makes the virtual source `SelkiesVirtualMic` the default one: without a viewer Selkies has none, and Teams would record the sound of the desktop |
| `SELKIES_MICROPHONE_ON_START` | `demand` | The viewer is asked for its microphone only while an application records from `SelkiesVirtualMic`, and released 10 s after |

The browsers image also carries the Chromium policy `AudioCaptureAllowedUrls` (`app/docker/browsers/etc/chromium/policies/managed/teamsrelay.json`): the Teams origins get the microphone without a prompt. The agent grants its browser notifications alone, with the DevTools call `Browser.setPermission`: the `grantPermissions` of Playwright would deny every permission it does not list, the microphone included, over that policy.

## Files outside `.env`

| Path | Content |
|---|---|
| `vapid/private_key.pem`, `vapid/appkey.txt` | Web Push keys, generated once ([setup.md](setup.md)). |
| `fcm/service-account.json` | Service account key of the Firebase project, for the Android app ([setup.md](setup.md#android-app)). Not in git; mounted read-only in the browsers container (agents) and in the web app (`/fcm`, `FCM_CREDENTIALS`: the phones of the owner of an account on another computer). A missing file leaves FCM off; a file that is not a service account key stops an agent, and the web app logs `FCM off` with the reason and sends those accounts' notifications to the browsers only. |
| `config/N/` | Chromium profile of account N: the signed-in Microsoft session. |
| `data/app.db` | Users, sessions, slot ownership, push subscriptions, the SHA-256 of the token of each account on another computer. |
| `data/N/` | Database, images and files of slot N; for an account on another computer, written by the web app from what its relay sends. |

## Local relay environment

`app/relay.env`, written from [relay.env.example](../app/relay.env.example) by `npm run relay:setup`, or the environment of the process (which wins). Not `.env`: Next.js would load that one into the web app. Checked at start (`app/src/local/config.ts`): a wrong value stops the relay with the name of the variable.

| Variable | Default | Meaning |
|---|---|---|
| `STATE_DIR` | `state` | Browser profile, database, images, push keys, API token, lock; relative to `app/` |
| `BROWSER_CHANNEL` | `chrome` | Installed browser the relay drives on its own profile: `chrome` or `msedge` |
| `TEAMS_URL` | `https://teams.cloud.microsoft/` | Page opened in the relay browser |
| `RELAY_BIND`, `RELAY_PORT` | `127.0.0.1`, `8787` | Address of the API and the app; an IP address, not a name |
| `RELAY_TLS_CERT`, `RELAY_TLS_KEY` | empty | PEM files for HTTPS on the API itself, both or neither, relative to `app/` |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact for the push services, `mailto:` or `https://` |
| `NTFY_URL`, `NTFY_TOPIC` | `https://ntfy.sh`, empty | ntfy as a second channel, on when the topic is set |
| `HOST_LABEL` | host name | Name of the machine in the alerts ("sign in again in the relay window on ...") and, joined to a server, in its web app |
| `SERVER_URL`, `SERVER_TOKEN` | empty | A TeamsRelay server to join as an account on another computer ([setup](setup.md#an-account-on-another-computer)): the address of its web app and the token its account menu showed, both or neither. `https://`, or `http://` to `localhost`, `127.0.0.1`, `[::1]` only |
| `RELAY_BROWSER` | `0` | `1`: a browser of its own on this computer, driven by the AI clients (MCP, OAuth) of the owner through the server joined ([mcp.md](mcp.md#browser-tools)); needs `SERVER_URL` and `SERVER_TOKEN`. Own window and profile, never the Teams ones |
| `RELAY_BROWSER_IDLE` | `900` | Seconds without a call after which that browser closes (the next call opens it again, profile kept) |

Files under `STATE_DIR`: `profile/` (the signed-in Microsoft session), `relay.db`, `media/`, `files/` (attachments a server joined asked for), `uploads/` (its images to send), `vapid/private_key.pem` and `vapid/appkey.txt`, `token`, `relay.lock`; with `RELAY_BROWSER=1`, `ai-profile/` (the profile of the browser of the AI clients) and `ai-output/` (its screenshots, while it is open). None is in git or in the Docker build context.
