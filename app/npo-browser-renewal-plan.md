# Npo browser renewal

## Steps
- [x] Add browser-renewal state and scheduler regression tests.
- [x] Keep captures fresh across browser fallback and preserve Microsoft sessions.
- [x] Handle the ordinary MCAS monitored-access notice without accepting other prompts.
- [ ] Run the full suite and verify a packaged renewal with Npo before rollout.
- [x] Start REA analysis of the retained MCAS callback artifacts for browserless renewal.

## Goal

Run Npo in light mode between bounded browser renewals. Reuse its persistent profile and the existing `runRefresh` path. Keep HTTP renewal for accounts that support it. A refused HTTP session gets a browser fallback before owner sign-in is required.

## Constraints

- Preserve `app/browserless-auth-spec.md`, untracked.
- No tenant, consent, policy, certificate, Azure resource or paid service change.
- Complete the normal MCAS handoff. Do not bypass session controls.
- No 24-hour waiter. Report the distinction between a forced renewal test and natural next-day renewal.
- Use the existing profile, never a new login profile for production renewal.
- Do not restart an account during an active or ringing call.
- Keep tokens and cookie values out of diagnostics and git.
- Browser renewal temporarily replaces the light agent with the existing browser agent. Do not claim uninterrupted native calls during that interval.

## Evidence

`refreshDue` currently refuses all automatic browser runs once `session` is true, including when HTTP renewal is refused. `SessionAuth.renew` accepts only a direct authorization-code redirect. Npo's observed HTTP 200 form to its MCAS `/aad_login` is therefore classified as requiring sign-in.

Microsoft documents a 24-hour SPA refresh-token lifetime, including rotated refresh tokens. A persistent browser session can silently obtain another token family without a password. Cookie expiry is not proof of effective Conditional Access sign-in frequency.

Sources: `https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens` and `https://learn.microsoft.com/en-us/entra/identity-platform/scenario-spa-acquire-token`.

## State and scheduling

Extend `LightSignIn` with optional `browser: boolean`. MCAS captures set it. Refused HTTP renewal sets it without declaring a still-usable token signed out. The scheduler keeps direct sessions browserless, but starts a browser for `browser` accounts near the saved token expiry or when scope redemption is refused. Existing success/failure cooldowns remain. A failed login is not retried automatically until the owner requests it or a new token is captured.

`runRefresh` must not accept an old `session: true` row as success. It waits for a capture from this run. Browser-backed renewal additionally requires a token with at least `MIN_LIFE` left. An explicit request with an old token is allowed to finish only after recapture, not on the pre-existing row.

## Capture and fresh sign-in

`captureLightToken` records whether the Teams page is proxied by MCAS. When a browser renewal is due, `freshSignIn` must not skip it merely because Microsoft cookies were captured. A known-ending stored token must not be relabelled with another 20-hour lifetime just because a related refresh token rotated. Fresh captures are accepted after Teams completes its normal authorization flow. Only Teams storage is reset when needed; Microsoft and MCAS login cookies are retained.

## Notice

Recognize only HTTPS `*.access.mcas.ms` and the exact monitored-access context identifiers already observed by `mcas-auth-probe.mjs`. Accept its single visible Continue control, optionally its unambiguous hide-for-a-week checkbox. Do not act on password, MFA, consent, custom terms, deny or other interstitials. Owner input suppresses automatic clicks. The agent loop must inspect this before declaring there is no Teams tab.

## Tests

1. Add failing tests to `test/light-mode.test.ts`: proxied daily run due, direct session skipped, refused session fallback, cooldown, old capture rejected, fresh proxy capture accepted, failed-login bounded retry.
2. Run `npx vitest run test/light-mode.test.ts`. Confirm the new assertions fail for the missing behavior.
3. Implement state and scheduling in `src/shared/slot-db/state.ts` and `src/lib/light.ts`. Rerun the same command.
4. Add failing cases to `test/agent/session-renewal.test.ts`, `test/agent/light-loop.test.ts` and `test/agent/fresh-sign-in.test.ts`. Verify MCAS/fallback state, no false sign-out, fresh-capture gate and unchanged HTTP renewal.
5. Implement the minimal changes in `src/agent/light/loop.ts`, `src/agent/jobs/light-token.ts` and `src/agent/jobs/fresh-sign-in.ts`. Rerun those tests.
6. Add Chrome fixture tests for the guarded notice handler. Assert successful navigation, no second click, unknown context rejected, wrong host rejected and owner input respected. Run the tests red, implement the handler and loop integration, run green.
7. Run `npm run lint`, `npm run typecheck`, `npm test`, `node scripts/bundles.mjs agent light` and the production image build.

## Live verification and rollback

Capture current slot modes, image IDs and Npo profile backup before a mode change. Verify no active/ringing calls. Run the packaged browser-renewal path, confirm a new usable refresh token, real chat/feed reads and native call readiness. Verify two-way audio against the Teams test-call service before keeping Npo in light mode. A startup or sign-in failure returns Npo to Always on through `PATCH /api/accounts/1` with `{"checkEvery":0}`. Do not delete or replace its profile.

## Browserless research

After A passes, use REA on retained Teams callback/MSAL/MCAS source artifacts. Distinguish source observations from runtime evidence. Resolve callback storage and token-redemption prerequisites. Keep `https://mcas-proxyweb.mcas.ms/generate-certificates` denied. Export evidence with source identities, remaining unknowns and the smallest justified next experiment.
