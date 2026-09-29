# Teams-side mute: implementation plan

Spec: [2026-09-29-teams-mute.md](2026-09-29-teams-mute.md). Branch `feat/teams-side-mute`. Tasks run in order, each red first, each its own commit.

**Goal:** Mute on the banner presses Teams' own mute (the others see the mute mark), a mute pressed in the remote desktop shows in the app, the device's microphone stays silent while muted.

**Architecture:** the agent reads Teams' mute state from `#microphone-button[data-state]` at each look of the call watch during a call and keeps it in `in_call.muted`; a `mute {on}` command, run by the call watch, presses Ctrl+Shift+M only when the state read differs and confirms by reading it back (one click on the button as fallback). The app shows Teams' state, silences the source at once on a press and follows Teams afterwards.

**Tech stack:** TypeScript, zod, Playwright over CDP (agent), Next.js 16 route handlers, React 19 client components, vitest (node, and the local Google Chrome through Playwright for page scripts and the banner).

## Global constraints

- Command names never change; `mute` goes last. An unknown `on` fails without a press.
- Never a press on a state read as unknown; never a key and a click on a state already changed.
- Commit author `Aptul9 <aptul99@gmail.com>`, Conventional Commits, no AI trailer; merge subject with `[skip ci]` unless the owner asks for the deploy; PR body empty.

---

### Task 1: contract

**Files:** modify `app/src/shared/slot-db/commands.ts`, `app/src/shared/slot-db/state.ts`, `app/src/lib/calls.ts`; test `app/test/call-contract.test.ts`, `app/test/call-events.test.ts`.

**Produces:**
- `COMMAND_TYPES` ends with `"answer", "hangup", "mute"`; `CALL_COMMANDS = ["answer", "hangup", "mute"]`.
- `MuteArgs = z.object({ on: z.boolean().nullable().catch(null) })`: `parseArgs(MuteArgs, '{"on":true}')` is `{ on: true }`, junk `{ on: null }`.
- `InCall.muted: z.boolean().optional().catch(undefined)`; `inCallOf(c, now)` returns `{ caller, since, muted? }`; `RingingCall.muted?: boolean`.
- `CallReaders.ringing` lists an active call with its `muted` when known.

