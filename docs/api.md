# HTTP API

Every endpoint needs a session of the web app (cookie set by `/api/auth/sign-in/email`), except those marked *public*. Errors are JSON: `{"detail": "..."}`.

**Account parameter**: per-account endpoints take `?a=N`, the slot of one of the Teams accounts of the session user. Without it, the first account of the user is used. A slot of another user, or one that does not exist, answers 404 `Account not found`.

Actions on Teams are asynchronous: the answer carries the `id` of a command, and `/api/cmd/{id}` returns its outcome once the agent has seen the change on the page.

## Authentication

better-auth endpoints under `/api/auth/*`, used by the web app: `POST /api/auth/sign-in/email` `{email, password}`, `POST /api/auth/sign-out`, `POST /api/auth/change-password`, `POST /api/auth/revoke-other-sessions`. Sign-up is disabled. `change-password` answers 403 for the administrator of `.env`, whose password is `ADMIN_PASSWORD`.

## Accounts

| Method | Path | Answer |
|---|---|---|
| GET | `/api/accounts` | `{accounts: [{slot, name, email, tenant, av, teams, overall, stopped, unread, unreadActivity, missedCalls, activityIds, added, desktop, checkEvery, checked, checkResult, nextCheck, checking, relay, host, relaySeen}], max, free}`: accounts of the user, per-user cap, free slots on the server. `relay`: an account on another computer, whose relay joined this server; `host` names that computer (`""` before its first sync), `relaySeen` is its last sync (Unix seconds), and `desktop` is `""`: its Teams window is on that computer. A stopped account has `teams` `stopped` and `overall` `grey`; an account checked every few hours has `teams` `checked` and `overall` `grey` between two checks, and the health its agent writes during one. `checkEvery`: seconds between two checks, 0 for always on; `checked` and `checkResult` (`ok`, `login`, `failed`): end (Unix seconds, 0 before the first) and outcome of the last check; `nextCheck`: when the next one is due, 0 once asked; `checking`: a check runs now. `unread` counts the unread chats (muted ones and the chat with yourself left out); `unreadActivity` lists the ids of the unread items of the Teams Activity feed, `null` until the agent has saved the feed once (an empty feed is not saved), `missedCalls` the ids of every missed call of the feed that has its Teams id and `activityIds` the ids of every item, both in feed order (newest first) and `null` likewise: Teams shows a missed call as read, new or not, so the app counts the ones its device has not shown yet, and takes every item of `activityIds` as seen for an account it meets for the first time; `added` is when the account took its slot (Unix seconds), new for every account added on a freed slot |
| POST | `/api/accounts` | `{ok, slot, desktop}`. Takes the first free slot for the user and starts its browser and agent (409 when no slot is free or the cap is reached, 502/503 when the browsers container does not answer). With `{relay: true}`: an account on another computer, `{ok, slot, token, server}`; the slot gets an empty database and nothing starts here; `token` is shown this once (the server keeps its SHA-256) and goes in `SERVER_TOKEN` of the relay there, `server` (the public address of the app, `APP_URL`) in its `SERVER_URL` |
| POST | `/api/accounts/{n}/token` | `{ok, token, server}`: a new token for the relay of an account on another computer, and the address its relay joins; the previous token stops working at once. 409 for an account of this server. Owner only, administrators included: the token reads what the app sends to the account |
| PATCH | `/api/accounts/{n}` | `{running: false}` stops browser and agent of slot N and keeps its Teams session and data, `{running: true}` starts them again (a checked account comes back in service with a check asked, its browser starts with it); answers `{ok, running}`. While stopped: no sync, no notifications, commands answer 409. `{checkEvery: 3600, 7200 or 14400}` checks the account every 1, 2 or 4 hours and stops its browser now (unless a check runs), `{checkEvery: 0}` sets it always on and starts it; a stopped account given either is back in service (checked: with a check asked at once); answers `{ok, checkEvery}`, 400 for another value. The app shows one status per account: stopped (`stopped`, its `checkEvery` is the mode `{running: true}` resumes), always on, or checked every N. Between two checks commands answer 409. Owner, or an administrator |
| POST | `/api/accounts/{n}/check` | `{ok}`: the check of a checked account is due at once and starts within seconds, after the check running now if any. 409 for a stopped account or one always on. Owner, or an administrator |
| DELETE | `/api/accounts/{n}` | `{ok}`. Stops slot N and deletes its Teams session and data. For an account on another computer: deletes its data here and its token; the relay there keeps its Teams session. Owner, or an administrator |

