# Configuration

Every setting is in `.env`, next to `docker-compose.yml`. Template: [.env.example](../.env.example). After a change: `docker compose up -d`.

| Variable | Required | Meaning |
|---|---|---|
| `DOMAIN` | yes | Public name of the server. Caddy gets the certificate for it; the web app builds its URL from it (`https://DOMAIN`). |
| `BETTER_AUTH_SECRET` | yes | Signs the sessions of the web app, at least 32 characters (`openssl rand -hex 32`). Changing it signs every user out. `SESSION_SECRET` of the previous release is accepted instead. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first start | Administrator defined in `.env`. Created at the first start, when it also takes over the accounts of the single-user release; at every start it is made administrator again and `ADMIN_PASSWORD` becomes its password, which signs it out of every device when the value changed. Its password cannot be changed in the app. At least 10 characters. Once users exist they may be removed: no administrator is then kept in line with `.env`. |
| `ADMIN_NAME` | no | Display name of the administrator of `.env`, used when it is created. Default `Administrator`. |
| `APP_URL` | no | Public URL of the web app when it differs from `https://DOMAIN`. |
| `MCP_TOKEN` | no | Bearer token of the MCP endpoint `/mcp` for AI clients, read only, acting as the administrator of `.env` ([mcp.md](mcp.md)). Empty: the endpoint is off. Otherwise at least 32 characters (`openssl rand -hex 32`) with `ADMIN_EMAIL` set, or the web app does not start. |
| `SLOT_COUNT` | no | Teams accounts of the server, at most 64. Default 4. An account runs its browser and its agent in the browsers container only while it exists and is not stopped. |
| `ACCOUNTS_PER_USER` | no | Teams accounts one user may add. Empty: up to `SLOT_COUNT`. |
| `DESKTOP_USER`, `DESKTOP_PASS` | no | Password of the remote desktop. Leave empty: the desktop is behind the web app login and opens only for users with a Teams account. |
| `DESKTOP_URL` | no | Address of the remote desktop of account `{n}`. Default `/api/desktop/{n}`, which brings the window of the account to the front of `/desktop/`. |
| `VAPID_SUBJECT` | no | Contact required by the Web Push standard, `mailto:` or `https:` URL. |
| `TZ` | no | Time zone of the automatic checks (8-11 and 17-20). Default `UTC`. |
| `HTTPS_PORT`, `HTTPS_BIND` | no | Port and bind address of Caddy for HTTPS. Default `443` on `0.0.0.0`. |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | no | Notifications through ntfy as well (`NTFY_ENABLED=1` and a topic). Every account of the server posts to the same topic. |

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
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | `0`, `https://ntfy.sh`, empty | From `.env`; `NTFY_ENABLED` is `0` or `1` |
| `TZ` | `UTC` | From `.env`: time zone of the automatic checks |

The supervisor sets the paths under `/root`: `DB_PATH` `/root/data/N/messages.db`, `APP_DB` `/root/data/app.db`, the VAPID keys in `/root/vapid`.

Push notifications are kept by the push service for up to one hour when a device is offline, then dropped.

## Supervisor environment

Set by `docker-compose.yml` and the browsers image. The supervisor checks these at start (`app/src/supervisor/config.ts`).

| Variable | Default | Meaning |
|---|---|---|
| `SLOT_COUNT` | `4` | From `.env`: accounts 1 to `SLOT_COUNT` |
| `PUID`, `PGID` | `1000` | Owner of the profiles and of the desktop session; the browsers run as this user |
| `CONTROL_SOCKET` | `/root/run/control.sock` | Socket of the control API, in the volume `control` |
| `PROFILES_DIR` | `/profiles` | Profile directories, `config/` of the host |
| `DATA_DIR`, `VAPID_DIR` | `/root/data`, `/root/vapid` | Passed to the agents |
| `TZ`, `LANG`, `LANGUAGE`, `LC_ALL` | | Passed to the browsers when set; `TZ`, `VAPID_SUBJECT` and `NTFY_*` to the agents |

## Files outside `.env`

| Path | Content |
|---|---|
| `vapid/private_key.pem`, `vapid/appkey.txt` | Web Push keys, generated once ([setup.md](setup.md)). |
| `config/N/` | Chromium profile of account N: the signed-in Microsoft session. |
| `data/app.db` | Users, sessions, slot ownership, push subscriptions. |
| `data/N/` | Database, images and files of slot N. |
