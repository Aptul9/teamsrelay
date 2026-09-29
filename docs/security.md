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
- A device receives the notifications of its user only: the agent of slot N pushes to the subscriptions of the owner of N. A phone of the Android app registered by another user gets a new key, so the messages sealed for the previous one stay closed to it.
- FCM messages to the Android app carry ciphertext only (AES-256-GCM, one key per phone, answered to each registration over HTTPS with the session cookie), as Web Push payloads do. The service account key (`fcm/service-account.json`) has the role Firebase Cloud Messaging API Admin only: it sends messages to the phones of the app, nothing else in the Google project. `DELETE /api/push/fcm` needs no session: knowing the token of a phone is what lets it be forgotten. A phone gets pushes only as long as the session that registered it lasts: signed out, signed out by **Sign out every other device** or a password change, or run out (the 30-day session of the web app), it gets nothing more. ntfy, when enabled, carries titles and texts in clear to its server.

## MCP endpoint

- `/mcp` answers only when `MCP_TOKEN` is set (404 otherwise). Its bearer reads every chat TeamsRelay holds for the administrator of `.env` and can open a chat in Teams (`refresh_chat`, which marks it read): keep the token like a password, out of files that go to git.
- The token is compared in constant time. No session cookie counts on `/mcp`, and a request carrying an `Origin` header (a web page) answers 403, so a page open in a browser signed in to TeamsRelay cannot use the endpoint.
- No tool writes to Teams. Message texts reach the model as data written by other people; a client that also has tools reaching the network or the shell can still be steered by them.

## Remote desktop

- `/desktop/` is the desktop of the browsers container: the browser window, and the live Teams session, of every account. Caddy asks `/api/authcheck` before every request: no session means a redirect to the login, a user without a Teams account gets 403.
- Every Teams account of the server belongs to one person ([decision](decisions/2026-09-26-single-container.md)). A second user with an account would see the windows of the others on the desktop.
- Port 3000 of `browsers` has no password of its own (`DESKTOP_PASS` empty) and is reachable only on network `desktop`, shared with Caddy alone.

## Browsers container

- The web app has no access to Docker, and no container mounts the Docker socket. The web app asks the supervisor of the browsers container, on a unix socket in the volume `control` (mode 600, owned by root), to start, stop, wipe or show an account.
- Chromium runs as `abc` with its sandbox: renderers in a seccomp filter and in their own user and PID namespaces. `abc` is not in the `sudo` group of the image.
- `data/`, `vapid/`, `fcm/` and the control socket are mounted under `/root` (mode 700): the agents and the supervisor, running as root, reach them; the browsers do not. The web app mounts `vapid/` and `fcm/` read-only as well: it sends the notifications of the accounts on another computer.
- DevTools of each browser listen on `127.0.0.1:(9221+N)` without authentication, so every process of the container reaches every browser. They refuse connections that carry a web origin: a web page cannot open them.
- A browser that escapes its sandbox reaches every profile under `/profiles` and every DevTools port: every account has the same owner.

## Data at rest

- `config/N/` is the Microsoft session of account N, stored unencrypted by Chromium. Protect the server and encrypt the backups.
- Only the browsers container mounts `config/`; the web app, the component exposed to the Internet, mounts no profile. The supervisor deletes `config/N/` only on a request of the web app and only while account N is stopped.
- Never publish `.env`, `config/`, `data/`, `vapid/`, `fcm/`: they are in `.gitignore` and the deploy neither copies nor touches them. The `google-services.json` of the Android app lives in the repository secret `GOOGLE_SERVICES_JSON`, not in git.

## Content

- The HTML of messages is rebuilt by the agent from a short list of tags, validated colours and http(s) links, with the text always escaped; the browser sanitizes it again before rendering.
- Downloads accept only `https://*.sharepoint.com` links. Files are stored under hashed names and served only to the owner of the slot, with `nosniff` and as attachments.
- Images to send are accepted only from the owner of the slot, up to 10 MB, and only when their first bytes are a PNG, JPEG, GIF or WebP; they are stored under random names in `data/N/uploads`, never served back, and deleted once the agent has sent them (after a day at the latest). The agent reads only names of that form.

## Deploy

- Dedicated SSH key for a user without password, host key pinned in the repository secrets, no `StrictHostKeyChecking=no`.
- Dependabot keeps images, Actions and packages current. Keep the Chromium image up to date: it renders untrusted web content.

## Local relay

- The relay holds the live Microsoft session of its account in `app/state/profile`, unencrypted as in any browser profile, next to the push private key and the API token. `app/state/` and `app/relay.env` are in `.gitignore` and in `app/.dockerignore`: they never reach git or an image.
- The profile is its own, never the everyday browser profile. The browser runs with its sandbox, driven over a pipe: no DevTools port is opened.
- One API, on loopback unless the owner binds it elsewhere. Everything but the app page, its files, `/healthz` and the VAPID public key needs the bearer token (192 bits, compared in constant time). Wrong tokens are limited per address; the right one never is. No CORS headers and no cookies: a web page cannot use the API from the phone's browser.
- The app page carries a Content Security Policy that loads nothing from outside, and inserts every message as text, never as HTML. Images are served by name only (16 hex characters and an image extension).
- The token stays in the browser of the phone (`localStorage`). Signing out of the app forgets it and removes the push subscription of that phone from the relay and from the browser; a new token (delete `state/token`, run `npm run relay:setup`, restart the relay) signs every phone out.

## Account on another computer

- The token of the account (256 bits) is shown once when the account is added, or when its owner makes a new one; the server keeps only its SHA-256, and looks a token up by its digest. It gives what the agent of a slot has: the database, media and uploads of that one slot, and notifications to its owner. It opens no session of the web app and reads no other account.
- `/api/relay/*` refuses requests with an `Origin` header (a web page), and takes no cookie. The relay sends the token over HTTPS; `http://` only to a server on the same machine.
- Only the owner of the account makes a new token (`POST /api/accounts/{n}/token`), administrators included: whoever holds the token reads what the app sends to the account.
- Each write checks the token again right before it happens, with nothing awaited in between: a request still on its way when the account is removed, or gets a new token, writes nothing, neither into an account added on the same slot since nor into a folder brought back (the slot database is never created by a relay request). A notification on its way then reaches no device.
- Bodies are counted as they arrive, whatever `Content-Length` says, and files as they are written; an account keeps at most `RELAY_QUOTA_MB` of images and attachments on the server, uploads at the same time included (their bytes are held against the room as they come).
- What a relay writes reaches the app like the rows of an agent: message HTML through DOMPurify with the allowlist of the conversation view, images stored only when their first bytes are the type their name says and served with `nosniff`, attachments served as downloads. Names are checked against the patterns of the slot folders before any file is written; a file is written whole or not at all.
- The relay holds the Microsoft session of the account on its computer (`app/state/profile`), and the token in `app/relay.env`: protect that computer like the server. Removing the account on the server, or a new token, shuts the relay out at once.
