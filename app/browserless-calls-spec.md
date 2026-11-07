# Browserless calls spike

## Goal

Remove the server Chromium dependency from calls made and received as the existing Teams user. Preserve incoming notifications, answer, hang-up, mute and two-way audio in TeamsRelay. Existing call browsers remain until the replacement passes those checks.

## Constraints

- Npo slot 1, MSC slot 2 and Aubay slot 6 stay in Always on browser mode during the spike.
- No production account is switched to light merely to prove API compatibility.
- Initial experiments use an isolated Bandpey slot 7 identity and scratch state. No live call is placed or answered by the spike without an explicit test case and chosen owner-controlled peer.
- No paid Azure resource, Entra permission grant or tenant change is created without separate approval.
- No 24-hour waiter. Long-session verification remains a manual check on the next day.
- Session material stays account-scoped, mode 600. Tokens, cookie values and authorization codes are never included in diagnostic output.
- Any new handler must complete the normal MCAS proxy handoff and preserve its session controls.

## Observed baseline

The deployed release is `4c44c6a`. Aubay was restored to Always on through `PATCH /api/accounts/6` with `{"checkEvery":0}`. Its stale Teams cache was reset while retaining Microsoft session cookies. Silent sign-in restored `teams=ok`, `overall=green`. No live test call was placed.

MSC passed an isolated probe using the actual capture, session-renewal, token, chat-list and feed modules: authorize 302, token redemption 200, fresh 24-hour refresh token, four audience tokens, 39 listed chats, readable feed, presence endpoint 201, activity report 200 and own presence Available. The live browser stayed running.

Npo passed four-audience token redemption, chat-list and feed reads, 38 listed chats, presence endpoint registration and Available readback. Its new daily renewal did not pass: authorize returned HTTP 200 with title `Working...` and a form posting an `id_token` to `https://nposervices-onmicrosoft-com.access.mcas.ms/aad_login`. `session-auth.ts` currently accepts only the authorization-code redirect and classifies this continuation as requiring sign-in. This missing MCAS continuation must be handled before Npo is moved off its browser.

## Calling approaches

### Selected: isolated Teams protocol spike

Use the same permitted Teams web identity and captured-session renewal. Trace the shipped calling client to its registration, incoming-event and media boundaries. First prove headless registration and incoming signaling on the spare account. Add media only after that succeeds. The existing command queue, notifications and Opus audio hub are reused where their contracts fit.

The inspected calling adapter exposes SlimCore loader and manager components. Standalone Node execution and browserless calling remain unproven. No browserless call has been completed yet.

Risks: undocumented signaling and media contracts, browser/native dependencies, protocol changes. A failed spike leaves the existing browsers unchanged.

### Alternative: Azure Communication Services SDK

The documented Teams-user SDK path supports user calling, but requires an Azure Communication Services resource, a Microsoft Entra application and `Teams.ManageCalls`/`Teams.ManageChats` consent. Tenant administrators may need to approve the application. Azure consumption charges apply. MSC Conditional Access compatibility is not established by the current web-session test.

This path requires client SDK integration rather than assuming the existing Node audio hub can act as a supported ACS Calling SDK host. No resource or permission is created during the comparison.

Graph `call: answer` has no delegated-user permission support. Its application/bot model is not a replacement for ordinary calls to the existing user identity.

## Approved sequence

1. Add and verify the normal MCAS continuation in an isolated Npo authentication spike. Validate allowed destinations, state, PKCE and cookie scope before any code exchange. Keep the live call browser running.
2. Prove spare-account calling registration and incoming events without Chromium.
3. Prove answer, hang-up and mute against an owner-controlled peer.
4. Prove two-way audio, incoming push while the app is backgrounded and recovery after restart.
5. Run the existing test suite and browser-backed call regressions. Migrate a call-critical account only after the replacement passes and the account change is approved.

## First sign-in

Current onboarding uses the account's server browser through the existing remote desktop. Microsoft handles password and MFA. TeamsRelay captures the refresh token and Microsoft session cookies. Stored state survives service restarts. Another interactive sign-in is needed only when Microsoft requires it or the stored session is unavailable.

A console snippet can read some Teams application storage, but a copied access token is short-lived and a copied SPA refresh token retains the 24-hour cap. The reusable `ESTSAUTH` and `ESTSAUTHPERSISTENT` cookies observed on MSC are HttpOnly and cannot be read through page JavaScript.

Own-browser onboarding would need a separate handoff feature, such as an explicit local extension/helper or manual DevTools export into a protected importer. It is not implemented. Session portability and tenant policies must be tested rather than assumed. Existing accounts are already onboarded; no new credential entry is required for the current tests.

## Evidence

- Calling adapter: `https://teams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/services-calling-service-adapters-1fb3a2cd5aba495a.js`.
- SHA-256: `BF741FB9C6EA4A5B16796E04258464861B3A01FBD940FBFDE7F949777F7E8CF0`.
- REA parent: `ev_427870e1cbc6c4626479f813defa627a373559b4cc4a09c9aaabcd050bd17438`. One bundle selected, 22 recovered modules, partial semantic coverage. No calling runtime was executed by the analyzer.
- Retained evidence: `C:\Users\Antonio\AppData\Local\Temp\opencode\teamsrelay-calling-evidence-20261107.json`.
- [Teams-user authentication prerequisites](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/manage-teams-identity).
- [Teams-user interoperability and pricing](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-endpoint).
- [Graph call answer permissions](https://learn.microsoft.com/en-us/graph/api/call-answer?view=graph-rest-1.0).
