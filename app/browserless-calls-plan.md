# Browserless calls: MCAS proof implementation plan

## Steps
- [x] Prove the MCAS form parser rejects unrelated destinations and malformed forms.
- [x] Run one normal MCAS handoff using isolated Npo state and an HTTP-only cookie jar.
- [ ] Inspect the returned continuation and prove fresh-code redemption if present.
- [x] Record results, then continue the approved calling sequence in `browserless-calls-spec.md`.

**Goal:** Establish the exact normal MCAS continuation before changing production renewal.

**Architecture:** A standalone diagnostic script uses the existing Playwright API request client for HTTP and cookie handling. No browser is launched, no live account mode changes, no outbound call is placed. The existing capture helper supplies only isolated account state.

**Tech Stack:** Node.js, existing `playwright-core`, existing Vitest.

## Global constraints
- Npo slot 1, MSC slot 2 and Aubay slot 6 stay in Always on browser mode during the spike.
- No production account is switched to light merely to prove API compatibility.
- No paid Azure resource, Entra permission grant or tenant change is created without separate approval.
- No 24-hour waiter. Long-session verification remains a manual check on the next day.
- Session material stays account-scoped, mode 600. Tokens, cookie values and authorization codes are never included in diagnostic output.
- Any new handler must complete the normal MCAS proxy handoff and preserve its session controls.

## Parser

Files: `scripts/mcas-auth-probe.mjs`, `test/agent/mcas-auth-probe.test.ts`.

Interface: `mcasForm(html)` returns `{ action: string, idToken: string }` for a single POST form to `https://<tenant>.access.mcas.ms/aad_login`. Other hosts, HTTP, credentials in a URL, nonstandard ports, other paths, multiple forms and missing tokens are rejected. Attribute entities are decoded before URL validation.

Run the parser test before implementation, then after implementation:

```powershell
npm test -- test/agent/mcas-auth-probe.test.ts
```

## Isolated handoff

Input: a scratch directory containing `session.json` and `light-token.json`, captured by the existing source capture job. The production paths under `/root/data` are never accepted as an output directory.

The probe performs the Teams authorize request with PKCE and state, stops automatic redirects, parses the observed MCAS form and posts its `id_token` only to the validated MCAS gateway. The API request client's cookie jar scopes cookies. Diagnostics contain only status codes, hosts, paths, cookie names and query-field names. A callback code is redeemed only after its state and destination validate. Every continuation is bounded.

```powershell
node scripts/mcas-auth-probe.mjs /tmp/teamsrelay-compat-20261107/1
```

A successful result must report an authorization code, token HTTP 200 and a fresh refresh token without emitting those values. An intermediate response is retained as a sanitized structural observation; it is not a successful renewal.

## Production gate

No `src/agent/light/session-auth.ts` change or deployment occurs before the normal MCAS handoff is proved. A proven flow is then ported under regression tests for state, callback validation, cookie isolation, error classification and existing direct redirects. The approved calls spec remains the source of constraints for the next calling phase.

## Offline calling transport

- [x] Load only the two pinned Trouter factories in Node with no real network access.
- [x] Verify synthetic registration/unregister payloads with fake token and HTTP responses.
- [x] Verify synthetic Socket.IO connection, Trouter authentication and automatic registration.
- [x] Inject event 107 through the fake WebSocket and verify decoding plus transport response 200.
- [x] Resolve the exact calling token contract before a spare-account live registration.
- [ ] Prove spare-account incoming signaling, then proceed to call control and media under the approved spec.

Files: `scripts/trouter-offline-probe.mjs`, `test/agent/trouter-offline-probe.test.ts`. Vendor code is not committed. The executable probe checks the downloaded artifact's SHA-256 before loading either factory. The VM receives only fake networking and synthetic tokens. Full calling handlers and media are not instantiated.

```powershell
npm test -- test/agent/trouter-offline-probe.test.ts
node scripts/trouter-offline-probe.mjs <path-to-cmd-trouter-14c2944133b694b2.js>
```

