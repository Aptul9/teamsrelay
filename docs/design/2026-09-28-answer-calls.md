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
3. The app sends `POST /api/call/answer?a=N` with `{"since": <ms>}`. The web app checks that the session user owns slot N (404), that the account runs and is not on another computer (409), and that the call of that `since` still rings in the slot database (409, *Call no longer ringing*). It queues the command `answer`; a second tap while that command still waits gets the same command, a try after one that ended queues a new one.
4. The call watch of the agent runs `answer` at its next look, within 1 s; the loop does not, since one of its rounds can take seconds. The watch clicks *Accept with audio* in the toast of that call with a trusted click: `done` when the toast is gone within 5 s, `failed` when the call of that `since` no longer rings, no button shows, or the toast stays. The command goes from `pending` to `done` or `failed` directly: the loop ends every `running` command as `unconfirmed` at each round. An answer run again after a restart finds no toast of that call and fails without a click.
5. The app opens `/api/desktop/N` at once (a window opened after the request would count as a popup): the window of account N comes to the front and `/desktop/` loads. Selkies plays the call; with the microphone on demand it asks the phone for its microphone as soon as Teams records from `SelkiesVirtualMic`.
6. A call in progress is the Teams page recording from the microphone: an init script of every page and frame wraps `getUserMedia` and keeps its audio tracks, and the call watch keeps the state row `in_call` (`InCall`) while one is live, again every 2 s, and once more as over. The banner shows *In call with X*, **Desktop** and **Hang up**. **Hang up** queues `hangup`, run by the call watch the same way: the end-call shortcut of Teams web, Ctrl+Shift+H (Microsoft support, *Keyboard shortcuts for Microsoft Teams*, web column), on the page that records; `done` once no track is live within 5 s. No selector of the call view is needed. While the call lasts the loop runs no job that moves Teams (parking, full chat list, Activity feed, Read by, check of the day).

## Audio

- `docker-compose.yml`, service `browsers`: `SELKIES_MICROPHONE_ENABLED=true`, `SELKIES_MICROPHONE_ON_START=demand`. On demand, the phone is asked for its microphone only while an application records from the virtual source, and released 10 s after the last one stops.
- Without a viewer Selkies makes no `SelkiesVirtualMic` and the default source is `output.monitor`, the sound of the desktop (read in a container of the image, 2026-09-28): Teams answered before the phone connects would record that, and the microphone on demand would never be asked for. The start of the supervisor service (`svc-teamsrelay/run`) loads `module-virtual-source source_name=SelkiesVirtualMic master=input.monitor` as `abc` and makes it the default source; Selkies reuses an existing one.
- Browsers image: the Chromium managed policy `AudioCaptureAllowedUrls` (`/etc/chromium/policies/managed/teamsrelay.json`, the directory the Debian Chromium 153 of the image reads) names the Teams origins: `teams.microsoft.com`, `teams.cloud.microsoft`, `teams.live.com`, and the first two behind Defender for Cloud Apps (`.mcas.ms`). A matching origin gets the microphone without a prompt (Chromium policy, every platform since version 29; the pattern `*` is not accepted).
- Checked on the image (2026-09-28): a page on `https://teams.cloud.microsoft` and on its `.mcas.ms` host gets the microphone with no prompt and records from `SelkiesVirtualMic`, one on `https://example.com` is refused; a viewer with a fake microphone connected to Selkies was asked for it once while that page recorded, and the page went from silence to the beep of the viewer.
- One PulseAudio for every account: during the call the phone hears every sound of the desktop, a ring of another account included. The microphone reaches only the application that records.
- Earphones on the phone: its loudspeaker reaches its own microphone.

## Contract

