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

The MCAS reference audit established zero matched broker code-grant events, not zero token traffic in every format. Actual callback script execution and temporary-state availability were not retained. A bounded follow-up diagnostic keeps certificate requests denied and captures only the missing source identities, state-presence booleans and token-request metadata before filtering. No new HTTP auth variant or policy change is introduced.
