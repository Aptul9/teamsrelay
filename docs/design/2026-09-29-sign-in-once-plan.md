# One press of Sign in when Teams signs out: implementation plan

Spec: [2026-09-29-sign-in-once.md](2026-09-29-sign-in-once.md). Branch `fix/sign-in-once`, on `fix/pause-while-desktop-used`. Each task red first.

## Global constraints

- Never typed, never on a page with a field to type in, never another account, one attempt per sign-out and none within 30 minutes of the last.
- Nothing pressed when a text matches none or several elements.
- Commit author `Aptul9 <aptul99@gmail.com>`, Conventional Commits; PR body empty; merge subject with `[skip ci]` unless the owner asks for the deploy.

### Task 1: page scripts

**Files:** `app/src/agent/teams/selectors.ts` (`SEL.clickable`, `SEL.accountTile`, `SEL.fields`, `TEXTS.signInButton`, `TEXTS.microsoftButton`), `app/src/agent/teams/scripts/sign-in.ts`; fixtures `app/test/agent/fixtures/sign-in-teams.html`, `sign-in-microsoft.html` (rebuilt by hand); test `app/test/agent/page-sign-in.test.ts`.

### Task 2: the attempt

**Files:** `app/src/shared/sign-in.ts`, `app/src/shared/slot-db/state.ts` (`STATE.signInTry`, `SignInTry`), `app/src/agent/context.ts` (`alerts.signInTryAfter`, `alerts.signInTryWait`), `app/src/agent/teams/input.ts` (`cdpClick`), `app/src/agent/teams/call-actions.ts` (uses it), `app/src/agent/teams/sign-in-actions.ts`, `app/src/agent/jobs/sign-in.ts`; test `app/test/agent/sign-in-job.test.ts`.

### Task 3: the push and the loop

**Files:** `app/src/agent/jobs/health.ts` (`watchSignIn`), `app/src/agent/loop.ts` (job `sign-in`); tests `app/test/agent/health-job.test.ts`, `app/test/agent/commands.test.ts`, `app/test/local/relay.test.ts` with `app/test/local/fake-teams.html`.

### Task 4: checks

**Files:** `app/src/lib/checks.ts` (`SIGNED_OUT`); test `app/test/checks.test.ts`.

### Task 5: docs

`docs/teams-selectors.md`, `docs/limitations.md`, `docs/architecture.md`, `docs/operations.md`.
