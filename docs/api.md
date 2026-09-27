# HTTP API

Every endpoint needs a session of the web app (cookie set by `/api/auth/sign-in/email`), except those marked *public*. Errors are JSON: `{"detail": "..."}`.

**Account parameter**: per-account endpoints take `?a=N`, the slot of one of the Teams accounts of the session user. Without it, the first account of the user is used. A slot of another user, or one that does not exist, answers 404 `Account not found`.

Actions on Teams are asynchronous: the answer carries the `id` of a command, and `/api/cmd/{id}` returns its outcome once the agent has seen the change on the page.

## Authentication

better-auth endpoints under `/api/auth/*`, used by the web app: `POST /api/auth/sign-in/email` `{email, password}`, `POST /api/auth/sign-out`, `POST /api/auth/change-password`, `POST /api/auth/revoke-other-sessions`. Sign-up is disabled. `change-password` answers 403 for the administrator of `.env`, whose password is `ADMIN_PASSWORD`.

## Accounts

| Method | Path | Answer |
|---|---|---|
| GET | `/api/accounts` | `{accounts: [{slot, name, email, tenant, av, teams, overall, stopped, unread, unreadActivity, added, desktop, checkEvery, checked, checkResult, nextCheck, checking}], max, free}`: accounts of the user, per-user cap, free slots on the server. A stopped account has `teams` `stopped` and `overall` `grey`; an account checked every few hours has `teams` `checked` and `overall` `grey` between two checks, and the health its agent writes during one. `checkEvery`: seconds between two checks, 0 for always on; `checked` and `checkResult` (`ok`, `login`, `failed`): end (Unix seconds, 0 before the first) and outcome of the last check; `nextCheck`: when the next one is due, 0 once asked; `checking`: a check runs now. `unread` counts the unread chats (muted ones and the chat with yourself left out); `unreadActivity` lists the ids of the unread items of the Teams Activity feed, `null` until the agent has saved the feed once (an empty feed is not saved); `added` is when the account took its slot (Unix seconds), new for every account added on a freed slot |
| POST | `/api/accounts` | `{ok, slot, desktop}`. Takes the first free slot for the user and starts its browser and agent (409 when no slot is free or the cap is reached, 502/503 when the browsers container does not answer) |
| PATCH | `/api/accounts/{n}` | `{running: false}` stops browser and agent of slot N and keeps its Teams session and data, `{running: true}` starts them again (a checked account comes back in service with a check asked, its browser starts with it); answers `{ok, running}`. While stopped: no sync, no notifications, commands answer 409. `{checkEvery: 3600, 7200 or 14400}` checks the account every 1, 2 or 4 hours and stops its browser now (unless a check runs), `{checkEvery: 0}` sets it always on and starts it; a stopped account given either is back in service (checked: with a check asked at once); answers `{ok, checkEvery}`, 400 for another value. The app shows one status per account: stopped (`stopped`, its `checkEvery` is the mode `{running: true}` resumes), always on, or checked every N. Between two checks commands answer 409. Owner, or an administrator |
| POST | `/api/accounts/{n}/check` | `{ok}`: the check of a checked account is due at once and starts within seconds, after the check running now if any. 409 for a stopped account or one always on. Owner, or an administrator |
| DELETE | `/api/accounts/{n}` | `{ok}`. Stops slot N and deletes its Teams session and data. Owner, or an administrator |

## Reading, per account

| Method | Path | Answer |
|---|---|---|
| GET | `/api/events?a=N&chat=<name>` | server-sent events: `accounts`, `health`, `chats`, `activity`, `messages` (`{chat, rows}`), each sent when its content changes |
| GET | `/api/chats` | `name, preview, tm, unread, mention, muted, av` |
| GET | `/api/messages?name=<chat>` | per message `mid, author, text, mine, reacts` and, when present, `html, quote, images, files, reactions, status, readby, edited, deleted, mentionsMe, av` |
| GET | `/api/activity` | `{ts, items}`, items with `id, kind, actor, title, emoji, preview, tm, chat, channel, unread, av`; `kind` is `reaction`, `mention`, `reply`, `task`, `team`, `call`, `meeting` or `message` |
| GET | `/api/feed` | history of the notifications sent |
| GET | `/api/health` | health, see below |
| GET | `/api/cmd/{id}` | `{status, result}`, `status` is `pending`, `done` or `failed` |
| GET | `/media/{file}?a=N` | images of messages and profile pictures |
| GET | `/files/{file}?a=N&name=<name>` | downloaded attachment, with its original name |

## Actions, per account

| Method | Path | Body |
|---|---|---|
| POST | `/api/open` | `{name}`: opens the chat in the remote Teams |
| POST | `/api/send` | `{name, text, mentions?}`: `mentions` lists the people tagged in `text` as `@name`, by the names `/api/members` gives (up to 20); each one is picked in the Teams list of people when sent |
| POST | `/api/members` | `{name}`: `{names, id?}`, the people of the chat that can be tagged, as Teams names them, you excluded. When the names are older than an hour the agent reads them again: `id` is that command, and the answer after it has the new names |
| POST | `/api/sendimage` | multipart form: `name`, `file` (PNG, JPEG, GIF or WebP, recognized by content, up to 10 MB), `text` (caption, optional). 413 above the size, 415 for another type. The image is sent as if pasted in Teams |
| POST | `/api/reply` | `{name, mid, text}`: reply with quote |
| POST | `/api/edit` | `{name, mid, text}`: own messages only |
| POST | `/api/delete` | `{name, mid}`: own messages only |
| POST | `/api/undodelete` | `{name, mid}` |
| POST | `/api/react` | `{name, mid, emoji}` with `emoji` among `like, heart, laugh, surprised, cry, angry`; or `{name, mid, pill}` with the emoji of a reaction already under the message, removed if yours, added otherwise |
| POST | `/api/download` | `{url, name}`: `https://*.sharepoint.com` links only; the result names the file to request from `/files` |
| POST | `/api/activity/refresh` | reads the Activity feed again |
| POST | `/api/resync` | reads the chat list and the open conversation again |
| POST | `/api/recheck` | full check, outcome sent as a push |

