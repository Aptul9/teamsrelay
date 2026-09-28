# Answering a call from the app

Date: 2026-09-28. Incoming calls today: [limitations.md](../limitations.md) (row *Incoming calls*); selectors: [teams-selectors.md](../teams-selectors.md#incoming-call).

**Goal:** in an emergency, a Teams call ringing on an account of the browsers container is answered from the phone (Chrome, or the web app installed from it), carried on through the remote desktop, and hung up from the app.

## What exists

- The agent looks for the toast of an incoming call every second (`app/src/agent/jobs/calls.ts`), beside the loop, and pushes within about 2 s, then every 5 s while the call rings. The open web app rings on a banner (`CallBanner`); the Chrome notification carries an **Open** button (`app/public/sw.js`).
- The toast holds `[data-testid="calling-actions"]` with the buttons *Accept with audio* and *Decline call*. Nothing clicks them today.
- The browsers image runs PulseAudio as `abc` and Selkies 2.0.0 (pcmflux 2.1.0): `/desktop/` already streams the sound of the desktop. Selkies can forward the microphone of the viewer into the virtual source `SelkiesVirtualMic` (null sink `input` plus `module-virtual-source`), which it makes the default source; `microphone_enabled` is `false` by default and the repo sets no `SELKIES_*` variable (read in `settings.py` and `audio_control.py` of the image, 2026-09-28).
- Chromium starts with no microphone grant: Teams would ask for it inside the window.
- Teams sends an unanswered call to voicemail after 30 s unless the answering rules of the user say otherwise (Microsoft Learn, *Configure call forwarding and delegation settings*). Teams web rang 5 to 9 s in the tests of 2026-09-27.

## Flow

1. The call rings. The pushes of an account of the browsers container carry `answer: true`. Those of an account on another computer do not: its browser and its sound are on that computer.
2. On the phone: **Answer** on the notification (Chrome action), or on the banner of the open app, the only way on an iPhone, whose notifications have no buttons.
3. The app sends `POST /api/call/answer?a=N` with `{"since": <ms>}`. The web app checks that the session user owns slot N (404), that the account runs and is not on another computer (409), and that the call of that `since` still rings in the slot database (409, *Call no longer ringing*). It queues the command `answer` with the key `answer-<N>-<since>`: a second tap queues nothing new.
4. The call watch of the agent runs `answer` at its next look, within 1 s; the loop does not, since one of its rounds can take seconds. The watch clicks *Accept with audio* in the toast of that call with a trusted click: `done` when the toast is gone within 5 s, `failed` when no toast of that call shows or the toast stays. The loop skips `answer`; an `answer` older than 30 s ends as `failed` without a click.
5. The page that asked opens `/api/desktop/N`: the window of account N comes to the front and `/desktop/` loads. Selkies plays the call; with the microphone on demand it asks the phone for its microphone as soon as Teams records from `SelkiesVirtualMic`.
6. While the call view shows, the call watch keeps `active: true` in the call state: the banner shows *In call with X* and **Hang up**. **Hang up** queues `hangup`, run by the call watch the same way: it clicks the hang-up button of the call view, `done` when the view is gone.

## Audio

- `docker-compose.yml`, service `browsers`: `SELKIES_MICROPHONE_ENABLED=true`, `SELKIES_MICROPHONE_ON_START=demand`. On demand, the phone is asked for its microphone only while an application records from the virtual source, and released 10 s after the last one stops.
- Browsers image: a Chromium managed policy `AudioCaptureAllowedUrls` naming the Teams origins of the accounts (`https://teams.microsoft.com`, `https://teams.cloud.microsoft`, `https://teams.cloud.microsoft.mcas.ms`). A matching origin gets the microphone without a prompt (Chromium policy, every platform since version 29; the pattern `*` is not accepted). The policy directory of this Chromium build is read on the image before the file is added; if Chromium does not apply it, the agent grants `microphone` to the Teams origin over DevTools at start instead.
- One PulseAudio for every account: during the call the phone hears every sound of the desktop, a ring of another account included. The microphone reaches only the application that records.
- Earphones on the phone: its loudspeaker reaches its own microphone.

## Contract

- Command types `answer` and `hangup` at the end of `COMMAND_TYPES` (`app/src/shared/slot-db/commands.ts`): `arg1` the caller, `arg2` `{"since": <ms>}` for `answer`, nothing for `hangup`. An agent of an earlier release ends both as `done` without a click, as it does any unknown type.
- `CallState` (`app/src/shared/slot-db/state.ts`) gains `active` (bool, default `false`), written by the call watch while the call view shows; `RingingCall` of the app gains it too.
- Push of a call: `answer: true` from the agent of an account of the browsers container.

## Phases

1. **Answer.** Everything above except the call view, `active` and **Hang up**: `answer` is `done` when the toast is gone. Deployed to prod on a yes, then tested live: a call from another account of the owner to slot 2, answered from the phone, sound both ways, hung up in Teams inside `/desktop/`. During that call a read-only DevTools probe of the agent's own tab (`window.__teamsHookInstalled`) records the call view: its root, the caller, the hang-up button, and whether Teams opens it in the same tab or a new window. The loop keeps moving Teams between chats during that call (parking, commands): the probe also records where the call goes then.
2. **In call and hang-up.** Call view selectors from the probe into `selectors.ts` and `teams-selectors.md`; fixture `call-active.html` rebuilt from the probe (names invented); `active` in the call state; parking and the jobs that open a chat wait while `active`; `hangup`; the banner. Deployed and tested live the same way.

## App

- `CallBanner`: **Answer** next to **Mute** for a ringing call of an account of the browsers container; *In call with X* and **Hang up** while `active`. A refused or failed answer shows *Call no longer ringing*.
- `sw.js`: a ringing call with `answer` gets the actions **Answer** and **Open**. **Answer** posts to `/api/call/answer?a=N` (the session cookie of the site goes with it) and opens `/api/desktop/N`; a refused answer opens the app on the account instead.

## Settings of the owner

Each account, once, in `/desktop/`: Teams **Settings** → **Calls** → **If unanswered** → the longest *Ring for this many seconds before redirecting* the tenant allows. Where the tenant hides the setting, the call has to be taken within the ring Teams gives.

## Tests

- Web app: 404 for another owner, 409 for a stopped account, 409 for an account on another computer, 409 for a call not ringing or of another `since`, two posts queue one `answer`; `hangup` only while `active`.
- Agent, page scripts in Chrome on `call-toast.html`: the click lands on *Accept with audio* of the toast of that call, never on *Decline call*; no toast gives `failed` with no click; an `answer` older than 30 s fails with no click; the loop leaves `answer` and `hangup` to the call watch. Phase 2: `call-active.html` gives `active`, `hangup` clicks the hang-up button only.
- `sw.js`: the actions show only for a ringing call with `answer`; **Answer** posts then opens the desktop; a 409 opens the app.
- Image: the policy file sits where this Chromium reads managed policies, a throwaway Chromium of the image lists it as applied, and the two `SELKIES_*` variables reach the Selkies process.
- Live on prod slot 2 after each phase, as in *Phases*.

## Docs

`limitations.md` (*Incoming calls*: answered from Chrome through the remote desktop), `setup.md` (phone: microphone permission of the site, earphones, ring time of each account), `configuration.md` (the two Selkies variables), `teams-selectors.md` (call view, phase 2), `operations.md` (log lines of `answer` and `hangup`).

## Out of scope

The Android app (`mobile/`), declining from the app, video calls, group calls, accounts on another computer, calls placed from the app.