- [ ] Tests: `mute` last and in `CALL_COMMANDS`; `MuteArgs` true/false/junk/missing; `inCallOf` with `muted: true`, without, with `muted: "yes"` (absent); events: an active call with `muted` carries it, one without has no key.
- [ ] `npx vitest run test/call-contract.test.ts test/call-events.test.ts`: fails.
- [ ] Implement; passes; typecheck (the loop's handler map needs `mute: byCallWatch`, `test/agent/commands.test.ts` keeps `mute` pending). Commit `feat(calls): mute command and Teams' mute state of the call in progress`.

### Task 2: page script and actions

**Files:** modify `app/src/agent/teams/selectors.ts`, `app/src/agent/teams/scripts/calls.ts`, `app/src/agent/teams/call-actions.ts`; create `app/test/agent/fixtures/call-controls.html`; test `app/test/agent/page-calls.test.ts`.

**Produces:**
- `SEL.callMic = "#microphone-button"`.
- `micMuted(s: Selectors): boolean | null`: `data-state` of the `SEL.callMic` elements with width and height on screen: all `mic-off` true, all `mic` false, else null.
- `muteShortcut(page: Page): Promise<void>`: `Control+Shift+M` inside `withInput`.
- `clickMic(page: Page): Promise<boolean>`: the real click of `acceptCall` on `SEL.callMic`; `acceptCall` and `clickMic` share `realClick(page, sel)`.

- [ ] Tests in Chrome: fixture live false, `mic-off` true; no button, hidden button, `data-state="mic-busy"`, two shown disagreeing: null; hidden `mic-off` beside shown `mic`: false. `muteShortcut` records `Ctrl+Shift+M`. `clickMic` clicks the microphone button once (trusted) and nothing else; false when all of it is covered or it is missing.
- [ ] `npx vitest run test/agent/page-calls.test.ts`: fails.
- [ ] Implement; passes. Commit `feat(agent): read Teams' mute state and press its mute`.

### Task 3: call watch

**Files:** modify `app/src/agent/jobs/calls.ts`; test `app/test/agent/calls.test.ts`.

**Produces:**
- `CallWatch` runs `mute` (`setMute`) as it runs `hangup`; `in_call` rows carry `muted` when known, written at once when it changes; `MUTE_KEY_TRIES = 6` looks of `CONFIRM_EVERY` before the click.
- A call in progress stays in progress while the button reads muted and no track is live.

- [ ] Tests (fake page: `frame.evaluate` answers `micLive` and `micMuted`): already in state, done, no press; unknown, failed, no press; no call, failed; junk `on`, failed; key then read-back, done, no click; key without effect, one click, done; neither, failed; the key taking late is never followed by a click (state read again before it); `in_call.muted` at once on a desktop change, absent when unknown; muted call without track stays in progress, over once the button goes.
- [ ] `npx vitest run test/agent/calls.test.ts`: fails.
- [ ] Implement; passes. Commit `feat(agent): Teams-side mute asked from the app`.

### Task 4: web API

**Files:** create `app/src/app/api/call/mute/route.ts`; test `app/test/call-routes.test.ts`.

**Produces:** `POST /api/call/mute` `{on}` giving `{ok, id}`.

- [ ] Tests: queued `{"on":true}` once for two taps, `{"on":false}` a second command; 400 for `{}`, `{on: "yes"}`, `{on: 1}`; 409 *No call in progress* (none, over, stale); 409 another computer; 404.
- [ ] `npx vitest run test/call-routes.test.ts`: fails.
- [ ] Implement; passes. Commit `feat(api): mute of the call in progress`.

### Task 5: app

**Files:** create `app/src/lib/call-audio/mute.ts`; modify `app/src/components/CallAlert.tsx`, `app/src/components/App.tsx`, `app/test/call-ring-page.tsx`; test `app/test/call-audio-mute.test.ts`, `app/test/call-ring.test.ts`.

**Produces:**
- `type MuteView = { teams?: boolean; source: boolean; want: boolean | null }`; `shownMuted(v: MuteView, sourceLive: boolean): boolean`.
- `class CallMutes { constructor(o: { onChange(acc: number, v: MuteView): void; confirmFor?: number; later?: (fn: () => void, ms: number) => unknown }); press(acc, on); teams(acc, v?: boolean); settled(acc, ok: boolean); forget(acc); view(acc): MuteView }`.
- `CallBanner` props `mutes?: Record<number, MuteView>`; Mute shown for an active call where the sound is live in the app or `mutes[acc].teams` is known.

- [ ] Tests node: press sets source and want at once; stream equal to want clears it; a stream change without want sets source; failed keeps source, clears want; done keeps want until the stream shows it or the timer runs; `shownMuted` with and without source. Chrome: Mute on a call with Teams' state and no sound, the press gives `[acc, true]`; lines *muted here only*, *Sound in the app, muted*, *Muted*.
- [ ] `npx vitest run test/call-audio-mute.test.ts test/call-ring.test.ts`: fails.
- [ ] Implement, wire App (`onMute` runs the command, `calls` feed `teams`, `source` goes to `answered.mute`); passes. Commit `feat(app): Mute follows Teams' own mute`.

### Task 6: docs and checks

- [ ] `limitations.md`, `teams-selectors.md`, `api.md`, `architecture.md`, `operations.md` as the spec says. Commit `docs: Teams-side mute`.
- [ ] `npx tsc --noEmit`, `npx eslint .`, full `npx vitest run --maxWorkers=4`, `npm run build`, `node dist/agent.cjs --check` style checks as the repo runs them.
- [ ] Harness for the prod call (scratchpad, not committed): bundles `micMuted` and `SEL` from this branch, reads the state of slot 2 every second, presses Ctrl+Shift+M as the call watch does on cue.
