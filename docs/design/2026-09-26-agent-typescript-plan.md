# Agent in TypeScript: implementation plan

Decision: [2026-09-26-agent-typescript.md](../decisions/2026-09-26-agent-typescript.md).

**Goal:** the agent of `agent/agent.py` rewritten in TypeScript inside the web app package, so the project is one Node codebase, with the same behaviour on Teams and the same SQLite contract.

**Architecture:** one package (`app/`, formerly `webapp/`), one image `teamsrelay` with two entrypoints: `node server.js` (web app) and `node agent.cjs` (agent). One agent process per slot stays in the network namespace of `chromium-N`, because Chrome DevTools listens on `127.0.0.1:9222` there without authentication.

**Stack:** Node 24, TypeScript 6.0, playwright-core 1.63.0 (`connectOverCDP`), better-sqlite3 13, zod 4, web-push 3.6, esbuild 0.28 for the agent bundle, Vitest 5 with Google Chrome for the page script tests.

## Constraints

- The tables, columns, command types and statuses and state keys of `data/N/messages.db` do not change. A slot runs the Python agent or the Node agent on the same database.
- The VAPID keys in `vapid/` stay: the private key PEM derives the public key of `appkey.txt`, so no device subscribes again.
- Push TTL: 1 hour for every push (pywebpush sent 0, web-push defaults to 4 weeks).
- Teams web stays in English. Hosts may carry the Defender for Cloud Apps suffix (`.mcas.ms`, `.mcas-gov.us`, `.mcas-gov.ms`).
- Page scripts are TypeScript functions passed to `page.evaluate`, self-contained, with the selectors of `src/agent/teams/selectors.ts` passed as argument.
- Files under about 300 lines, one handler per command, environment checked at start, English log lines with stable prefixes.

## Phases

1. Package move, shared contract (`src/shared/slot-db`), configuration, logger, scheduler, stores, pure decisions, the 21 Python tests ported.
2. Selectors and page scripts, Chrome tests on fixtures: the existing synthetic ones and fixtures captured from live Teams (structure only, invented names) for the chat list, a conversation, the hover toolbar and the Activity feed.
3. Page actions, jobs, command handlers, push, loop and entrypoint; esbuild bundle; one image; Compose, CI, Dependabot; `scripts/gen-vapid.mjs`.
4. Local stack: Node agent on slot 2 while slot 1 runs Python, then the other way round, then both on Node. Live parity checks on both accounts, sends only to the self chats. Memory against the Python agent.
5. Python removed: `agent/`, `tools/`, the Python CI step, pip in Dependabot. Documentation.
6. Pull request with CI green. Deploy after an explicit approval, with a Pre-Mortem.

## Parity checklist

Built from `agent/agent.py` at `15ea59f`. Each item is closed by a test (file under `app/test/`) or a live check on the local stack (phase 4).

### Loop and schedule

- [ ] Round about every second; all pending commands each round in id order, a chat list read after each command.
- [ ] Chat list every 3 rounds; full list every 300 rounds (offset 1) while Teams is ok.
- [ ] Activity feed every 150 rounds (offset 5) while Teams is ok.
- [ ] Identity every 300 rounds (offset 7), or every round while unknown, while Teams is ok.
- [ ] Health every 5 rounds, on the sign-in page too.
- [ ] Open conversation saved every round while a chat is active.
- [ ] Read-by prefetch every 2 rounds when the open chat is the wanted one, Teams is ok and no command is pending.
- [ ] Input every 60 s: mouse to (6,6) and (2,2), then Shift.
- [ ] Parking every 5 rounds (offset 2) when no command is pending and the open chat is not the wanted one.
- [ ] Automatic check 8-11 and 17-20 once per `hc_YYYYMMDD_am|pm` key, with a push of the outcome.

### New messages

- [ ] First list primes the state without notifying.
- [ ] Self chat and muted chats never notify; outbound previews (`You:`, `Tu:`) are not incoming.
- [ ] Incoming preview or time change of a known chat, or a chat turning unread, notifies once per preview|time|unread key.
- [ ] Push dedup: same lowercased body (first 60 characters) within 150 s is pushed once.
- [ ] Each notification: `messages` row, ntfy when enabled, push; `NEWMSG` log line.
- [ ] Teams notification hook as second source: `__HEALTHCHECK__`, "Nice job" and "Notifications are now on" skipped.

### Chat list

