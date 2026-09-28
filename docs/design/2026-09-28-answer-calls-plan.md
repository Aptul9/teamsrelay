# Answering a call from the app: implementation plan

Spec: [2026-09-28-answer-calls.md](2026-09-28-answer-calls.md). Branch `feat/answer-calls-from-app`. Tasks run in order, each red first, each its own commit.

**Goal:** Answer and Hang up for a call of an account of the browsers container, from the app banner and from the Chrome notification, with the sound through `/desktop/`.

**Architecture:** the call watch of the agent (1 s timer) runs the two new commands itself, straight from `pending` to `done` or `failed`. A page hook on `getUserMedia` tells when the page holds a live microphone track: that is the call in progress (`in_call` state), and the check that an answer or a hang-up worked. Hang-up is the Teams web shortcut Ctrl+Shift+H (Microsoft support, *Keyboard shortcuts for Microsoft Teams*, web column), so no selector of the call view is needed. Selkies forwards the phone microphone on demand; a Chromium managed policy lets Teams use it without a prompt.

**Tech stack:** Next.js 16 route handlers, better-sqlite3, Playwright over CDP, vitest (Chrome page tests through `test/agent/chrome.ts`), service worker tests in `node:vm` (`test/sw.test.ts`).

## Global constraints

- New command types go at the end of `COMMAND_TYPES`; existing names never change.
- `runPendingCommands` marks every `running` command `unconfirmed` at each round: the call watch never sets `running` on `answer` or `hangup`.
- Only accounts of the browsers container: `AgentSettings.answerCalls` true in `src/agent/config.ts`, false in `src/local/config.ts`; the web app refuses an account on another computer with 409 (`ON_ANOTHER_COMPUTER`).
- The toast is clicked only by `answer`, only on *Accept with audio*, only while the call of that `since` rings. *Decline call* is never clicked.
- Teams web stays English: selectors and texts are English.
- Commit author `Aptul9 <aptul99@gmail.com>`, Conventional Commits, no AI trailer; PR body empty.

---

### Task 1: contract

**Files:** modify `app/src/shared/slot-db/commands.ts`, `app/src/shared/slot-db/state.ts`; test `app/test/call-contract.test.ts` (new).

**Produces:**
- `COMMAND_TYPES` ends with `"answer", "hangup"`; `CALL_COMMANDS: readonly CommandType[] = ["answer", "hangup"]`; `AnswerArgs = z.object({ since: z.number().catch(0) })`.
- `STATE.inCall = "in_call"`; `InCall = z.object({ caller, since, seen, active })`; `inCallOf(c: InCall | null, now: number): { caller: string; since: number } | null` (active and `seen` at most `CALL_FRESH_FOR` s old); `RingingCall` gains `active?: boolean`.

- [ ] Test: the last two types, `AnswerArgs` from `{"since":1790000000000}` and from junk (`since` 0), `inCallOf` fresh, stale (11 s), inactive, null.
- [ ] Run `npx vitest run test/call-contract.test.ts`: fails (no export).
- [ ] Implement; run again: passes. Commit `feat(calls): answer and hangup commands, in-call state`.

### Task 2: page scripts

**Files:** modify `app/src/agent/teams/selectors.ts` (`SEL.callAccept`), `app/src/agent/teams/scripts/calls.ts`; test `app/test/agent/page-calls.test.ts`.

**Produces:**
- `SEL.callAccept = '[data-testid="calling-actions"] button[aria-label="Accept with audio"]'`.
- `installMicHook(): "already" | "installed"`: wraps `navigator.mediaDevices.getUserMedia` once (`__teamsMicHook`), keeps each audio track it returns in `__teamsMicTracks`.
- `micLive(): boolean`: a kept track with `readyState === "live"`; ended ones dropped.

- [ ] Tests in Chrome on `call-toast.html`: a trusted click on `SEL.callAccept` reaches *Accept with audio* only (click counters on both buttons). Mic hook with a stubbed `getUserMedia` returning a `MediaStreamAudioDestinationNode` stream: `micLive` false before, true after the call, false after `track.stop()`; installing twice keeps one wrapper; a video-only stream is not kept.
- [ ] Run `npx vitest run test/agent/page-calls.test.ts`: fails. Implement; passes. Commit `feat(agent): accept button selector and microphone hook`.

### Task 3: agent

**Files:** modify `app/src/agent/context.ts` (`AgentSettings.answerCalls`, `Agent.inCall?`), `app/src/agent/config.ts`, `app/src/local/config.ts`, `app/src/agent/jobs/calls.ts`, `app/src/agent/jobs/page-setup.ts`, `app/src/agent/commands/index.ts`, `app/src/agent/loop.ts`, `app/src/agent/push/notifier.ts`, `app/src/agent/main.ts`; tests `app/test/agent/calls.test.ts`, `app/test/agent/notify.test.ts`.

**Consumes:** Task 1 (`CALL_COMMANDS`, `AnswerArgs`, `STATE.inCall`), Task 2 (`SEL.callAccept`, `installMicHook`, `micLive`).

**Produces:**
- `CallWatch` (config `answerCalls`): per look, after the toast, `runCallCommands()` then `watchMic()`.
  - `answer`: `failed` unless `tracker.current()?.since === since`; click `SEL.callAccept` (timeout 3 s); `done` once no toast within 5 s, else `failed`. The ended push of that call says *Answered*.
  - `hangup`: `failed` with no live microphone on any Teams page (all frames); Ctrl+Shift+H on that page; `done` once the microphone is not live within 5 s.
  - `watchMic`: `in_call` written while live (every `CALL_SEEN_EVERY` s) and once `active: false` when it stops; `a.inCall` follows it.
