# TeamsRelay local

One Microsoft Teams account relayed to a phone. Chrome or Edge on an always-on machine (workstation, mini-PC) is signed in to Teams web on a profile of its own; a Node process reads the chats, sends push notifications for new messages, and sends, replies, reacts, edits and deletes when the phone asks. Nothing reaches the machine except one small API behind a token. Design, and what comes from [teamsrelay](https://github.com/Aptul9/teamsrelay): [docs/design.md](docs/design.md).

## Requirements

- Node 24 or later (checked on 26), Google Chrome or Microsoft Edge installed.
- A desktop session on the machine: the relay browser is a normal window, where the sign-in happens.
- Teams web allowed for the account in a browser, set to English (the relay reads English texts).

## First run

```bash
npm ci --ignore-scripts
npm run setup
npm run build
npm run login
```

- `npm ci --ignore-scripts`: better-sqlite3 ships prebuilt binaries; without the flag npm tries to compile it (Visual Studio on Windows).
- `npm run setup` writes `.env` from `.env.example`, the push keys (`state/vapid`) and the API token (`state/token`), and prints the token. Run it again to see the token; it never replaces what exists.
- `npm run login` opens the relay browser on Teams. Sign in there, MFA included, and answer "Yes" to "Stay signed in?". The window closes once Teams shows the chats.

## Running

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 save
```

The relay opens its browser window on Teams. The window can stay behind other windows, on another virtual desktop or minimized; closing it only makes the relay open it again. Stop: `npx pm2 stop teamsrelay`. Log: `npx pm2 logs teamsrelay`.

Start at logon (Windows), once, after `pm2 save`:

```bash
powershell -File scripts/install-autostart.ps1
```

It registers the scheduled task `TeamsRelay` (`pm2 resurrect` at logon). A Windows service would run in session 0, where the browser window cannot be shown. On Linux: `npx pm2 startup` for the user of the desktop session. The machine must not sleep.

## Phone

The phone opens the relay address in its browser, enters the token once, and taps **Notifications**. On iPhone, notifications reach only the app added to the Home Screen (Share, "Add to Home Screen", then open it from there). Tapping a notification opens its chat; tapping a message offers reply, reactions, edit, delete, undo. **Test notification** in the menu runs a full check and answers with a push.

The relay listens on `127.0.0.1:8787`: the phone needs a way in, over HTTPS (a service worker needs a secure context). See [docs/design.md](docs/design.md), Reaching the relay. With Tailscale:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

## When Teams signs out

The relay pushes "Teams signed out" after a minute on the sign-in page or with Teams asking to sign in again; the window of the relay shows the sign-in page. Sign in there: the relay pushes "Teams back" and goes on. Commands meanwhile answer 409.

## Configuration

`.env`, every variable optional, defaults in [.env.example](.env.example): state folder, browser channel (`chrome` or `msedge`), API address and port, TLS files, VAPID contact, ntfy topic, name of the machine in alerts.

`state/` holds the browser profile (the signed-in Microsoft session), the database, images, the push private key and the API token. It is never in git; a backup of it must be encrypted.

## Log

One line per event, `<prefix>: <message> key=value`.

| Prefix | Event |
|---|---|
| `relay` | start (browser, API address, push), stop, waiting for the sign-in, configuration errors |
| `browser` | started, closed and started again, not started |
| `agent` | tab away from Teams, Teams opened again |
| `CMD` | command from the phone |
| `NEWMSG`, `MSG` | new message from the chat list, notification caught from Teams |
| `SESSION` | Teams signed out (alert pushed), signed in again |
| `push`, `ntfy` | device subscribed or gone, delivery errors |
| `api` | wrong token, request errors |
| `show`, `page`, `input`, `presence`, `identity` | chat shown in Teams, page setup, status changes, account |
| `send`, `reply`, `react`, `pill`, `edit`, `delete`, `open` | an action that did not apply on Teams, and why |

## Development

```bash
npm test
npm run lint
npm run typecheck
```

The page script tests run in the local Google Chrome on pages captured from Teams; `test/relay/relay.test.ts` runs the whole relay in one process against a page that behaves like Teams.

## Limitations

- Chats only: 1:1 and group chats, up to 40 in the list, last 40 messages of an open chat. Text only from the phone: no images, files or @mentions.
- Reading a chat from the phone opens it in Teams, which marks it read.
- Chats are identified by the name Teams shows; two chats with the same name cannot be told apart.
- While the relay runs, Teams sees an active desktop and keeps the status Available.
- A restart of the browser needs the Microsoft session to survive on disk: with "Stay signed in" off in the tenant, every restart asks for a new sign-in.
- Messages that arrive while the relay is down are not pushed afterwards; they show in the chat list.
