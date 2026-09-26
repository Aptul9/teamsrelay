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

Built from `agent/agent.py` at `15ea59f`. Each item is closed by a test (file under `app/test/agent/`) or a live check on the local stack on 2026-09-26 (slot 1 AGAP2, slot 2 Npo behind Defender for Cloud Apps; actions only in the self chats "(You)").

### Loop and schedule

- [x] Round about every second; all pending commands each round in id order, a chat list read after each command. `commands.test.ts`, `agent-process.test.ts`; live: every command on both slots.
- [x] Chat list every 3 rounds; full list every 300 rounds (offset 1) while Teams is ok. `commands.test.ts` (job table), `scheduler.test.ts`; live: chat list 2 s old in the health row.
- [x] Activity feed every 150 rounds (offset 5) while Teams is ok. `commands.test.ts`; live: `activity_ts` refreshed without commands (146 s and 35 s old).
- [x] Identity every 300 rounds (offset 7), or every round while unknown, while Teams is ok. `commands.test.ts`, `scheduler.test.ts`; live: `me` kept on both slots.
- [x] Health every 5 rounds, on the sign-in page too. `scheduler.test.ts`, `health.test.ts`; live: health row 3-4 s old.
- [x] Open conversation saved every round while a chat is active. `commands.test.ts`; live: self chat saved after each action.
- [x] Read-by prefetch every 2 rounds when the open chat is the wanted one, Teams is ok and no command is pending. `schedule-rules.test.ts`, `commands.test.ts`; live: slot 2 self chat marked `chat_1to1` by the Node agent.
- [x] Input every 60 s: mouse to (6,6) and (2,2), then Shift. `commands.test.ts`; live: Teams status "available" on both slots for the whole test.
- [x] Parking every 5 rounds (offset 2) when no command is pending and the open chat is not the wanted one. `ported.test.ts` (Parking); live: slot 1 `show:` 90 s after an `open` of another chat.
- [x] Automatic check 8-11 and 17-20 once per `hc_YYYYMMDD_am|pm` key, with a push of the outcome. `schedule-rules.test.ts`; live: the same check through `recheck` on both slots (the test ran outside both windows).

### New messages

- [x] First list primes the state without notifying. `new-messages.test.ts`.
- [x] Self chat and muted chats never notify; outbound previews (`You:`, `Tu:`) are not incoming. `new-messages.test.ts`.
- [x] Incoming preview or time change of a known chat, or a chat turning unread, notifies once per preview|time|unread key. `new-messages.test.ts`, `agent-process.test.ts` (real bundle, list changed in Chrome). No incoming message reached the two accounts during the live test.
- [x] Push dedup: same lowercased body (first 60 characters) within 150 s is pushed once. `notify.test.ts`, `push.test.ts`.
- [x] Each notification: `messages` row, ntfy when enabled, push; `NEWMSG` log line. `push.test.ts`, `agent-process.test.ts`.
- [x] Teams notification hook as second source: `__HEALTHCHECK__`, "Nice job" and "Notifications are now on" skipped. `page-state.test.ts`; live: `hook: ok` in the health row.

### Chat list

- [x] Collapsed Chats and Favorites sections are opened; only level-2 rows under them are chats. `page-chat-list.test.ts`, `page-live-fixtures.test.ts`.
- [x] Name, time and preview parsed with status words removed; unread, mention, muted, picture; 40 chats at most. `page-chat-list.test.ts`, `page-live-fixtures.test.ts`; live: 40 and 38 chats, 20 and 37 with pictures.
- [x] Merge: visible chats first, the others kept, known pictures kept. `chats-and-messages.test.ts`, `slot-store.test.ts`.
- [x] Full read scrolls up to 8 pages from the top, back to the top, one transaction. `page-chat-list.test.ts` (scroll), `slot-store.test.ts`; live: full read at start on both slots, no error logged.

### Conversation and media

- [x] Title of the open chat checked: a prefix matches only when the title is not another chat of the list. `ported.test.ts` (SameChat), `page-chat-list.test.ts`.
- [x] Last 40 messages: text with emoji `alt`, reduced HTML, mentions, quote, images, files, reactions, status, edited, deleted, `mentionsMe`, author carried over, avatar. `page-conversation.test.ts`, `page-live-fixtures.test.ts`; live: quote, "Edited", "Sent", reactions and tombstone read back in the web app.
- [x] Images fetched in the page (8 MB cap), failures remembered, public https URL kept as fallback; names `sha1(chat|mid|i)[:16]` with the extension of the content type. `page-state.test.ts`, `files.test.ts` (hashes computed with Python); live: slot 2 image found again under its Python name.
- [x] Profile pictures copied through a canvas, `sha1(src)[:16].png`; budget 8 per list read, 20 per full-list page, 40 for the Activity feed, 1 for the identity. `page-state.test.ts`, `files.test.ts`; live: `/media` served the pictures (200, image/png).
- [x] `extra` holds only the fields with a value; read-by merged into your messages. `chats-and-messages.test.ts`, `slot-store.test.ts`.

### Commands

