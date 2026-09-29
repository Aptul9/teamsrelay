# Teams-side mute of a call answered from the app

Date: 2026-09-29. Follows [2026-09-29-call-audio-in-app.md](2026-09-29-call-audio-in-app.md): **Mute** on the banner stops the microphone frames of the device, Teams records silence and shows the others no mute mark.

**Goal:** **Mute** on the banner presses Teams' own mute, so the others in the call see the mute mark, and a mute pressed in Teams through the remote desktop (`/desktop/`) shows in the app.

## Decisions

- Teams' mute state is the state of the call: it is what the others see, and three places change it (the app, Teams in the remote desktop, Teams itself: an organizer mutes a participant, a large meeting mutes on join). The app shows it and follows it.
- The mute at the source stays, as a guard: a press silences the microphone of the device at once, before Teams mutes (about a second later), and keeps it silent when Teams cannot be muted. Afterwards the source follows Teams' state.
- The command carries the state wanted, never a toggle: Ctrl+Shift+M toggles, so the agent reads the state first and presses only when it differs. Two taps, or a press in the desktop in between, cannot invert it.
- Nothing is pressed on a state that cannot be read. A missing button, a hidden one, an unknown value, or two buttons on screen that disagree read as unknown: the command fails, the source mute stays, the banner says the call is muted on the device only.
- The banner offers Mute for any call in progress whose Teams state is known, whether its sound is in the app or on the desktop (opening `/desktop/` takes the sound from the app).

## What Teams shows

- The call's microphone button is `#microphone-button`. First known from the extension *teams-caffeine* (github.com/g-guerzoni/teams-caffeine, `selectors.js`, 2026-09-18): `data-state="mic"` live, `"mic-off"` muted, and a hidden button Teams can leave in the page after a call ends (only a button on screen counts).
- Read in a real 1:1 call on slot 2 on 2026-09-29, muted and unmuted several times full screen and in the floating call monitor: live is `data-state="mic-volume-renderer"`, not `mic`, so a read of `data-state` against the extension's values said unknown on every live state. The button also carries the action a click takes, `data-track-action-scenario` (`callMuteAudio` while live, `callUnmuteAudio` while muted), and `aria-keyshortcuts="Ctrl+Shift+M"`. The read takes either mark, `mic` and `mic-volume-renderer` both live; two marks that disagree read as unknown.
- Ctrl+Shift+M is the mute shortcut of Teams web (Microsoft support, *Keyboard shortcuts for Microsoft Teams*, web column), sent the way the hang-up shortcut is (Playwright key events on the page of the call).
- The microphone track stayed live while muted in that call. The call in progress is read from that track (`micLive`); a call muted in Teams would still stay in progress while its button on screen reads muted, in case a build lets the microphone go.

## Contract

- Command type `mute` at the end of `COMMAND_TYPES`, in `CALL_COMMANDS`: `arg1` the caller, `arg2` `{"on": true|false}` (`MuteArgs`; anything else reads as `on: null`, which fails without a press). An agent of an earlier release ends it as done without a press, as any unknown type.
- `InCall.muted`: Teams' mute state of the call in progress, `true` or `false`, absent while it cannot be read. `inCallOf` and the event stream carry it: `RingingCall.muted` on an active call.
- `POST /api/call/mute?a=N` `{on}`: queues `mute` for the call in progress. 400 without a boolean `on`, 409 without a call in progress or for an account on another computer, 404 for an account of someone else. Two identical requests while the first waits give one command.

## Agent

- Page script `micMuted(s)`: `true`, `false`, or `null`, from the `#microphone-button` elements on screen of one frame.
- The call watch reads it on every frame of every Teams page, at each look while a call is in progress: one value on screen gives the state, none or two different give unknown. It rewrites `in_call` at once when the state changes, else every `CALL_SEEN_EVERY` seconds as today.
- `mute`, run by the call watch like `hangup` (pending to done or failed directly, never running):
  1. No call in progress: failed. `on` missing: failed. State unknown: failed, nothing pressed.
  2. State already `on`: done, nothing pressed.
  3. Ctrl+Shift+M on the page that shows the button, then the state read every 250 ms: done once it reads `on`.
  4. Still the other state after 1.5 s: read again; still readable and still the other state, one real click on the button (CDP mouse events at a point nothing covers, as Accept); done once it reads `on` within the rest of the 5 s.
  5. Otherwise failed. A key and a click never both land on a state that already changed.
- A call in progress stays in progress while no track is live if the button on screen reads muted (Teams may release the microphone while muted); over once neither holds.

## App

- `CallMutes` (`app/src/lib/call-audio/mute.ts`), per account: `teams` (from the event stream), `source` (the device's own mute), `want` (a press not yet shown by Teams). A new call of the account (another `since`) starts again from Teams' state, so no call inherits the mute of the one before.
  - Press `on`: `source = on`, `want = on`, then `POST /api/call/mute` and the command followed as Hang up is.
  - Event stream: Teams' state equal to `want` clears it. Without `want`, a change of Teams' state sets `source` to it (a press in the desktop, an organizer).
  - Command done: `want` is cleared once the stream shows it, or 5 s later. Failed: `want` cleared, `source` kept; a toast when Teams' state is known.
  - Shown muted: `want` while set, else `source` (only while the sound is in the app) or Teams muted.
- The banner of a call in progress: **Mute**/**Unmute** where the sound is in the app or Teams' state is known. Lines: *Sound in the app, muted* (Teams muted or a press on its way), *Sound in the app, muted here only* (Teams not muted or unknown), *Sound on the desktop, muted*, *Muted* for a call without sound in the app.
- The device's microphone follows `source` (`CallAudio.mute`).

## Tests

- Contract: `mute` last, in `CALL_COMMANDS`; `MuteArgs`; `inCallOf` with and without `muted`, a wrong type read as absent.
- Page script in Chrome on `call-controls.html` (rebuilt from the selectors above, names invented): live, muted, no button, hidden button, unknown `data-state`, two disagreeing, a stale hidden `mic-off` beside a shown `mic`. The shortcut sends Ctrl+Shift+M; the click lands on the microphone button only, nothing when all of it is covered.
- Call watch with a fake page: no press when already in state, when unknown, without a call, with a junk `on`; one key, done on read-back; one click after a key that changed nothing; failed when neither; `in_call.muted` written at once on a change from the desktop and absent when unknown; a muted call without a live track stays in progress, over when the button goes. Loop: `mute` stays pending there.
- Route: queued once, 400, 409 (no call, another computer), 404.
- `CallMutes` in node; the banner in Chrome (Mute from Teams' state with no sound in the app, the lines, the press).
- Prod, before any deploy: a real call to slot 2 read by a harness over DevTools that runs `micMuted` and the key of this change on the live call view, with the probe of 2026-09-29 beside it. Done on 2026-09-29: the first call found the live `data-state` (fixed); in the second, `setMute` by the shortcut and a direct click each muted and unmuted within 250 ms, the caller seeing the mute mark twice. After the deploy the owner approves: Mute and Unmute from the app, a mute pressed in the desktop showing in the app.

## Docs

`limitations.md` (*Answered calls*), `teams-selectors.md` (*Incoming call*: the microphone button, the mute shortcut), `api.md` (the endpoint, `calls` with `active` and `muted`), `architecture.md` (`in_call`), `operations.md` (log lines of `mute`).
