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
- Administrators manage users and can free a slot. They do not read other users' chats; the remote desktop opens only for users with a Teams account.
- A device receives the notifications of its user only: the agent of slot N pushes to the subscriptions of the owner of N.

## Remote desktop

- `/desktop/` is the desktop of the browsers container: the browser window, and the live Teams session, of every account. Caddy asks `/api/authcheck` before every request: no session means a redirect to the login, a user without a Teams account gets 403.
- Every Teams account of the server belongs to one person ([decision](decisions/2026-09-26-single-container.md)). A second user with an account would see the windows of the others on the desktop.
- Port 3000 of `browsers` has no password of its own (`DESKTOP_PASS` empty) and is reachable only on network `desktop`, shared with Caddy alone.

## Browsers container

- The web app has no access to Docker, and no container mounts the Docker socket. The web app asks the supervisor of the browsers container, on a unix socket in the volume `control` (mode 600, owned by root), to start, stop, wipe or show an account.
- Chromium runs as `abc` with its sandbox: renderers in a seccomp filter and in their own user and PID namespaces. `abc` is not in the `sudo` group of the image.
- `data/`, `vapid/` and the control socket are mounted under `/root` (mode 700): the agents and the supervisor, running as root, reach them; the browsers do not.
- DevTools of each browser listen on `127.0.0.1:(9221+N)` without authentication, so every process of the container reaches every browser. They refuse connections that carry a web origin: a web page cannot open them.
- A browser that escapes its sandbox reaches every profile under `/profiles` and every DevTools port: every account has the same owner.

## Data at rest

- `config/N/` is the Microsoft session of account N, stored unencrypted by Chromium. Protect the server and encrypt the backups.
- Only the browsers container mounts `config/`; the web app, the component exposed to the Internet, mounts no profile. The supervisor empties `config/N/` only on a request of the web app and only while account N is stopped.
- Never publish `.env`, `config/`, `data/`, `vapid/`: they are in `.gitignore` and the deploy neither copies nor touches them.

## Content

- The HTML of messages is rebuilt by the agent from a short list of tags, validated colours and http(s) links, with the text always escaped; the browser sanitizes it again before rendering.
- Downloads accept only `https://*.sharepoint.com` links. Files are stored under hashed names and served only to the owner of the slot, with `nosniff` and as attachments.
- Images to send are accepted only from the owner of the slot, up to 10 MB, and only when their first bytes are a PNG, JPEG, GIF or WebP; they are stored under random names in `data/N/uploads`, never served back, and deleted once the agent has sent them (after a day at the latest). The agent reads only names of that form.

## Deploy

- Dedicated SSH key for a user without password, host key pinned in the repository secrets, no `StrictHostKeyChecking=no`.
- Dependabot keeps images, Actions and packages current. Keep the Chromium image up to date: it renders untrusted web content.