`PATCH` and `/check` answer 409 for an account on another computer: it runs, stops and signs in there. Its commands answer 409 while its relay is not connected (no sync for a minute).

## Reading, per account

| Method | Path | Answer |
|---|---|---|
| GET | `/api/events?a=N&chat=<name>` | server-sent events: `accounts`, `health`, `chats`, `activity`, `calllog` (`[{caller, since, seconds}]`, the calls the agent saw ring, newest first, `since` in ms), `messages` (`{chat, rows, open}`: `open` the last open of that chat, `{id, status, reason?}` with `status` `pending`, `done` or `failed`, null before the first; read before the rows, so a `done` open comes with rows saved no earlier than its own), each sent when its content changes; `calls` (`[{acc, caller, since, active?, muted?}]`) lists the calls ringing now in every account of the user and the calls in progress (`active`), whichever `a` names; `muted` is the mute of Teams for a call in progress, absent while the agent cannot read it |
| GET | `/api/chats` | `name, preview, tm, unread, mention, muted, av, presence`; `presence`: the presence Teams shows on the picture of the person of a 1:1 chat, `available`, `busy`, `dnd`, `away`, `offline` or `ooo` (out of office), `""` for a group chat, a chat the last list read did not show, or a label the agent does not know |
| GET | `/api/messages?name=<chat>` | per message `mid, author, text, mine, reacts` and, when present, `html, quote, images, files, reactions, status, readby, edited, deleted, mentionsMe, av` |
| GET | `/api/activity` | `{ts, items}`, items with `id, kind, actor, title, emoji, preview, tm, chat, channel, unread, av`; `kind` is `reaction`, `mention`, `reply`, `task`, `team`, `call`, `meeting` or `message` |
| GET | `/api/feed` | history of the notifications sent |
| GET | `/api/health` | health, see below |
| GET | `/api/cmd/{id}` | `{status, result}`, `status` is `pending`, `done` or `failed`; a failed `open` has `result` `{reason}`: `signed-out` (Teams untouched), `not-listed`, `not-shown`, `unreadable`; none when it waited too long (an open waits while Teams shows no chat list) or the agent restarted while it ran |
| GET | `/media/{file}?a=N` | images of messages and profile pictures |
| GET | `/files/{file}?a=N&name=<name>` | downloaded attachment, with its original name |

## Actions, per account

| Method | Path | Body |
|---|---|---|
| POST | `/api/open` | `{name}`: opens the chat in the remote Teams. Done once Teams shows it and its messages are saved |
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
| POST | `/api/call/answer` | `{since}`: answers the call ringing now on the account, named by when it started ringing (the `since` of the event stream and of the call notification); `{ok, id, desktop}`, `desktop` the remote desktop of the account, which carries the sound where the app cannot (a browser without WebCodecs, a desktop on another site). 409 when that call no longer rings, for a stopped or checked account and for an account on another computer. A second request while the answer still waits gets the same `id` |
| POST | `/api/call/hangup` | ends the call in progress on the account; 409 without one. A second request while the hang-up still waits gets the same `id` |
| POST | `/api/call/mute` | `{on}`: the mute of Teams for the call in progress on the account, `true` muted, `false` not; the agent presses the mute shortcut of Teams only when Teams shows the other state. `{ok, id}`; 400 without a boolean `on`, 409 without a call in progress and for an account on another computer. A second request for the same state while the first still waits gets the same `id` |
| POST | `/api/call/start` | `{name}`: a Teams audio call to the person of that 1:1 chat. `{ok, id, desktop}` as for an answer; the agent opens the chat, presses the call shortcut of Teams web and is done once Teams records from the microphone. 400 without a name; 409 for a chat the list does not show as 1:1 (group, meeting, not in the list) or the self chat, while a call rings or is in progress, for a stopped or checked account and for an account on another computer. A second request while the call still waits gets the same `id`. A call not placed says why in the `result` of `/api/cmd/{id}`: `{reason}`, one of `late`, `busy`, `signed-out`, `not-listed`, `not-shown`, `not-one`, `no-call` |

## Push

