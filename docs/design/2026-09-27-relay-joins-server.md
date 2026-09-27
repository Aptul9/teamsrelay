# Local relay joined to a server

Date: 2026-09-27. Builds on the [local relay](2026-09-26-local-relay.md). Setup: [setup.md](../setup.md#an-account-on-another-computer). API: [api.md](../api.md#relay-of-an-account-on-another-computer).

An account of the web app can run on another computer: the browser signed in to Teams sits there (a laptop, a PC at the office), the local relay reads it, and the account shows in the web app next to the accounts of the browsers container. Only the relay opens connections, to the web app: nothing on that computer listens for the server, and no DevTools port leaves it.

```
other computer                                     server
Edge or Chrome, relay profile                      web app (Next.js)
      pipe                                           /api/relay/sync      <- rows of relay.db
node dist/relay.cjs  -- HTTPS, token of the  -->     /api/relay/commands  -> commands queued by the app
  agent loop, relay.db    account                    /api/relay/push      -> Web Push to the owner's devices
                                                     /api/relay/media     <- images, downloaded files
                                                   data/N/messages.db as for any account
```

## Account

`teams_accounts.relay_token` holds the SHA-256 of the token of an account on another computer, empty for an account of the browsers container. "Add from another computer" in the account menu takes a free slot, creates `data/N/messages.db` with the slot schema and shows the token once, with the two lines of `relay.env` that use it (`SERVER_URL`, `SERVER_TOKEN`). A new token replaces the old one at once (Settings).

The web app never asks the supervisor about these slots: the keep-alive skips them, start, stop, check modes and the remote desktop answer 409, removal deletes `data/N` and frees the slot. Their status is the health the relay last sent: older than a minute, the account reads as not connected.

## What the relay sends

The relay keeps its own `relay.db` and mirrors it into `data/N/messages.db` of its slot, about once a second while it changes (`PRAGMA data_version` of a second connection tells a change; digests per part tell what changed):

| Part of the slot database | Sent as | Server |
|---|---|---|
| `chats`, `activity`, `calls` | whole table, when it changed | replaces the table |
| `chat_messages` | the rows of each chat that changed, `[]` for a chat gone | replaces the rows of that chat |
| `readby` | rows that changed | upserts them |
| `state` | keys that changed, `null` for a key gone | sets or deletes; `viewing` only when newer (its `ts`); `relay` written by the server alone (host, time of the last sync) |
| `commands` of the server | status of each one that changed | sets the status of the command of that id |

`cmd_result:<id>` of a command of the server goes under the id of the server; statuses and results go for the commands queued in the last day. A request carries at most about 4 MB each of messages, state and "Read by", and at most 1000 chats, 1000 keys, 5000 "Read by" rows and 1000 statuses, well under what the server takes; what is left follows in the next request, at once. A row the server would refuse (a field longer than it takes) stays on the relay, logged once, and the rest goes on. The name of the computer is cut to 100 characters.

Each request carries the clock of the relay (`now`, ms). The server moves the `ts` of the health and the `seen` of a ringing call to its own clock, each as old as it was on the relay when sent: the app judges both by their age, and the clock of the other computer may be off. A health or a ringing call left from before a restart of the relay is as old on the server as it is.

Each round reads the changed rows first, then uploads the new images (`media/`) and downloaded attachments (`files/`), then sends the rows: the agent writes a file before the row that names it, so every file a row names is on the server before the row. The health and the call are read last, right before the rows go: they name no file, and uploads before them may take a while. A file that fails for the network or the server goes again at the next round and holds up nothing else. New names are checked against the server (`/api/relay/have`) and the missing files uploaded one by one. An image must be a PNG, JPEG, GIF or WebP by its first bytes. The files of an account take at most `RELAY_QUOTA_MB` on the server (2048 by default); past it the server refuses new ones, which the relay logs and leaves out. The server refuses a file by its `Content-Length` before reading it when it can (a refusal in the middle of a body may reach the relay as a reset connection), counts the bytes as they come all the same, and holds them against the room while they do: uploads side by side share it.

## What the server sends

`GET /api/relay/commands?after=<id>&vts=<ts>` answers at once when commands newer than `after` wait (pending, oldest first), or when the app shows a chat since a time newer than `vts` (`viewing`), otherwise after 25 s with nothing. The relay queues each command in `relay.db` under the key `srv-<added>-<id>` (`added`: when the account took its slot, so a slot freed and taken again starts a new series), with the time the web app queued it: a command older than two minutes fails there like any other. The image of `sendimage` is fetched first from `data/N/uploads`. The answer carries the number of devices of the owner, which the relay reports in its health.

The relay takes the clock of the server from the `Date` of each answer about commands: a difference of a second or less counts as none (`Date` has whole seconds), and it changes only by more than a second. The time of a command, and of the chat the app shows, go by the clock of the relay once there; the chat the agent opens goes to the server by the server's clock, and not before the first answer.

## Notifications

The relay does not push to devices when joined: it passes each notification (`message`, `alert`, `call`, `missedCall`) to `/api/relay/push`, one at a time in the order they came, and the agent does not wait for a message to go (a server slow to answer holds up no reading of Teams). A request gets 10 s; a notification whose turn comes over two minutes after it was raised is dropped. The web app sends it with the `Notifier` of the agents, the VAPID keys of the server (`vapid/`, already mounted in the web app) and the devices of the owner in `app.db`. The same text within 150 s goes out once, per account, as for the agents; the history of notified messages is kept in `data/N/messages.db` by the server.

## Security

The token gives exactly what the agent of a slot has: the database, media and uploads of its slot, and pushes to the owner of the slot. It is stored as a digest, compared on its digest, and refused from a web page (`Origin`). Each write checks the token again right before it happens: a request still on its way when the account is removed or gets a new token writes nothing, and the database of a slot is never created by a request of a relay. Bodies are counted as they arrive, whatever `Content-Length` says. The relay sends it over HTTPS; plain HTTP only to a server on the same machine (`localhost`, `127.0.0.1`, `[::1]`). What the relay writes reaches the app the way the agent's rows do: message HTML through DOMPurify with the allowlist of the conversation view, images served with their type and `nosniff`, files as attachments.

## Left as is

The relay keeps its own API and app on loopback; joined, it has no devices of its own. Activity feed and "Read by" are read when joined, since the web app shows them. Presence, parking on the self chat, the automatic check at 8-11 and 17-20, the alerts about sign-in and browser: as in the relay alone, the alerts naming the relay window on `HOST_LABEL`.
