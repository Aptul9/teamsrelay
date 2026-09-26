# Configuration

Every setting is in `.env`, next to `docker-compose.yml`. Template: [.env.example](../.env.example). After a change: `docker compose up -d`.

| Variable | Required | Meaning |
|---|---|---|
| `DOMAIN` | yes | Public name of the server. Caddy gets the certificate for it; the web app builds its URL from it (`https://DOMAIN`). |
| `BETTER_AUTH_SECRET` | yes | Signs the sessions of the web app, at least 32 characters (`openssl rand -hex 32`). Changing it signs every user out. `SESSION_SECRET` of the previous release is accepted instead. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | first start | First administrator, created while the server has no users. Password of at least 10 characters. Ignored once users exist. |
| `ADMIN_NAME` | no | Display name of the first administrator. Default `Administrator`. |
| `APP_URL` | no | Public URL of the web app when it differs from `https://DOMAIN`. |
| `SLOT_COUNT` | no | Teams account slots of the server. Default 4, the number defined in `docker-compose.yml`. More slots need more `chromium-N` and `agent-N` services and `slotN` networks. |
| `ACCOUNTS_PER_USER` | no | Teams accounts one user may add. Empty: up to `SLOT_COUNT`. |
| `DESKTOP_USER`, `DESKTOP_PASS` | no | Password of the remote desktops. Leave empty: the desktops are behind the web app login and open only for the owner of the slot. |
| `DESKTOP_URL` | no | Address of the remote desktop of slot `{n}`. Default `/desktop/{n}/`. |
| `VAPID_SUBJECT` | no | Contact required by the Web Push standard, `mailto:` or `https:` URL. |
| `TZ` | no | Time zone of the automatic checks (8-11 and 17-20). Default `UTC`. |
| `HTTPS_PORT`, `HTTPS_BIND` | no | Port and bind address of Caddy for HTTPS. Default `443` on `0.0.0.0`. |
| `NTFY_ENABLED`, `NTFY_URL`, `NTFY_TOPIC` | no | Notifications through ntfy as well (`NTFY_ENABLED=1` and a topic). Every account of the server posts to the same topic. |

## Files outside `.env`

| Path | Content |
|---|---|
| `vapid/private_key.pem`, `vapid/appkey.txt` | Web Push keys, generated once ([setup.md](setup.md)). |
| `config/N/` | Chromium profile of slot N: the signed-in Microsoft session. |
| `data/app.db` | Users, sessions, slot ownership, push subscriptions. |
| `data/N/` | Database, images and files of slot N. |