- Command types `answer` and `hangup` at the end of `COMMAND_TYPES` (`app/src/shared/slot-db/commands.ts`): `arg1` the caller, `arg2` `{"since": <ms>}` for `answer`, nothing for `hangup`. An agent of an earlier release ends both as `done` without a click, as it does any unknown type.
- State row `in_call` (`STATE.inCall`, `InCall` in `app/src/shared/slot-db/state.ts`): `{caller, since, seen, active}`, the call answered and the last time the page was seen recording; `inCallOf` gives the call while `active` and `seen` at most `CALL_FRESH_FOR` s old. `RingingCall` of the app gains `active`: the event stream lists calls in progress next to the ringing ones.
- `AgentSettings.answerCalls`: true for the agent of a server slot, false for the local relay.
- Push of a call: `answer: true` from the agent of an account of the browsers container (`Notifier` option `answerable`); the push of a call answered from the app ends with *Answered in TeamsRelay*.

## Phases

Both parts ship together: the hang-up needs no selector of the call view, so nothing waits for a probe of a real call. Deployed to prod on a yes, then tested live: a call from another account of the owner to slot 2, answered from the phone, sound both ways, hung up from the app. During that call a read-only DevTools probe of the agent's own tab records the call view and whether Teams opens it in a window of its own, for `teams-selectors.md`.

## App

- `CallBanner`: **Answer** next to **Mute** for a ringing call of an account of the browsers container; *In call with X*, **Desktop** and **Hang up** for a call in progress, which rings no more. A refused answer shows its reason (*Call no longer ringing*), a failed hang-up says to end the call in the desktop.
- `sw.js`: a ringing call with `answer` gets the actions **Answer** and **Open**. **Answer** posts to `/api/call/answer?a=N` (the session cookie of the site goes with it) and opens the `desktop` it answers; a refusal or a server out of reach opens the app on the account instead.
- The desktop frame of the app (phone) carries `allow="microphone; autoplay"`, for a `DESKTOP_URL` on another origin.
- Microphone and speaker of the viewer: **Audio Settings** in the side menu of the Selkies desktop (*Input (Microphone)*, *Output (Speaker)*), already there; a phone uses the route of its system.

## Settings of the owner

Each account, once, in `/desktop/`: in Teams **Settings** → **Calls**, where unanswered calls are handled, the longest ring time the tenant allows ("Ring for this many seconds before redirecting"). Where the tenant hides the setting, the call has to be taken within the ring Teams gives.

## Tests

- Web app: 404 for another owner, 409 for a stopped or checked account and for an account on another computer, 409 for a call not ringing or of another `since`, 400 without a call, two posts while waiting give one command and a try after a failed one a new one; `hangup` only while a call is in progress; the event stream lists a call in progress as active.
- Agent: in Chrome on `call-toast.html` the click lands on *Accept with audio* only, never with the toast hidden; the microphone hook sees a live audio track, none once stopped, and no video track. Call watch with a fake page and store: answer done once the toast is gone, failed for another call, after the ring, without a button or with the toast staying, never `running`; the ended push of an answered call; `in_call` written and closed; hang-up done, failed without a call or with the microphone staying; nothing for a relay. Loop: `answer` and `hangup` stay pending there; the jobs that move Teams wait during a call. Four mutants of the call watch killed.
- `sw.js`: the actions show only for a ringing call with `answer`; **Answer** posts then opens the desktop; a 409 or a network error opens the app; **Open** answers nothing.
- Banner in Chrome: Answer answers that call, none for an account on another computer, a call in progress shows Desktop and Hang up and rings no more.
- Image: as under *Audio*.
- Live on prod slot 2, as in *Phases*.

## Docs

`limitations.md` (*Incoming calls*, *Answered calls*), `setup.md` (phone: answer, microphone permission of the site, microphone and speaker in the desktop, earphones, ring time of each account), `configuration.md` (Selkies variables of the remote desktop, the Chromium policy), `api.md` (the two endpoints), `architecture.md` (`in_call`), `teams-selectors.md` (the accept button, the call in progress, the hang-up shortcut), `operations.md` (log lines of `answer` and `hangup`).

## Out of scope

The Android app (`mobile/`), declining from the app, video calls, group calls, accounts on another computer, calls placed from the app.
