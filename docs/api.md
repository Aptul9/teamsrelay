# HTTP API

Every endpoint needs a session of the web app (cookie set by `/api/auth/sign-in/email`), except those marked *public*. Errors are JSON: `{"detail": "..."}`.

**Account parameter**: per-account endpoints take `?a=N`, the slot of one of the Teams accounts of the session user. Without it, the first account of the user is used. A slot of another user, or one that does not exist, answers 404 `Account not found`.

Actions on Teams are asynchronous: the answer carries the `id` of a command, and `/api/cmd/{id}` returns its outcome once the agent has seen the change on the page.

## Authentication

better-auth endpoints under `/api/auth/*`, used by the web app: `POST /api/auth/sign-in/email` `{email, password}`, `POST /api/auth/sign-out`, `POST /api/auth/change-password`, `POST /api/auth/revoke-other-sessions`. Sign-up is disabled. `change-password` answers 403 for the administrator of `.env`, whose password is `ADMIN_PASSWORD`.

## Accounts

| Method | Path | Answer |
|---|---|---|
| GET | `/api/accounts` | `{accounts: [{slot, name, email, tenant, av, teams, overall, stopped, unread, desktop}], max, free}`: accounts of the user, per-user cap, free slots on the server. A stopped account has `teams` `stopped` and `overall` `grey` |
| POST | `/api/accounts` | `{ok, slot, desktop}`. Takes the first free slot for the user and starts its browser and agent (409 when no slot is free or the cap is reached, 502/503 when Docker does not answer) |
| PATCH | `/api/accounts/{n}` | `{running: false}` stops browser and agent of slot N and keeps its Teams session and data, `{running: true}` starts them again; answers `{ok, running}`. While stopped: no sync, no notifications, commands answer 409. Owner, or an administrator |
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
| GET | `/api/authcheck` | used by Caddy for `/desktop/N/`: 200 for the owner of slot N, 302 to the login without a session, 403 for another user |

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