- `HANDLERS.answer` / `HANDLERS.hangup` end as `failed` (only reached by an agent without `answerCalls`); `runPendingCommands` skips `CALL_COMMANDS`.
- Jobs `parking`, `chats-full`, `activity`, `read-by`, `self-check` wait while `a.inCall`.
- `preparePage` adds `installMicHook` to the context init scripts and runs it on the page.
- `Notifier` option `answerable`: ringing pushes carry `answer: true`; `call(caller, state, since, seconds, answered)` ends with body *Answered in TeamsRelay*.

- [ ] Tests (fake page and store as in `calls.test.ts`): answer done, answer of another `since` failed with no click, toast staying failed, commands never set `running`, hangup done / failed with no call, `in_call` written and cleared, `answerCalls` false runs nothing, ended push marked answered; notifier `answer` only with `answerable` and only while ringing.
- [ ] Run `npx vitest run test/agent/calls.test.ts test/agent/notify.test.ts`: fails. Implement; passes, plus `npx vitest run test/agent`. Commit `feat(agent): answer and hang up calls from the call watch`.

### Task 4: web app API

**Files:** modify `app/src/lib/slotdb.ts` (`enqueueOnce`, `inCall()`), `app/src/lib/commands.ts` (`queueOnce`), `app/src/lib/calls.ts`; create `app/src/app/api/call/answer/route.ts`, `app/src/app/api/call/hangup/route.ts`; test `app/test/call-routes.test.ts` (new, pattern of `test/desktop-routes.test.ts`).

**Produces:**
- `POST /api/call/answer?a=N` `{since}`: 404 another owner; 409 on another computer, stopped or checked; 409 *Call no longer ringing* unless the slot call of that `since` rings; one `answer` per `answer-<N>-<since>` key; answers `{ok, id, desktop}`.
- `POST /api/call/hangup?a=N`: same owner and account checks; 409 *No call in progress* unless `in_call` is active; one `hangup` per `hangup-<N>-<since>`; answers `{ok, id}`.
- `CallReaders.ringing` lists ringing calls and calls in progress (`active: true`).

- [ ] Tests: each status above, two posts one row, the desktop URL, the event list with an active call.
- [ ] Run `npx vitest run test/call-routes.test.ts test/calls-list.test.ts`: fails. Implement; passes. Commit `feat(web): answer and hang up endpoints`.

### Task 5: app and service worker

**Files:** modify `app/src/components/CallAlert.tsx`, `app/src/components/App.tsx`, `app/public/sw.js`; tests `app/test/sw.test.ts`, `app/test/call-ring.test.ts` (+ `call-ring-page.tsx`).

**Produces:**
- Banner: ringing call of a container account gets **Answer** (post, then `openDesktop(acc)`; 409 shows the reason); a call in progress shows *In call with X*, **Hang up** (post, follow the command, toast on failure) and **Desktop**; the ring plays only for ringing calls.
- Desktop iframe `allow="microphone; autoplay"` (a `DESKTOP_URL` on another origin).
- `sw.js`: ringing call with `answer` gets actions **Answer**, **Open**; **Answer** posts `{since: ts}` to `/api/call/answer?a=N` and opens the `desktop` it answers, or `/?a=N` on a refusal.

- [ ] Tests: service worker actions with and without `answer`, **Answer** posts and opens the desktop, a 409 opens the app; banner buttons for a ringing call, none for a relay account, *In call* with **Hang up**, no ring for a call in progress.
- [ ] Run `npx vitest run test/sw.test.ts test/call-ring.test.ts`: fails. Implement; passes. Commit `feat(app): answer and hang up from the banner and the notification`.

### Task 6: image and compose

**Files:** create `app/docker/browsers/etc/chromium/policies/managed/teamsrelay.json`; modify `docker-compose.yml`.

- `AudioCaptureAllowedUrls`: `https://teams.microsoft.com/`, `https://teams.cloud.microsoft/`, `https://teams.live.com/`, `https://teams.microsoft.com.mcas.ms/`, `https://teams.cloud.microsoft.mcas.ms/`.
- Browsers env: `SELKIES_MICROPHONE_ENABLED: "true"`, `SELKIES_MICROPHONE_ON_START: demand`.

- [ ] `docker build --target browsers -t teamsrelay-browsers:answer-calls ./app`: exit 0 (agent and supervisor checks run in the build).
- [ ] Throwaway container of that image with the two variables, no volume: Chromium of the image reads the policy (`chrome://policy` through DevTools lists `AudioCaptureAllowedUrls` with status OK), the Selkies process has both variables, `pactl` as `abc` lists `SelkiesVirtualMic` as default source once Selkies starts. Remove the container. Commit `feat(browsers): microphone for Teams through the remote desktop`.

### Task 7: docs

**Files:** `docs/limitations.md` (*Incoming calls*), `docs/setup.md` (phone: answer, microphone permission, earphones, mic and speaker in the side menu of the desktop, ring time), `docs/configuration.md` (Selkies variables), `docs/operations.md` (log lines), `docs/teams-selectors.md` (accept button, end-call shortcut, microphone hook), spec (hang-up by shortcut, phases).

- [ ] Links resolve, no dashes, no hard wraps. Commit `docs: answering and hanging up calls from the app`.

### Task 8: verification and PR

- [ ] `npm run lint`, `npm run typecheck`, `npx vitest run --maxWorkers=4`, `npm run build`, `node dist/agent.cjs --check`, `node dist/supervisor.cjs --check`, `docker build --target web ./app`.
- [ ] Push, PR into `main` (title = first commit subject line of the feature, empty body), CI Check green.
- [ ] Pre-Mortem for the prod deploy (merge without `[skip ci]`): waits a yes; then live test with the owner (call to slot 2, Answer from the phone, sound both ways, Hang up from the app).
