# Local relay

Date: 2026-09-26. Decision: [2026-09-26-local-relay.md](../decisions/2026-09-26-local-relay.md). Setup: [setup.md](../setup.md#local-relay). API: [api.md](../api.md#local-relay).

The local relay relays one Microsoft Teams account to a phone. A browser on an always-on machine is signed in to Teams web; one Node process reads it and drives it with the agent of the server product. Notifications leave the machine as Web Push; the phone sends replies through one small authenticated API. It was built as a separate prototype and moved into this repository so that the Teams code exists once.

```
Chrome or Edge, headful            node dist/relay.cjs (pm2)
profile app/state/profile   <-->   agent loop (src/agent, shared)
      pipe, no port                app/state/relay.db (SQLite)
                                   Web Push out --> push service --> phone
                                   HTTP in <-- phone: app + API, one token
```

## Shared and apart

The agent of `app/src/agent` runs in both products. What differs is behind three seams.

| Seam | Agent of a slot (server) | Local relay |
|---|---|---|
| `BrowserSource` (`src/agent/loop.ts`): where the browser comes from, what to do without a Teams tab | `CdpBrowser` (`src/agent/cdp.ts`): the Chromium of the slot over `http://127.0.0.1:(9221+N)`, connection made again when it drops; exits after 60 s without a Teams tab, the supervisor starts it again | `BrowserKeeper` (`src/local/browser.ts`): `launchPersistentContext` on its profile, launched again when it closes (waits up to a minute between failed launches); a blank tab gets Teams after 5 s, any other page after 10 minutes (a sign-in may be in progress) |
| `PushDevices` (`src/agent/push/notifier.ts`): where the pushes go | `AppStore`: devices of the slot owner in `data/app.db`; the account is named in the payload (`acc`) and, for an owner with several accounts, in the title | `RelayDevices` (`src/local/devices.ts`): table `push_subscriptions` of `relay.db`, filled by the app |
| `AgentSettings` (`src/agent/context.ts`) | Activity feed and "Read by" on; alerts point to the remote desktop | Activity feed and "Read by" off (the app shows neither); alerts point to the relay window on `HOST_LABEL` |

Everything else is one copy: selectors and page scripts (`src/agent/teams`), actions, jobs and their order, new message detection, store (`SlotStore`, with the slot schema of `src/shared/slot-db`), notifier, VAPID keys (`scripts/gen-vapid.mjs`, `src/agent/push/vapid.ts`), command validation (`src/shared/command-input.ts`), service worker, manifest and icons (`public/`).

Left out of the relay: the web app (Next.js, better-auth, SSE), the supervisor, Compose, Caddy, Selkies, wipe, MCP, deploy, and the features the phone app does not offer (Activity feed, "Read by", @mentions, image send, SharePoint download). Their code stays in the shared agent.

## Browser

`launchPersistentContext` on `app/state/profile`, channel `chrome` or `msedge`, headful, `viewport: null`, `locale: "en-US"` and `--accept-lang=en-US` (Teams answers in the language of the browser, and a new profile takes the one of the machine: Italian on an Italian Windows, while the page scripts read English; Playwright's `locale` reaches the pages only, `--accept-lang` the workers too). Playwright drives it through `--remote-debugging-pipe`: no port is opened. The profile is not the everyday browser's, which Chrome 136 and later refuse to debug, and which should not share its Microsoft session with the relay.

Launch options against Playwright's defaults: `chromiumSandbox: true` (Playwright adds `--no-sandbox` otherwise), and `--disable-background-networking`, `--disable-component-update` and `--disable-client-side-phishing-detection` removed, so that Safe Browsing and certificate revocation lists keep updating in a browser that stays open for months. Playwright 1.63 already passes `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and `--disable-background-timer-throttling`, and no longer passes `--enable-automation`.

The window can stay behind other windows, on another virtual desktop, or minimized. Measured on Windows 11 with Chrome 153 and these launch options (2026-09-26): minimized, the page still reports itself visible, animation frames and timers keep running (164 and 30 per 3 s in a normal window, 128 and 22 minimized), layout and mouse hover events work.

When the Node process dies, Chrome loses its pipe and exits within a second (checked on Windows): a restart by pm2 finds the profile free. A lock file (`app/state/relay.lock`) keeps the relay and the sign-in from opening the profile together; its holder moves its time on every 30 s, and a lock whose process is gone, written before the machine started, not moved on for 2 minutes, or of a sign-in older than 20 minutes is taken over.

## Sign-in

`npm run relay:login` opens the browser on the profile, on Teams. The user signs in in the window, MFA included. The command waits until Teams shows the chat list and the account, prints it, waits five seconds for Teams to store its tokens, and closes the browser. A relay started meanwhile waits for the sign-in to finish. When the session expires later, the relay window itself shows the sign-in page: the sign-in happens there, no command needed.

The session lives in the profile as in a browser used every day. Whether it survives a restart of the browser depends on the tenant: "Stay signed in" gives a persistent cookie; a tenant that turns it off, or sets browser sessions to never persist, asks for a new sign-in after each restart of the browser (reboot, crash, update). The relay does not work around it.

## Notifications

Web Push with the VAPID keys of `app/state/vapid` (same generator as the server). The relay sends; the push service of the phone's browser (Google, Apple, Mozilla, Microsoft) delivers. Nothing connects to the relay for it. TTL 24 hours; urgency `high` for messages and alerts, `normal` for a check that passed (a phone on low battery asks its push service for `high` only, RFC 8030 section 5.3); a push the push service could not take is sent again after 5, 30 and 120 s, as on the server. A push names the chat of the message, and the service worker opens the app on it and keeps one notification per chat with its last lines; a notification caught from Teams names a chat only when its title is a chat of the list.

Alerts about the relay itself: Teams signed out for a minute (a redirect through the sign-in page stays silent) and back; the browser not starting for 5 minutes, and back; the automatic check twice a day. ntfy stays available as a second channel.

The app sends the subscription of its browser to the relay at every start, and shows notifications on only once the relay has it: a push service may renew a subscription, and the relay forgets one the push service reports gone. Signing out of the app removes the subscription from the relay and from the browser.

## Commands

The app queues commands through `POST /api/cmd`, the agent runs them on Teams. A command is `pending`, then `running` while the agent works on it, then `done`, `failed` (nothing reached Teams) or `unconfirmed`: a message went out with Enter but Teams did not show it sent within 15 s, or the relay stopped while it ran. An unconfirmed command is never run again; the app clears the text and says to check the chat before sending again. A command that waited more than 2 minutes (Teams signed out, browser down) ends as failed without touching Teams.

Every command of the app carries a key, kept until its outcome is known: a command sent again because its answer got lost (the app retries by itself, or the same text is sent again) reaches the relay with the same key and is queued once. Each chat keeps its own draft; an edit left unfinished never goes out in another chat, and one message goes out at a time.

## Reaching the relay

The API listens on loopback. How the phone reaches it is a network decision, left out of the code:

| Option | What it takes | Reach |
|---|---|---|
| Tailscale Serve (not Funnel) | phone and relay machine in one tailnet, HTTPS certificates enabled in the tailnet, `tailscale serve --bg --https=443 http://127.0.0.1:8787`; the relay stays on loopback | tailnet only, valid certificate, anywhere the phone has a connection |
| LAN | `RELAY_BIND` on the LAN address, `RELAY_TLS_CERT` and `RELAY_TLS_KEY` from a CA the phone trusts | home network only |
| Public port | not proposed: an open port on the Internet for one person's relay | |

Behind Tailscale Serve every phone reaches the API from `127.0.0.1`: the limit on wrong tokens applies to wrong tokens only, never to the right one.

## Running

pm2 from `app/` (`ecosystem.config.cjs`): restart after a crash with growing delays, stop through a message so that the relay closes the browser itself; an error nothing caught stops it the same way, with exit code 1. The browser window needs the desktop session of the user: a Windows service (session 0) would hide it, so `scripts/relay-autostart.ps1` registers a logon task, at normal priority, that runs `pm2 resurrect`. On Linux, `pm2 startup` for the user of the desktop session.

## Tests

- Page scripts on pages captured from live Teams and on hand-written pages, in Chrome (`test/agent/page-*.test.ts`), shared with the server product.
- The send and the reply of the agent on a page that behaves like Teams: sent, unconfirmed, refused on a draft (`test/agent/send-outcome.test.ts`).
- Web Push against a local push service that decrypts the message with the device keys (RFC 8291) and checks the VAPID signature (RFC 8292) (`test/local/webpush.test.ts`).
- API: files, token and limits, validation, keys, command outcomes, subscriptions, images, bad request targets (`test/local/api.test.ts`).
- The app in a headless Chrome against the API and an agent that stands in for the real one: lost answers, unconfirmed sends, drafts, subscriptions, sign-out (`test/local/app.test.ts`).
- The relay in one process against a page that behaves like Teams, on the real launcher: chat list, new message pushed, send confirmed, sign-out alert and recovery, browser closed and started again, exact list of pushes (`test/local/relay.test.ts`).
- Lock, browser keeper, configuration, stop of the process, logon task in dry run.
