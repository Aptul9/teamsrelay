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
| `SLOT_COUNT` | no | Teams account slots of the server. Default 4, the number defined in `docker-compose.yml`. More slots need more `chromium-N` and `agent-N` services and `slotN` networks. |
| `ACCOUNTS_PER_USER` | no | Teams accounts one user may add. Empty: up to `SLOT_COUNT`. |
| `DESKTOP_USER`, `DESKTOP_PASS` | no | Password of the remote desktops. Leave empty: the desktops are behind the web app login and open only for the owner of the slot. |
| `DESKTOP_URL` | no | Address of the remote desktop of slot `{n}`. Default `/desktop/{n}/`. |
| `VAPID_SUBJECT` | no | Contact required by the Web Push standard, `mailto:` or `https:` URL. |
| `TZ` | no | Time zone of the automatic checks (8-11 and 17-20). Default `UTC`. |
| `HTTPS_PORT`, `HTTPS_BIND` | no | Port and bind address of Caddy for HTTPS. Default `443` on `0.0.0.0`. |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | no | Notifications through ntfy as well (`NTFY_ENABLED=1` and a topic). Every account of the server posts to the same topic. |

## Agent environment

Set per slot by `docker-compose.yml`, not in `.env`. The agent checks these at start (`app/src/agent/config.ts`) and stops with the name of the wrong variable.

| Variable | Default | Meaning |
|---|---|---|
| `CDP` | `http://localhost:9222` | DevTools of the slot browser; Compose sets `http://127.0.0.1:9222` |
| `ACCOUNT` | `1` | Slot number |
| `DB_PATH` | `/data/1/messages.db` | Database of the slot; images go to `media/`, attachments to `files/` and images to send to `uploads/` next to it |
| `APP_DB` | `/data/app.db` | Shared database of the web app, read for the slot owner and their devices |
| `VAPID_PRIVATE`, `VAPID_APPKEY` | `/vapid/private_key.pem`, `/vapid/appkey.txt` | Push keys. Without the private key push is off; a private key that does not match the public key stops the agent |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | From `.env`, `mailto:` or `https://` |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | `0`, `https://ntfy.sh`, empty | From `.env`; `NTFY_ENABLED` is `0` or `1` |
| `TZ` | `UTC` | From `.env`: time zone of the automatic checks |

Push notifications are kept by the push service for up to one hour when a device is offline, then dropped.

## Files outside `.env`

| Path | Content |
|---|---|
| `vapid/private_key.pem`, `vapid/appkey.txt` | Web Push keys, generated once ([setup.md](setup.md)). |
| `config/N/` | Chromium profile of slot N: the signed-in Microsoft session. |
| `data/app.db` | Users, sessions, slot ownership, push subscriptions. |
| `data/N/` | Database, images and files of slot N. |