The tested bundle needed a `location` object but no browser process or DOM for this bounded transport test. This does not establish live authentication, incoming calls or WebRTC media compatibility.

## Live incoming signaling

- [x] Register and delete one isolated Bandpey endpoint using Node and the discovered Skype token.
- [x] Match owned Npo and Bandpey identities by token email/OID and the same two-member chat on both accounts.
- [x] Receive event 107 from an owner-approved Npo test call without a Bandpey browser.
- [x] Hang up the caller, delete the owned endpoint and verify protected browsers remain unchanged and green.
- [ ] Prove call acknowledgement, answer, mute, local hang-up and two-way audio before any calling migration.

Files: `scripts/trouter-live-probe.mjs`, `test/agent/trouter-live-probe.test.ts`. Live probe accepts only isolated slot 7 state, a pinned vendor artifact, freshly discovered routes and a new saved UUID. Optional listener requires an identified peer and a 1-120 second duration. Only matching event-107 payload is retained privately. The handler sends a delivery response and never constructs a call or invokes call acknowledgement.

First incoming test registered successfully but received no event in 60 seconds. Its registrar platform was the synthetic value `browser`. Shipped configuration uses `Chrome`, as observed in `async-entry-bc1d5354906007df.js` at byte 2986307 and the calling config assembly in `527114-88b201fa14176150.js`. Correcting that field produced a matched event 107 on the next Npo call. Both sender and receiver IDs matched the owned pair. Registrar POST and owned DELETE returned 202. Npo call and hang-up commands completed. No browser call implementation was replaced.

Npo MCAS reference captured a code callback but no broker authorization-code token request. Fresh refresh-token redemption remains blocked. No further response-mode guesses or production auth changes are justified by that receipt.

Probe rerun safety: ownership marker is created exclusively; new registration writes are fenced during shutdown; pending writes settle before terminal owned DELETE. An uncertain write outcome retains ownership and reports cleanup failure. Registration receipts count only the exact registrar POST, not Trouter allocation. Regression tests cover all three review findings. Registration-only live retest returned POST202 and DELETE202 without another peer call.

## Media-host boundary

- [x] Load the pinned pluginless factories with real network access denied in bounded Node children.
- [x] Reach registry initialization and synthetic event107 using disclosed metadata/presence stubs.
- [x] Locate the first substantive media operation: codec discovery constructs `RTCPeerConnection`.
- [ ] Select and prove a real media host before live acknowledgement or answer.

Independent rerun of `teamsrelay-media-offline/run.mjs` reproduced `NATIVE_MEDIA_REQUIRED: RTCPeerConnection` in `MK.getCapabilities`. Three child profiles executed; no target network request, native peer connection or SDP answer was produced. Presence stubs are not a WebRTC implementation. Existing TeamsRelay audio hub transports Opus packets, while the calling stack's raw media interfaces expect MediaStream tracks; direct compatibility remains unproved.

Subsequent scratch test installed pinned `@roamhq/wrtc@0.10.0` using checksum-verified npm 12.2.2 tooling, outside the application. Node v26.13.0 on Linux x64 loaded the native addon, negotiated local SDP/ICE and received 215040 samples per direction with measured 440 Hz synthetic audio. SDK registry/event107 initialization also ran with a real native peer-connection constructor and disclosed metadata/capture stubs. Docker network mode was none; no Teams identity or endpoint was used.

Native test remains failed overall: process exited 139 after tracks ended, sinks stopped and peer connections closed. Minimal source/track retention reproduces 139. Releasing wrappers and requesting GC avoids the minimal crash but did not fix the full harness. No forced exit was used. Actual Teams acknowledgement/answer, Opus-hub integration and reliable native lifecycle remain unproved. Current receipt and preserved failed attempts reside in `teamsrelay-native-media` under the local session scratch directory. No native package was added to the application or production image.

## Native lifecycle

Lifecycle bisection found the exit-139 cause. On Node 26 the closed `@roamhq/wrtc` peer connections, tracks and sinks are never collected, so their finalizers run during environment teardown and fault. Node 24 collects them and exits 0; upstream supports Node 20 and 22 only. Forty sequential negotiated audio calls in one process kept heap growth near 9 KiB per call and threads and descriptors flat. An explicit `process.exit(0)` after closing every call exits 0 on Node 26. Native media therefore belongs in its own child process, so a native fault cannot stop the agent.