## Push

| Method | Path | Body |
|---|---|---|
| POST | `/api/push/subscribe` | Web Push subscription of the device, stored for the session user |
| GET | `/api/vapidkey` | *public*. VAPID public key |

## Administration

Administrators only.

| Method | Path | Body or answer |
|---|---|---|
| GET | `/api/admin/users` | `{users: [{id, name, email, role, banned, managed, createdAt, slots}], slotCount, free}`; `managed` is true for the administrator of `.env` |
| POST | `/api/admin/users` | `{name, email, password, role}`, `role` is `user` or `admin` |
| DELETE | `/api/admin/users/{id}` | removes the user after stopping and wiping their slots |
| POST | `/api/admin/users/{id}/password` | `{password}`; every session of the user is revoked. 403 for the administrator of `.env` |
| DELETE | `/api/admin/users/{id}/sessions` | signs the user out of every device |

## Other

| Method | Path | Answer |
|---|---|---|
| GET | `/` | the PWA, or a redirect to `/login` |
| GET | `/healthz` | *public*. Liveness of the web app |
| GET | `/api/authcheck` | used by Caddy for `/desktop/`: 200 for a user with a Teams account, 302 to the login without a session, 403 for a user without one |
| GET | `/api/desktop/{n}` | brings the browser window of account N to the front of the remote desktop, then 302 to `/desktop/`. Owner only, 404 otherwise; without a session, 302 to the login |
| POST | `/mcp` | MCP endpoint for AI clients, read only: `Authorization: Bearer <MCP_TOKEN>` instead of a session, 404 while `MCP_TOKEN` is empty. Tools: [mcp.md](mcp.md) |

## Health (`/api/health`, `health` event)

Every field holds only when `agent` is `ok`.

| Field | Values |
|---|---|
| `agent` | `ok` when the agent updated its state in the last 60 s, otherwise `stale` |
| `teams` | `ok`, `login` (sign-in needed), `loading`, `starting` (slot just started), `err`, `unknown` |
| `watcher` | `ok` when the last read of the chat list is younger than 60 s |
| `ts`, `last_scan_ts`, `last_msg_ts` | Unix timestamps |
| `push_subs` | devices of the user |
| `overall` | `green`, `yellow`, `red` |

## Local relay

The API of the [local relay](architecture.md#local-relay) (`app/src/local/server.ts`), one listener, default `127.0.0.1:8787`, optional TLS on it. Everything under `/api/` and `/media/` needs `Authorization: Bearer <token>` (`app/state/token`, 192 bits), except those marked *public*. Wrong tokens from one address: after ten within ten minutes the wrong ones get 429 until the window ends; the right token always gets in (behind `tailscale serve` every phone comes from `127.0.0.1`). No CORS headers, no cookies. The app page carries a Content Security Policy that loads nothing from outside; messages are inserted as text only. Errors are JSON, `{"detail": "..."}`; a request target that is not a URL gets 400.

| Method | Path | Answer |
|---|---|---|
| GET | `/`, `/app.js`, `/app.css`, `/sw.js`, `/manifest.webmanifest`, `/static/icon-*.png` | *public*. The app |
| GET | `/healthz` | *public*. `{ok}` |
| GET | `/api/vapid` | *public*. `{key}`, the VAPID public key the devices subscribe with, `""` while push is off |
| GET | `/api/state` | `{health, me, chats, active, devices, push}`: health as for the web app, plus `browser: "down"` while the browser does not start; account; chats with `name, preview, time, unread, mention, muted`; the chat Teams has open; number of devices; whether push is on |
| GET | `/api/messages?chat=` | `{chat, open, messages}`, messages as text: `mid, author, text, mine, quote, images, files, reactions, status, edited, deleted, mentionsMe`. When Teams has the chat open (`open`), it stays open while the app keeps asking |
| POST | `/api/cmd` | `{type, chat, mid?, text?, emoji?, pill?, key?}`, types `open`, `send`, `reply`, `react`, `edit`, `delete`, `undodelete`, `resync`, `recheck`. Waits up to 30 s and answers `{id, status}`. `key` (8 to 64 of `A-Z a-z 0-9 _ -`): a command with a key already queued is not queued again, its id and status come back. 409 while Teams is signed out, 503 while the relay does not read Teams or its browser does not start |
| GET | `/api/cmd/{id}` | `{id, status}` |
| POST | `/api/push` | Web Push subscription of the device (`PushSubscription.toJSON()`): `{ok, devices}` |
| DELETE | `/api/push` | `{endpoint}`: the subscription removed, `{ok, devices}` |
| GET | `/media/{16 hex}.{png,jpg,gif,webp}` | images saved from messages |

Command status: `pending` (queued), `running` (on Teams now), `done` (Teams shows the change), `failed` (not applied on Teams; also a command that waited more than 2 minutes), `unconfirmed` (a message went out and Teams did not show it sent in time, or the relay stopped while running it: it may have reached Teams and is never run again). The web app answers with `pending`, `done` and `failed` only, as before.
