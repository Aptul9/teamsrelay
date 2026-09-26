# Security

TeamsRelay holds live Microsoft sessions. Whoever controls the server, a session of the web app or a copy of `config/N/` controls the Teams accounts behind them.

## Users and sessions

- Users are created by an administrator; there is no public sign-up. Passwords of at least 10 characters, hashed by better-auth (scrypt).
- The administrator of `.env` (`ADMIN_EMAIL`) signs in with `ADMIN_PASSWORD`. Its password changes only in `.env`: at the next start the new value replaces the old one and signs it out of every device, which is also the way back in after a lost password.
- Sessions are stored in `data/app.db`, one per device, valid 30 days and extended while in use. A user can sign out the other devices from **Settings**; an administrator can sign out every device of a user.
- Cookies are `HttpOnly` and, behind HTTPS, `Secure`. Changing `BETTER_AUTH_SECRET` signs every user out.
- better-auth limits sign-in attempts per client IP. Caddy overwrites `X-Forwarded-For` coming from clients, so the IP cannot be spoofed through Caddy.

## Ownership

- Every Teams account (slot) has one owner. Every per-account endpoint (`?a=N`), `/media`, `/files`, `/api/cmd` and the event stream answer only for slots of the session user; another user's slot answers 404, like a slot that does not exist.
- Administrators manage users and can free a slot. They do not read other users' chats and do not reach their desktops.
- A device receives the notifications of its user only: the agent of slot N pushes to the subscriptions of the owner of N.

## MCP endpoint

- `/mcp` answers only when `MCP_TOKEN` is set (404 otherwise). Its bearer reads every chat TeamsRelay holds for the administrator of `.env` and can open a chat in Teams (`refresh_chat`, which marks it read): keep the token like a password, out of files that go to git.
- The token is compared in constant time. No session cookie counts on `/mcp`, and a request carrying an `Origin` header (a web page) answers 403, so a page open in a browser signed in to TeamsRelay cannot use the endpoint.
- No tool writes to Teams. Message texts reach the model as data written by other people; a client that also has tools reaching the network or the shell can still be steered by them.

## Remote desktops

- `/desktop/N/` is the browser of slot N, the live Teams session of its owner. Caddy asks `/api/authcheck` before every request: no session means a redirect to the login, a session of another user means 403.
- Port 3000 of `chromium-N` has no password of its own (`DESKTOP_PASS` empty) and is reachable only on network `slotN`, shared with Caddy alone.
- CDP (`9222`) listens on `127.0.0.1` inside the network namespace shared by `chromium-N` and `agent-N`, without authentication. The agents stay one process per slot for this reason: a single process for every slot would need CDP on the slot networks.

## Docker

- The web app reaches Docker only through `dockerproxy`, which allows `POST` on `/containers/teams-(chromium|agent)-N/(start|stop)` and `/containers/teams-wipe-N/(start|wait)`, and refuses every other method, path and container (checked: 403 on another container, on `stop` of a wipe container and on create, 405 on list).
- The proxy runs read-only, without capabilities, on the internal network `control`, reachable only from the web app.

## Data at rest

- `config/N/` is the Microsoft session of slot N, stored unencrypted by Chromium. Protect the server and encrypt the backups.
- Only `chromium-N` and `wipe-N` mount `config/N/`; the web app, the component exposed to the Internet, mounts no profile. `wipe-N` runs without network, on a read-only filesystem, without capabilities, as the owner of the profile, and deletes only on a request of the web app.
- Never publish `.env`, `config/`, `data/`, `vapid/`: they are in `.gitignore` and the deploy neither copies nor touches them.

## Content

- The HTML of messages is rebuilt by the agent from a short list of tags, validated colours and http(s) links, with the text always escaped; the browser sanitizes it again before rendering.
- Downloads accept only `https://*.sharepoint.com` links. Files are stored under hashed names and served only to the owner of the slot, with `nosniff` and as attachments.
- Images to send are accepted only from the owner of the slot, up to 10 MB, and only when their first bytes are a PNG, JPEG, GIF or WebP; they are stored under random names in `data/N/uploads`, never served back, and deleted once the agent has sent them (after a day at the latest). The agent reads only names of that form.

## Deploy

- Dedicated SSH key for a user without password, host key pinned in the repository secrets, no `StrictHostKeyChecking=no`.
- Dependabot keeps images, Actions and packages current. Keep the Chromium image up to date: it renders untrusted web content.