## Call-audio hub adapter

`opusscript@0.1.1` (libopus 1.4, no dependencies, no install scripts) encodes the native sink to Opus 48 kHz mono 20 ms packets, the relay side of `src/server/call-audio-hub.ts`, and decodes the app's microphone packets (Opus 24 kHz mono, `MIC_ENCODER`) into a 60 ms jitter buffer feeding `RTCAudioSource`. Offline loopback: the 440 Hz downlink tone and the 660 Hz uplink tone were each present in every 100 ms window after start-up, with zero decode errors. PCM must reach opusscript as a byte `Buffer`; an `Int16Array` encodes garbage. Frames are paced by elapsed time, since interval timers drift. Not yet in the application.

## Live browserless media

- [x] Build the shipped calling stack in Node with native WebRTC and initialize the registry for Bandpey on a real Trouter registration.
- [x] Place a browserless call to Microsoft's Teams test-call service and prove two-way audio, mute, local and remote hang-up.
- [ ] Answer an owned incoming call (event 107, attach, accept) with two-way audio measured on both sides.

Files: `scripts/calling-live-host.mjs`, `scripts/calling-host-helpers.mjs`, `test/agent/calling-host-helpers.test.ts`. The host runs in an isolated container from the production image, bridge network, read-only root, nonroot, `@roamhq/wrtc` from scratch, pinned vendor bundles. The stack's HTTP goes through its own `HttpRequestDispatcherImplementation` over a fetch limited to https Teams and Skype hosts; no request was denied in any run.

The test call targets `28:cf28171e-fcfd-47e4-a1d6-79460b0b3ca0`, the `teamsEchoBotMri` of the shipped configuration. It plays a prompt, records a few seconds and plays them back. Results:

- `createCallAsync` with an empty thread, `addParticipant(bot)` and `start()` reached Connected in about 1.7 s; `POST epconv` 201.
- ICE connected in 170 to 340 ms with the Teams TURN servers from the ECS `MDN_TRAP` agent offered; selected pair srflx/udp; zero packet loss.
- The bot's speech arrived at 16 kHz. The host sends a melody of 200 ms notes (440, 554, 659, 880 Hz); the bot played it back in order, so uplink audio crossed the Teams media path.
- Muted over the bot's recording window, the bot heard nothing, said so and ended the call: mute silences the uplink. Unmuted runs play the melody back.
- `call.stop(false)` went Disconnecting then Disconnected with `leave` 204; the bot's own hang-up also reached Disconnected.

Node shims the stack needs: `getUserMedia` returning an `RTCAudioSource` track; an own `getSettings` on capture tracks through `Object.defineProperty` (plain assignment throws, `getUserMedia` then fails and the offer goes `recvonly`); an `AudioContext` whose media-stream destination is an `RTCAudioSource`, because the send path mixes the microphone through Web Audio; that mixer must emit silence while the source track is disabled, because a native sink on a local track keeps delivering frames when `enabled` is false and mute otherwise changes nothing; an audio element whose `srcObject` attaches `RTCAudioSink`; a Trouter URL observable whose `changed` carries `off`.

Incoming answer remains unproved live. The only proven owned caller, Npo slot 1, is signed out since 2026-11-07 13:10:36Z, waiting at the Microsoft sign-in page for the owner. MSC and Aubay have no one-to-one chat with Bandpey.

The MCAS reference audit established zero matched broker code-grant events, not zero token traffic in every format. Actual callback script execution and temporary-state availability were not retained. A bounded follow-up kept certificate requests denied and instrumented source identities, state-presence booleans and token-request metadata before filtering. It reached finalize_login200 but expired while proxied auth assets loaded, before callback or token events. No renewal was proved. This bounded diagnostic path stopped. No new HTTP auth variant or policy change was introduced.


## Hub integration proof