- [x] `open`: marks viewing, opens, sets `active_chat`, saves the conversation; done even when the chat did not open. `commands.test.ts`; live: both slots.
- [x] `send`: marks viewing, types and sends, sets `active_chat`, saves; done even when sending failed. `commands.test.ts`; live: both slots, status "Sent".
- [x] `resync`: chat list without pictures, open conversation; done. `commands.test.ts`, `agent-process.test.ts`; live: both slots.
- [x] `recheck`: full check, push of the outcome; done. Live: both slots.
- [x] `activity`: done or failed. Live: 32 items (slot 2), 5 items (slot 1).
- [x] `download`: SharePoint over https only, `download=1`, 10 redirects, 60 s, not text/html, 100 MB cap, `cmd_result:<id>` = `{"f": name}`; done or failed. `commands.test.ts`, `files.test.ts`; live: slot 1, 908 KB PDF served by `/files` with 200.
- [x] `reply`, `react` (quick, picker, pill), `edit`, `delete`, `undodelete`: viewing, `active_chat`, conversation saved, then done or failed. `commands.test.ts`; live: every one on both slots.
- [x] Unknown command type: done. `commands.test.ts`, `agent-process.test.ts`.

### Actions on Teams

- [x] Menus and dialogs closed with up to 3 Escape presses before an action. `page-actions.test.ts` (open menus counted).
- [x] Real mouse hover (4 tries, bar within 1.5 s); nearest visible bar within 120 px; button clicked by coordinates. `page-actions.test.ts`, `page-live-fixtures.test.ts` (bars captured from Teams); live: every bar action.
- [x] Quick reactions from the bar; cry and angry from the picker; change of your reactions checked. Live: like and cry on both slots.
- [x] Pill click checked by `aria-pressed` or the pill disappearing. Live: both pills removed on both slots.
- [x] Edit: select all, delete, insert, Done; draft discarded on failure; new text checked. Live: both slots.
- [x] Delete from More options, tombstone checked; undo button, tombstone gone. Live: both slots.
- [x] Reply with quote: bar for other people's messages, More options for yours; text typed without a click, Enter; quoted card with the text checked; quote closed on failure. Live: both slots (your own messages, More options path).
- [x] Send: editor or textbox, send button or Enter; refused when the open chat is another one. Live: both slots.
- [x] Read-by: More options entry, label and submenu names; 1:1 chats marked `chat_1to1:<chat>`; last 5 own messages, again after 60 s until read by all. `page-actions.test.ts`, `schedule-rules.test.ts`; live: 1:1 detection on slot 2.

### Activity feed

- [x] Activity view, first item within 8 s, up to 6 scroll passes, 40 items by id. `page-activity.test.ts`; live: both slots.
- [x] Kinds reaction, mention, reply, task, team, call, meeting, message; actor, channel, chat, unread by title weight, emoji, picture. `page-activity.test.ts`, `page-live-fixtures.test.ts`; live: five kinds on slot 2, call on slot 1.
- [x] Back to Chat and to the wanted chat whatever happened; table rewritten with `activity_ts`. Live: commands after each feed read worked.

### Identity, presence, health

- [x] Identity from the Teams localStorage (name, email, tenant) and header picture; previous picture kept; log line on change. `page-state.test.ts`; live: `me` kept.
- [x] Page visible and focused from its first script (init script) and on every round. `page-state.test.ts`; live: status "available".
- [x] Own status from the header, `presence_prev`, log line on change. `page-state.test.ts`; live: presence in the status panel.
- [x] Health row fields as `healthOf` (`src/lib/slotdb.ts`) and `StatusPanel` read them. `health.test.ts`, `slot-contract.test.ts`; live: status panel of slot 2 in headless Chrome.
- [x] Expired session or reduced mode: one push on the change to `login`, only once `me` is known; `teams_status_prev`. `health.test.ts`. Not seen live: no session expired during the test.

### Push

- [x] Devices of the slot owner only; label with the organization, email or account number when the owner has more accounts. `ported.test.ts` (OwnerPush), `push.test.ts`.
- [x] Payload `{title, body, acc}`; 404 and 410 remove the subscription; TTL 1 hour. `push.test.ts`. No device is subscribed on the local stack: delivery to a phone was not observed.
- [x] No private key: push off, the rest runs. Key that does not derive `appkey.txt`: the agent stops at start. `push.test.ts`; live: `push=true` at start with the local keys.

### Resilience

- [x] CDP connection retried every 3 s; notifications permission granted. `agent-process.test.ts`.
- [x] Teams tab by host (proxy suffixes included, service worker excluded), sign-in tab as fallback. `ported.test.ts` (TeamsTab); live: slot 2 behind `.mcas.ms`.
- [x] No tab: yellow health, exit after 60 s so Docker restarts the agent. `agent-process.test.ts`.
- [x] Lost CDP connection: reconnect without closing the browser. `agent-process.test.ts` (browser restarted).
- [x] SIGTERM: immediate exit. `agent-process.test.ts`; live: `docker stop teams-agent-1` 400 ms, exit code 0.

## Memory

Anonymous memory of the agent containers (cgroup `memory.stat`), sampled every 30 s on the local stack (x86_64):

| Agent | Anonymous memory |
|---|---|
| Python (Python process plus its Playwright Node driver) | 120-161 MB |
| TypeScript, `node --enable-source-maps agent.cjs` | 206 MB after start |
| TypeScript, `node agent.cjs`, during the live checks | 75-136 MB, garbage collector cycles included |
| TypeScript, `node agent.cjs`, idle, both slots, 10 minutes | 77-85 MB (slot 1), 97-136 MB (slot 2); CPU median 0.9% of a core, peak 8.9% |

`--enable-source-maps` alone took 28 MB (92 against 120 MB at idle), so the agent command runs without it.