- [ ] Collapsed Chats and Favorites sections are opened; only level-2 rows under them are chats.
- [ ] Name, time and preview parsed with status words removed; unread, mention, muted, picture; 40 chats at most.
- [ ] Merge: visible chats first, the others kept, known pictures kept.
- [ ] Full read scrolls up to 8 pages from the top, back to the top, one transaction.

### Conversation and media

- [ ] Title of the open chat checked: a prefix matches only when the title is not another chat of the list.
- [ ] Last 40 messages: text with emoji `alt`, reduced HTML (known tags, checked colours, http(s) links, mentions), quote, images, files, reactions, status, edited, deleted, `mentionsMe`, author carried over, avatar.
- [ ] Images fetched in the page (8 MB cap), failures remembered, public https URL kept as fallback; names `sha1(chat|mid|i)[:16]` with the extension of the content type.
- [ ] Profile pictures copied through a canvas, `sha1(src)[:16].png`; budget 8 per list read, 20 per full-list page, 40 for the Activity feed, 1 for the identity.
- [ ] `extra` holds only the fields with a value; read-by merged into your messages.

### Commands

- [ ] `open`: marks viewing, opens, sets `active_chat`, saves the conversation; done even when the chat did not open.
- [ ] `send`: marks viewing, types and sends, sets `active_chat`, saves; done even when sending failed.
- [ ] `resync`: chat list without pictures, open conversation; done.
- [ ] `recheck`: full check, push of the outcome; done.
- [ ] `activity`: done or failed.
- [ ] `download`: SharePoint over https only, `download=1`, 10 redirects, 60 s, not text/html, 100 MB cap, `cmd_result:<id>` = `{"f": name}`; done or failed.
- [ ] `reply`, `react` (quick, picker, pill), `edit`, `delete`, `undodelete`: viewing, `active_chat`, conversation saved, then done or failed.
- [ ] Unknown command type: done.

### Actions on Teams

- [ ] Menus and dialogs closed with up to 3 Escape presses before an action.
- [ ] Real mouse hover (4 tries, bar within 1.5 s); nearest visible bar within 120 px; button clicked by coordinates.
- [ ] Quick reactions from the bar; cry and angry from the picker; change of your reactions checked.
- [ ] Pill click checked by `aria-pressed` or the pill disappearing.
- [ ] Edit: select all, delete, insert, Done; draft discarded on failure; new text checked.
- [ ] Delete from More options, tombstone checked; undo button, tombstone gone.
- [ ] Reply with quote: bar for other people's messages, More options for yours; text typed without a click, Enter; quoted card with the text checked; quote closed on failure.
- [ ] Send: editor or textbox, send button or Enter; refused when the open chat is another one.
- [ ] Read-by: More options entry, label and submenu names; 1:1 chats marked `chat_1to1:<chat>`; last 5 own messages, again after 60 s until read by all.

### Activity feed

- [ ] Activity view, first item within 8 s, up to 6 scroll passes, 40 items by id.
- [ ] Kinds reaction, mention, reply, task, team, call, meeting, message; actor, channel, chat, unread by title weight, emoji, picture.
- [ ] Back to Chat and to the wanted chat whatever happened; table rewritten with `activity_ts`.

### Identity, presence, health

- [ ] Identity from the Teams localStorage (name, email, tenant) and header picture; previous picture kept; log line on change.
- [ ] Page visible and focused from its first script (init script) and on every round.
- [ ] Own status from the header, `presence_prev`, log line on change.
- [ ] Health row fields as `healthOf` (`src/lib/slotdb.ts`) and `StatusPanel` read them.
- [ ] Expired session or reduced mode: one push on the change to `login`, only once `me` is known; `teams_status_prev`.

### Push

- [ ] Devices of the slot owner only; label with the organization, email or account number when the owner has more accounts.
- [ ] Payload `{title, body, acc}`; 404 and 410 remove the subscription; TTL 1 hour.
- [ ] No private key: push off, the rest runs. Key that does not derive `appkey.txt`: the agent stops at start.

### Resilience

- [ ] CDP connection retried every 3 s; notifications permission granted.
- [ ] Teams tab by host (proxy suffixes included, service worker excluded), sign-in tab as fallback.
- [ ] No tab: yellow health, exit after 60 s so Docker restarts the agent.
- [ ] Lost CDP connection: reconnect without closing the browser.
- [ ] SIGTERM: immediate exit.
