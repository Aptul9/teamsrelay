# Calling a person from the app: implementation plan

Spec: [2026-09-30-outbound-calls.md](2026-09-30-outbound-calls.md). Branch `feat/outbound-calls` from `main` `d9992a1`. Tasks run in order, each red first, each its own commit.

**Goal:** a Call button on 1:1 chats that starts a Teams audio call on an account of the browsers container, heard and ended in the app like an answered call.

**Architecture:** the agent reads the kind of each chat row (`chats.kind`). A `call` command, run by the loop because it opens a chat, presses the Teams web shortcut for an audio call (Alt+Shift+A) in the open 1:1 chat and ends done once the page records from the microphone. The call watch names that call in progress after the person called; from there the answered-call path applies unchanged (sound in the app, Mute, Hang up).

**Tech stack:** Next.js 16 route handlers, better-sqlite3, Playwright over CDP, vitest (Chrome page tests), shadcn AlertDialog.

## Global constraints

- New command types go at the end of `COMMAND_TYPES`; existing names never change. `call` is not a call-watch command (`CALL_COMMANDS` unchanged).
- Alt+Shift+A accepts a video call while a call rings: pressed only inside `withInput`, right after reading that no call toast shows, never while `a.ringing` or `a.inCall`.
- Only 1:1 chats of the list, never the self chat (`(You)`), never an account on another computer (409 `ON_ANOTHER_COMPUTER`).
- A `call` older than 25 s is refused; the app follows it for 45 s.
- Teams web stays English: selectors and texts are English.
- Conventional Commits, no AI trailer; PR body empty.

---

### Task 1: kind of each chat

**Files:** `app/src/agent/teams/selectors.ts` (`SEL.rowKinds`), `app/src/agent/teams/scripts/chat-list.ts`, `app/src/agent/logic/chats.ts`, `app/src/agent/jobs/chat-list.ts`, `app/src/agent/store/slot-store.ts`, `app/src/shared/slot-db/schema.ts`, `app/src/shared/slot-db/rows.ts`, `app/src/lib/slotdb.ts`, `app/scripts/seed-slot.mjs`; tests `app/test/agent/page-live-fixtures.test.ts`, `app/test/agent/page-chat-list.test.ts`, `app/test/agent/slot-store.test.ts`, `app/test/slotdb.test.ts`, `app/test/slot-schema.test.ts`.

**Produces:** `ListRow.kind`, `ChatEntry.kind?`, `Chat.kind: string` (`"one" | "group" | "meeting" | ""`), column `chats.kind TEXT`.

- [ ] Tests: captured list gives `one` for every row with a presence badge, `group` for every `, +N` row, `meeting` for 22 rows; the synthetic list gives `""`; store and reader carry `kind`; schema lists `kind TEXT`; a chat out of the read keeps its kind.
- [ ] Run `npx vitest run test/agent/page-live-fixtures.test.ts test/agent/page-chat-list.test.ts test/agent/slot-store.test.ts test/slotdb.test.ts test/slot-schema.test.ts test/agent/chats-and-messages.test.ts`: fails.
- [ ] Implement; passes. Commit `feat(agent): kind of each chat of the list`.

### Task 2: the call command

**Files:** `app/src/shared/slot-db/commands.ts` (`"call"`, `CALL_REASONS`, `CallResult`), `app/src/agent/context.ts` (`outgoing`), `app/src/agent/store/slot-store.ts` (`PendingCommand.ts`), `app/src/agent/teams/call-actions.ts` (`startAudioCall`), `app/src/agent/teams/scripts/calls.ts` (`groupChatShown`), `app/src/agent/jobs/calls.ts` (exported `recordingPage`), `app/src/agent/commands/call.ts` (new), `app/src/agent/commands/index.ts`; tests `app/test/call-contract.test.ts`, `app/test/slot-contract.test.ts`, `app/test/agent/call-command.test.ts` (new), `app/test/agent/page-calls.test.ts`.

**Produces:** handler `call(a, cmd)`; `CallResult = { reason: CallReason }`, `CALL_REASONS = ["late", "busy", "signed-out", "not-listed", "not-shown", "not-one", "no-call"]`; `a.outgoing?: { callee: string; since: number }`.

- [ ] Tests: `call` last in `COMMAND_TYPES`; each refusal (late, busy ringing, busy in call, not 1:1, self chat, signed out, group header, toast at the press) presses nothing and writes its reason; one Alt+Shift+A then done once a page records; no-call after the wait, `outgoing` cleared; `outgoing` set before the press; `groupChatShown` on a header with and without the participant count.
- [ ] Run the four test files: fail.
- [ ] Implement; pass. Commit `feat(agent): call the person of a 1:1 chat`.

### Task 3: the call watch names the call placed

**Files:** `app/src/agent/jobs/calls.ts`; test `app/test/agent/calls.test.ts`.

- [ ] Tests: with `outgoing` newer than the last ringing call, the call in progress is named after the callee with its `since`; microphone read at every look while placing; `outgoing` cleared once the call is over; an incoming call after that is named after its caller.
- [ ] Run: fails. Implement; passes. Commit `feat(agent): call in progress named after the person called`.

### Task 4: POST /api/call/start

**Files:** `app/src/app/api/call/start/route.ts` (new); test `app/test/call-routes.test.ts`.

- [ ] Tests: queues `call` with the chat once for two taps and names the desktop; 409 for a relay account, a stopped account, a call ringing, a call in progress, a group chat, a chat not in the list, the self chat; 400 for a missing name; nothing queued on a refusal.
- [ ] Run: fails. Implement; passes. Commit `feat(web): call a 1:1 chat from the app`.

### Task 5: the app

**Files:** `app/src/components/Conversation.tsx` (`onCall`, AlertDialog), `app/src/components/CallAlert.tsx` (`placing`), `app/src/components/App.tsx` (`placeCall`, reasons), `app/src/lib/client.ts` (`CALL_START_TRIES`, `callProblem`); tests `app/test/call-ring.test.ts` + page, `app/test/conversation-call.test.ts` + page (new).

- [ ] Tests (Chrome): Call shows only with `onCall`; *Call Anna Rossi?* then **Call** calls once, **Cancel** does not; banner *Calling Anna Rossi* with no ring and no buttons until an active call of that account shows; reason texts for each `CallReason`.
- [ ] Run: fails. Implement; passes. Commit `feat(web): Call button and banner of the call placed`.

### Task 6: docs and checks

**Files:** `docs/architecture.md`, `docs/api.md`, `docs/limitations.md`, `docs/operations.md`, `docs/teams-selectors.md`.

- [ ] Docs. Full suite, eslint, tsc, build, `agent.cjs --check`, `relay.cjs --check`. Commit `docs: calls placed from the app`. Push, PR.