| Method | Path | Body |
|---|---|---|
| POST | `/api/push/subscribe` | Web Push subscription of the device, stored for the session user |
| POST | `/api/push/fcm` | `{token, name}`: a phone of the Android app (`mobile/`), stored for the session user and forgotten when that session ends; answers `{key}`, 32 bytes base64url with which the relay seals its FCM messages (the same key while the phone stays with this user). 400 for what is not an FCM token |
| DELETE | `/api/push/fcm` | *no session*. `{token}`: forgets that phone (the app calls it once its web page is signed out) |
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
| POST | `/api/desktop/{n}` | the same without the redirect, for the desktop already on screen (the switcher of `/remote`): `{ok, shown}`, `shown` false when the window could not be brought forward. Owner only, 404 otherwise; 409 for an account on another computer; 401 without a session |
| GET | `/remote?account={n}` | the desktop tab: the one remote desktop on the whole page, opened on account N, with a small tab at the top whose arrow pulls down the accounts; the address follows the account in front. Without a session, 302 to the login |
| POST | `/mcp` | MCP endpoint for AI clients, read only: `Authorization: Bearer <MCP_TOKEN>` instead of a session, 404 while `MCP_TOKEN` is empty. Tools: [mcp.md](mcp.md) |

## Relay of an account on another computer

What the [local relay](architecture.md#local-relay) of an account on another computer calls when it joined this server ([design](design/2026-09-27-relay-joins-server.md)). `Authorization: Bearer <token>` of the account instead of a session: the token names the slot, the server compares its SHA-256. 401 with a Bearer challenge for a missing or wrong token, also when the account is removed or gets a new token while the request runs (it then writes nothing); 403 for a request with an `Origin` header (a web page). Bodies are counted as they arrive, with or without `Content-Length`: 413 past the limit of the route.

| Method | Path | Body or answer |
|---|---|---|
| POST | `/api/relay/sync` | `{host, now, chats?, messages?, state?, activity?, calls?, readby?, commands?}`: the parts of `relay.db` that changed, as the slot schema holds them. `now`: the clock of the relay when it sent the body (ms); the server moves `ts` of `health` and `seen` of a ringing `call` to its own clock from it, each as old as it was on the relay. `chats`, `activity`, `calls` replace their table; `messages` replaces the rows of each chat named (`[]` removes them); `readby` upserts; `state` sets each key, `null` deletes it, `viewing` only when newer, `relay` never (the server writes `{host, seen}` there); `commands` sets the status of commands of this server by id. Once `chats`, `messages`, `activity` or the `me` key changed, the pictures no row names any more leave `data/N/media`. At most 2000 chats, 2000 rows per chat, 5000 keys, 20000 `readby` rows, 5000 statuses: the relay sends less per request. `{ok}`, 400 with the first issues for a body out of schema, 413 above 64 MB |
| GET | `/api/relay/commands?after=<id>&vts=<ts>` | `{added, commands, viewing, devices}`: pending commands with an id above `after`, oldest first (`id, ts, type, arg1, arg2`), and the chat the app shows when its `ts` is above `vts`; at once when there are any, otherwise as soon as some come, at the latest after 25 s with none. `wait=0` answers at once. `added`: when the account took its slot, the series of its ids; `devices`: devices of the owner. The `Date` of the answer gives the relay the clock of the server, by which the times of commands (`ts`) and of `viewing` go |
| POST | `/api/relay/push` | `{op: "message", title, body, chat}`, `{op: "alert", title, body, urgency}`, `{op: "call", caller, state, since, seconds}` or `{op: "missedCall", caller, time}`: sent to the devices of the owner as the agents send them. `{ok, sent}` |
| POST | `/api/relay/have` | `{media, files}` (file names, 4 MB at most): the same shape with the ones this server lacks. The relay asks at every sync that names files: a picture the server removed is missing again |
| PUT | `/api/relay/media/{16 hex}.{png,jpg,gif,webp}` | the image, raw: 415 when its bytes are not that type, 413 above 10 MB or past the room of the account (`RELAY_QUOTA_MB`, images and attachments together, uploads at the same time included), from `Content-Length` before the body when it says so. `{ok}` |
| PUT | `/api/relay/files/{16 hex}.{ext}` | a downloaded attachment, raw, up to 100 MB and within the room of the account (413). `{ok}` |
| GET | `/api/relay/uploads/{16 hex}.{png,jpg,gif,webp}` | the image of a `sendimage` command, left by the app in `data/N/uploads` |

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
