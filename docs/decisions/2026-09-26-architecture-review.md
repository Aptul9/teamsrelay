# Architecture review

Date: 2026-09-26. Scope: `main` at `7b26cb4`: agent, web app, PWA, Compose stack, Caddy, CI, deploy script, documentation.

## Stack: Python and HTML

No Python library is load-bearing.

| Python dependency | Role | Node equivalent |
|---|---|---|
| `playwright` | CDP client of the agent | `playwright-core`. The Python package itself launches a bundled Node driver (`playwright/_impl/_driver.py`) |
| `pywebpush` | Web Push delivery | `web-push` |
| `fastapi`, `uvicorn` | HTTP API | Next.js route handlers |
| `sqlite3` | per-account and shared databases | `better-sqlite3` |
| `cryptography`, `Pillow` | VAPID keys and icons (tools only) | `web-push generate-vapid-keys`, `sharp` |

The agent drives Teams through 25 page scripts that are already JavaScript, embedded as strings in `agent/agent.py`; Python runs the loop around them. The PWA was a single 644-line HTML file with string-built markup, global state and five polling timers.

Outcome: the web app moves to Next.js and TypeScript, the agent stays Python until a later phase. See [2026-09-26-multi-user-nextjs.md](2026-09-26-multi-user-nextjs.md).

## Authentication as found

App login:

- One credential pair from `.env` (`UI_USER`, `UI_PASS`), no user model.
- `POST /api/login` sets the cookie `sess` = HMAC-SHA256(`SESSION_SECRET`, `"sess"`), valid one year. The value is the same for every login and every device: a single device cannot be logged out, and rotating `SESSION_SECRET` logs out all of them.
- `Authorization: Basic` is accepted on every endpoint.
- Login throttle: 1.5 s delay per failure, HTTP 429 after 10 failures in 15 minutes per client IP, kept in memory. Caddy overwrites `X-Forwarded-For` from untrusted clients, so the IP cannot be spoofed through Caddy.
- `/desktop/N/*` is gated by Caddy `forward_auth` on `/api/authcheck`, which checks for a valid session only, not for ownership of slot N.

Microsoft login:

- No OAuth and no Graph. The user signs in (password, MFA) inside the remote Chromium of the slot, at `/desktop/N/`.
- The session lives in the Chromium profile `config/N/`. The agent attaches over CDP (`127.0.0.1:9222`) and reads name, email and tenant from the Teams localStorage.
- Expiry is detected from the login URL or from the "sign in again" markers; one push is sent and the login is repeated by hand.
- `config/N/` is a live Microsoft session stored unencrypted: a copy of the folder grants access to the account.

## Attachments as found

- Receive: images are fetched inside the Teams page into `data/N/media` (8 MB cap, Giphy GIFs stay public URLs). SharePoint and OneDrive files are downloaded on request with the browser session into `data/N/files` (100 MB cap, `*.sharepoint.com` only).
- Send: not implemented. Text only: no upload endpoint, no file input in the UI.
- Feasibility: in the Playwright 1.55 source (`server/dom.ts`, `server/chromium/crPage.ts`), file paths go through CDP `DOM.setFileInputFiles`, which needs the path inside the Chromium container, and in-memory payloads go through an injected page script, which works across containers. An upload therefore hands the file to the Teams upload input as a buffer. The attach-menu selectors and the upload-finished signal still need a test on live Teams.

## Multi-account state as found

Commit `7b26cb4` (2026-09-24) added up to four Teams accounts for one owner:

- Fixed slots 1 to 4, hard-coded in `docker-compose.yml`, `caddy/Caddyfile` and `SLOTS` in the web app.
- Per slot: own Chromium profile, agent, SQLite database, media and files. This isolation is reused as is.
- Shared: one login, one push device list (every device receives every account), and every session reaches every slot and every desktop.
- All Chromium containers share one Compose network. The desktop port 3000 has no password when `DESKTOP_PASS` is empty, which is the documented setting.
- The Docker socket proxy can start and stop any container on the host.

## Design weaknesses

1. Chats are identified by display name and matched by prefix (`open_chat`, `same_chat` in `agent/agent.py`). With "Luca Bianchi" and "Luca Bianchini" in the list, opening or sending to one can land in the other, and messages get stored under the wrong name.
2. Reading scrapes a virtualized UI: 40-chat and 40-message caps, Teams must run in English, a chat must be opened (and so marked read) to be read, and actions depend on a real hover and on clicks by coordinates. The network layer of the same page (CDP `Network` events) carries the data Teams renders, with conversation and message ids. It is undocumented as well and needs a spike.
3. Polling everywhere: 1 s agent loop, PWA timers at 1.4, 8, 10, 15 and 30 s.
4. One full Chromium plus desktop stream per account (`shm_size: 1gb` each), while the desktop is needed mostly for login and MFA.
5. No tests. CI checks syntax, Compose and Caddy configuration, image builds and the docs build.
6. Hosting other people's accounts means holding their live Microsoft sessions, for a product that works around a conditional access policy of their employer. Acceptable on a self-hosted instance used by known people; a public service needs a legal and security assessment first.

## Graph as an alternative

Microsoft Graph is the supported route only where the tenant allows consent to an app with `Chat.ReadWrite`. Where it does not, a signed-in browser on a server is the only route that does not involve the tenant administrator.