`calling-audio-bridge.mjs` now connects the native host to the existing call-audio hub protocol, using injected Opus codec and authenticated WebSocket transport. Microphone frames are bounded to 200 ms with 60 ms prebuffer. Teams 16/32/48 kHz audio is converted to 48 kHz mono Opus packets. `CALL_AUDIO_URL` opts into hub audio; no URL retains the synthetic test source.

Owned incoming calls 492 and 493 traversed the actual bundled `attachCallAudioHub` implementation in an isolated container. A synthetic app-side client supplied microphone Opus, Npo received its melody, and the app client decoded 878 downlink packets (393 non-silent). Bandpey mute/unmute and local hang-up passed. All slots green afterwards; production PIDs unchanged, owned endpoint and container removed. Queue drops before answer reflect microphone demand beginning before the call's source starts; this remains diagnostic behavior, not a production readiness claim.

Production integration remains open: account-scoped authorization for local native workers, app audio selection for browserless slots, persistent incoming notification/control wiring, dependency packaging and lifecycle supervision. Current host remains isolated slot-7 diagnostic, not a deployed replacement.


## Persistent integration

Native calling worker now starts from the light agent behind `NATIVE_CALLS=1`. Parent supplies discovery and identity, routes call state to existing slot database and notifications, and routes answer/mute/hangup/outgoing commands through IPC. Child crash restarts independently of chat polling; timeout terminates the worker to prevent late command completion. Stale owned registration is deleted before restart. Tokens renew through parent IPC, including during calls. Native worker is recycled while idle after 45 minutes. Hub bearer rotates per worker and is checked against the requested running light slot; web-page origins cannot use the bearer. App selects existing hub audio when callAudio is advertised, and light calls are included in event stream and permitted commands.

Packaging pins `@roamhq/wrtc` 0.10.0 and `opusscript` 0.1.1, verifies both vendor bundle digests during Docker build, and preserves browser mode unless native calling is explicitly enabled. Existing Npo/MSC/Aubay browser modes remain unchanged.

Persistent serve-mode IPC tested on owned incoming call: answer, mute, unmute, local hangup all returned success, worker exited 0, endpoint removed, all production slots stayed green. This exercised serve-mode worker and actual hub with synthetic app client; full deployed UI/authorization/controller chain still requires staging validation and controlled rollout.


## Rollout gate

Owner approved gradual production deployment, beginning with Bandpey slot 7; Npo/MSC/Aubay browser modes preserved. `NATIVE_CALLS` accepts `1` (all light slots) or a comma-separated slot list. Rollback captures current runtime image because original browser image ID is absent from local Docker inventory; writable container layer snapshot excludes mounted state. No default-branch merge or public PR text approved yet.

Full staged application API proof: call500, real app sign-in and session-bound hub authorization, commands queued through parent IPC; Answer/Mute/Unmute/Hangup done. Npo received the app tone, mute gap visible; app decoded 594 speaker packets with measured nonzero audio. Stage containers and network removed.


## Production result

Gradual rollout enabled Bandpey only (`NATIVE_CALLS=7`). Native hub uses public WSS through existing Caddy because browsers and webapp Docker networks are intentionally separate. Production incoming503: app Answer/Mute/Unmute/Hangup succeeded, 481 microphone packets and 605 speaker packets, Npo received test tone with mute gap. Production outgoing command33 to the owned `Antonio Maritato` chat and mute34/unmute35/hangup36 all completed; 1409 microphone packets and592 decoded speaker packets. All accounts green, no active call afterwards. Npo/MSC/Aubay retained browser mode.

An outgoing request for stale chat display name `MARITATO Antonio` failed without ringing; current CSA name `Antonio Maritato` passed. No display-name fallback to another peer was introduced.

Rollback images retained as `teamsrelay-rollback:teams-browsers` and `teamsrelay-rollback:teams-webapp`; original env/compose in `/var/tmp/teamsrelay-live-calling-20261107/rollback`. Restore those files, tag rollback images to `teamsrelay-browsers:latest` and `teamsrelay:latest`, then `docker compose up -d --no-build browsers webapp`.
