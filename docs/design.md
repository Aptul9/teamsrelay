# Design

TeamsRelay local relays one Microsoft Teams account to a phone. A browser on an always-on machine is signed in to Teams web; a Node process reads it and drives it. Notifications leave the machine as Web Push; the phone sends replies through one small authenticated API. It is cut out of [teamsrelay](https://github.com/Aptul9/teamsrelay) (`main` `1c50fa6`), a multi-user server product with one containerized browser per account.

## Why not teamsrelay as it is

teamsrelay runs every Teams account in a linuxserver/chromium container, shown through a Selkies remote desktop behind Caddy, and an agent attached over the Chrome DevTools port. For one personal account the containers, the remote desktop, the reverse proxy and the multi-slot web app add weight and no value, and the sign-in through a streamed desktop is the fragile part. Registering an Entra application (Microsoft Graph) is not possible in the tenant, so Teams web in a browser stays the interface.

Rejected: Graph/MSAL (no app registration), token tools such as TokenSmith, roadtx or TokenTactics (API bearer tokens instead of a web session, first-party client impersonation, detected and blocked by Conditional Access), copying cookies or a profile from an enrolled machine (the device PRT is TPM-bound, DPAPI and App-Bound Encryption block the copy, the session dies at the first Conditional Access refresh), remote browser streaming (works, pointless for one account), and `connectOverCDP` to the everyday browser (Chrome 136 and later ignore remote debugging on the default user data directory).

## What the teamsrelay agent did

`app/agent.cjs` is the esbuild bundle of `app/src/agent`, one process per account, attached with `connectOverCDP` to `http://127.0.0.1:(9221+N)`. It exited after 60 s without a Teams tab and the supervisor started it again.

The loop runs about one round a second. Each step is a job of `scheduler.ts`, every N rounds at an offset, or every N seconds:

| Every | Job |
|---|---|
| round | page made visible and focused (init script), notification hook installed |
| 60 s | real mouse and Shift through CDP, so Teams keeps the user Available |
| 5 rounds | parking: the chat the app shows, otherwise the self chat |
| round | notifications caught by the hook, pushed (secondary source) |
| round | queued commands, chat list read after each |
| 300 rounds | full chat list, scrolled (the list is virtualized) |
| 3 rounds | visible chat list: previews, unread, muted, pictures; new message detection |
| 150 rounds | Activity feed (switches view and back) |
| 300 rounds | identity: name, email, tenant, picture |
| 5 rounds, sign-in page included | health; one push when the session expires |
| round | open conversation saved |
| 2 rounds | "Read by" of recent own messages in group chats |
| 8-11, 17-20 | automatic check with a push of the outcome |

Selectors and the English texts it reads are in `teams/selectors.ts`; the page scripts in `teams/scripts/` run inside the page with selectors passed as arguments. The Defender for Cloud Apps proxy suffix (`.mcas.ms`) is stripped from hosts.

Actions, each checked on the page before it counts as done: send (text typed, send button or Enter, not checked: always done), reply with quote (hover bar or More options), reactions (four on the bar, two in the picker), toggle of a reaction pill, edit (inline editor, draft discarded on failure), delete, undo delete, plus image paste, @mentions, member list and "Read by".

Commands came from the web app as rows of `data/N/messages.db` (`commands`, 14 types); the agent wrote the outcome after saving the conversation.

Push triggers: a chat whose preview or time changes with an incoming text, or that turns unread (not muted, not the self chat), deduplicated for 150 s; a notification caught from Teams; the session expired; the automatic check; the recheck command. Web Push went to the devices of the slot owner in `data/app.db`, TTL one hour, subscriptions answered 404 or 410 removed; ntfy optional.

## What changed

```
Chrome or Edge, headful          relay (one Node process)
own profile state/profile  <-->  agent loop (reused)
       pipe, no port             state/relay.db (SQLite)
                                 Web Push out --> push service --> phone
                                 HTTP in <-- phone: app + API, one token
```

| Part | Fate |
|---|---|
| `teams/selectors.ts`, page scripts, `teams/page.ts`, actions reply, react, pill, edit, delete, undo | reused as they were, entries of features left out removed |
| send | reused, now refused on a non-empty compose box and done only once Teams shows the message sent |
| `logic/*`, `scheduler.ts`, `log.ts`, `media.ts` (images, pictures), jobs page, chats, conversation, identity, self-check | reused |
| `store/slot-store.ts`, `shared/slot-db` | reused; one database, `push_subscriptions` added, commands older than 120 s expire unrun |
| `push/vapid.ts`, `push/notifier.ts`, `scripts/gen-vapid.mjs` | reused; devices from the relay database, no owner or slot label, `alert()` for messages about the relay itself |
| health and session push | reused; pushed after 60 s of sign-out (a redirect through the sign-in page stays silent), a page away from Teams counts as sign-in, recovery pushed, browser that does not start pushed after 5 minutes |
| `loop.ts` connection, `main.ts`, `config.ts` | rewritten: `launchPersistentContext`, browser launched again when it closes, Teams reopened on a blank tab, `run`, `login`, `--check` |
| `app-store.ts`, web app (Next.js, better-auth, SSE, 30 routes), supervisor, Compose, Caddy, Selkies, wipe, MCP, CI deploy | dropped |
| web app command validation and queue (`lib/commands.ts`, `lib/slotdb.ts`) | reused in `src/relay/server.ts`, a `node:http` server |
| `public/sw.js`, manifest, icons, `lib/push.ts` | reused; the app is rewritten as one page without a build step |
| Activity feed, "Read by", @mentions, image send, SharePoint download | left out; their page scripts are in teamsrelay |

Git history shows the reuse: the first commit is the verbatim copy, every change to it is a later commit.

## Browser

`launchPersistentContext` on `state/profile`, channel `chrome` or `msedge`, headful, `viewport: null`. Playwright drives it through `--remote-debugging-pipe`: no port is opened. The profile is not the everyday browser's, which Chrome 136 and later refuse to debug, and which should not share its Microsoft session with the relay.

Launch options against Playwright's defaults: `chromiumSandbox: true` (Playwright adds `--no-sandbox` otherwise), and `--disable-background-networking`, `--disable-component-update` and `--disable-client-side-phishing-detection` removed, so that Safe Browsing and certificate revocation lists keep updating in a browser that stays open for months. Playwright 1.63 already passes `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`, and no longer passes `--enable-automation`.

The session lives in the profile as in a browser used every day. Whether it survives a restart of the browser depends on the tenant: "Stay signed in" gives a persistent cookie; a tenant that turns it off, or sets browser sessions to never persist, asks for a new sign-in after each restart of the browser (reboot, crash, update). The relay does not work around it.

When the Node process dies, Chrome loses its pipe and exits within a second (checked on Windows): a restart by pm2 finds the profile free. A lock file keeps the relay and the sign-in from opening the profile together.

## Sign-in

`npm run login` opens the browser on the profile, on Teams. The user signs in in the window, MFA included. The command waits until Teams shows the chat list and the account, prints it, waits five seconds for Teams to store its tokens, and closes the browser. When the session expires later, the relay window itself shows the sign-in page: the sign-in happens there, no command needed.

## Notifications

Web Push with the VAPID keys of `state/vapid` (reused generator). The relay sends; the push service of the phone's browser (Google, Apple, Mozilla, Microsoft) delivers. Nothing connects to the relay for it. TTL one hour.

A device subscribes from the app: the service worker needs a secure context, so the phone loads the app over HTTPS (or from `localhost` on the machine itself). ntfy stays available as a second channel.

## API

One listener, default `127.0.0.1:8787`, optional TLS on it. Everything under `/api/` and `/media/` needs `Authorization: Bearer <token>` (`state/token`, 192 bits); ten wrong tokens from an address within ten minutes get 429. No CORS headers, no cookies: another site cannot call it from the phone's browser. The app page has a Content Security Policy that loads nothing from outside and messages are inserted as text only.

| Method | Path | Answer |
|---|---|---|
| GET | `/`, `/app.js`, `/app.css`, `/sw.js`, `/manifest.webmanifest`, icons | the app, public |
| GET | `/healthz` | `{ok}`, public |
| GET | `/api/vapid` | `{key}`, public key for the subscription, public |
| GET | `/api/state` | `{health, me, chats, active, devices, push}` |
| GET | `/api/messages?chat=` | `{chat, open, messages}`; when Teams has the chat open, it stays open while the app polls |
| POST | `/api/cmd` | `{type, chat, mid?, text?, emoji?, pill?}`, types `open`, `send`, `reply`, `react`, `edit`, `delete`, `undodelete`, `resync`, `recheck`; waits up to 30 s, answers `{id, status}` with `done`, `failed` or `pending`; 409 while Teams is signed out, 503 while the relay cannot read Teams |
| GET | `/api/cmd/{id}` | `{id, status}` |
| POST, DELETE | `/api/push` | Web Push subscription of the device, stored or removed |
| GET | `/media/{16 hex}.{png,jpg,gif,webp}` | images saved from messages |

## Reaching the relay

The API listens on loopback. How the phone reaches it is a network decision, left out of the code:

| Option | What it takes | Reach |
|---|---|---|
| Tailscale Serve (not Funnel) | phone and relay machine in one tailnet, HTTPS certificates enabled in the tailnet, `tailscale serve --bg --https=443 http://127.0.0.1:8787`; the relay stays on loopback | tailnet only, valid certificate, anywhere the phone has a connection |
| LAN | `RELAY_BIND` on the LAN address, `RELAY_TLS_CERT`/`RELAY_TLS_KEY` from a CA the phone trusts | home network only |
| Public port | not proposed: an open port on the Internet for one person's relay | |

## Running

pm2 from the project (`ecosystem.config.cjs`): restart after a crash with growing delays, stop through a message so that the relay closes the browser itself. The browser window needs the desktop session of the user: a Windows service (session 0) would hide it, so `scripts/install-autostart.ps1` registers a logon task running `pm2 resurrect`. On Linux, `pm2 startup` for the user of the desktop session.

The window can stay behind other windows, on another virtual desktop, or minimized. Measured on Windows 11 with Chrome 153 and these launch options (2026-09-26): minimized, the page still reports itself visible, animation frames and timers keep running (164 and 30 per 3 s in a normal window, 128 and 22 minimized), layout and mouse hover events work.

## Tests

- Page scripts on pages captured from live Teams (teamsrelay fixtures) and on hand-written pages, in Chrome.
- Agent logic, commands, store, scheduler, as in teamsrelay.
- Web Push against a local push service that decrypts the message with the device keys (RFC 8291) and checks the VAPID signature (RFC 8292).
- API: files, token, limits, validation, command outcomes, subscriptions, images.
- The relay in one process against a page that behaves like Teams: chat list, new message pushed, send confirmed, sign-out alert and recovery, browser closed and started again, exact list of pushes.
