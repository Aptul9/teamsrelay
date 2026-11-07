# MCAS HTTP session renewal

## Steps
- [x] Share the tested MCAS form parsers and add inert configuration/bootstrap parsing tests.
- [x] Implement the HTTP MCAS renewal client with cookie rotation and matching-account SSO continuation.
- [x] Capture MCAS credentials from a normal browser run and wire HTTP renewal with A as fallback.
- [x] Verify the packaged client against Npo, four API scopes and native calling; run the full suite.
- [ ] Deploy through CI, verify Npo stays browserless across a forced renewal, and record the manual next-day check.

## Design

The isolated proof obtained a fresh code/refresh token in two seconds through the normal MCAS proxy. AAD returned a signed-in matching account on its 50058 page; the successful browser trace selected it through `/common/reprocess?ctx&sessionid`. State and PKCE validation, proxy token POST and its normal 307 redirect were retained. Four scope redemptions, chats 84 and feed 32 passed. No certificate-generation request was allowed.

Production renewal must not depend on a retained HAR. The normal browser capture reads the current proxied Teams root as HTML, discovers the observed MCAS bootstrap URL, and captures its Microsoft/MCAS cookies plus bootstrap URL. Each HTTP renewal obtains the current bootstrap configuration through its own cookie jar. Configuration is parsed as inert JSON, never executed.

The observed wrapper marks navigation with `McasCtx=4` and XHR with `McasCtx=2`, adds its active `McasTsid`, and adds `McasUserAuth` for token requests. The currently observed `urlIntegrityEnforcementEnabled` setting is false. A true setting is unsupported and falls back to A; it must never be changed or ignored.

## Components

- `scripts/mcas-auth-forms.mjs`: shared existing form parsers, strict JSON configuration extraction, observed bootstrap script discovery. The diagnostic CLI re-exports its existing parser interface.
- `src/agent/light/mcas-session.ts`: account-scoped credential capture/load/save, current bootstrap validation, bounded HTTP authorization flow, matching signed-in account selection, normal MCAS continuation, state/PKCE validation, token exchange and cookie rotation.
- `src/agent/jobs/light-token.ts`: capture MCAS session alongside the existing Microsoft session. Enable HTTP mode only after a usable current MCAS session was captured. Otherwise retain A.
- `src/agent/light/loop.ts`: choose MCAS HTTP renewal only for captured MCAS credentials. Failure that requires interaction restores A; transient failures leave current tokens usable.

## Constraints

- Preserve `app/browserless-auth-spec.md`, untracked.
- No new dependencies, paid resource, tenant grant, consent, policy or certificate change.
- No browser launch in the HTTP renewal client. Credential capture occurs only inside an already-authorized browser run.
- Honor the normal proxy, default monitored-access continuation and its 307 token redirect. Unknown/custom consent or MFA screens require browser fallback.
- Only an already-signed-in session matching the account's login hint can be selected. Validate state before any code exchange.
- Credential files remain account-scoped and mode 600. No token/cookie/code value enters logs, tests, git or reports.
- Do not replace working production state until the new packaged path passes. Keep A as fallback.
- No 24-hour waiter. A natural next-day renewal check remains manual.

## Verification

Write failing tests before production implementation. Preserve the existing direct-session, A scheduler, call-deferral and capture regressions. Exercise MCAS cookie rotation, strict destinations, wrong-state rejection, matching-account selection, unknown/custom screens, unsupported integrity policy and normal proxy token redirection. Run lint, typecheck, full suite and Linux image checks. Prove a fresh Npo token through the built client, four scopes/chat/feed, and a real native echo test before rollout. After deploy, prove the app's scheduler and light agent perform a forced renewal without starting Chromium.

## Rollback

Remove only the owned MCAS-session credential to restore A on the next browser capture; never delete the account profile. A permanent source rollback follows the feature branch/PR workflow. The existing pinned images and Npo profile backup remain available for service rollback.
