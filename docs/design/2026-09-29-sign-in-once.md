# One press of Sign in when Teams signs out

Date: 2026-09-29.

**Goal:** when Teams signs out, the agent tries once what often works by hand: Teams' own **Sign in**, and on Microsoft's sign-in page one click on this account's tile or on its Sign in / Continue, so the session the browser still holds signs in by itself. It waits; Teams back, nothing is pushed; still signed out, the owner gets the push to sign in, which says the button did not help.

## Decisions

- One attempt per sign-out, 15 s after it started: a start of Teams passes through the sign-in hosts for a few seconds and goes on by itself. At most one attempt every 30 minutes whatever happens: a session that signs in and out again cannot make a loop. The attempt is kept in the slot db, so a restart of the agent does not try again.
- Never typed, never a password, never a code: a Microsoft page with any field to type in (password, code, email) gets nothing. Never another account: the tile pressed carries this account's email (the `me` row) as its `data-test-id` or as a whole word of its text.
- Everything is found by its text and pressed only when exactly one matches: none or several, nothing pressed, as before this change. No screen of this flow was ever read on a real account: the texts come from public reports (below), the fixtures are rebuilt by hand, and the buttons of each page are logged once per sign-out, so the next real one confirms them.
- A real click (CDP mouse events at a point of the element itself, as Accept of a call): Teams opens the Microsoft page in a popup (`window.open`), which the browser opens only for a click it trusts.
- Microsoft's page is watched for the owner's input from the first look and pressed at a later round only when none came: the owner signing in there by hand keeps it. The whole attempt waits while the owner uses Teams ([2026-09-29-owner-in-teams.md](2026-09-29-owner-in-teams.md)) and while a call rings or runs; never for an account never signed in (its first sign-in is the owner's), never once the owner was told.
- The push of a sign-out whose press pressed something goes 60 s after the attempt, about 75 s after the sign-out; with nothing pressed, after 60 s as before. A press that brought Teams back pushes nothing.
- Accounts checked every N hours try the same way: their check waits 90 s signed out (was 60 s) before *Microsoft sign-in needed*, longer than the press and its wait, so a press that worked gives a normal check. The local relay tries the same way in its window.
- *Stay signed in?* (Yes, No) is not pressed: not asked for. If a real sign-out stops there, the log shows it.

## What Teams and Microsoft show

- Teams: a banner *We need you to sign in again. This could be a request from your IT department or Teams, or the result of a password update.* with **Sign in** and *Learn more about sign-in requests* (PWAsForFirefox issue 704; the text is in `TEXTS.sessionLost`, seen on slot 2 on 2026-09-27). Its button opens the Microsoft identity platform with `window.open` (teams-for-linux issue 2621).
- Microsoft (`login.microsoftonline.com`, `login.live.com`, `login.microsoft.com`): *Pick an account* shows one tile per account, a `[role=button]` holding the name and the email (`data-test-id` the email) with a menu of sign-out options inside it, and *Use another account*; the password page a password field and **Sign in**; *Stay signed in?* Yes and No.

## Contract

- Slot db `state` key `sign_in_try`: `SignInTry` `{at, pressed, microsoft}`: when the attempt started (Unix s), what was pressed (`teams`, `account`, `button`), whether Microsoft's page was dealt with (pressed, asked for a field, or the owner was on it).
- `SIGN_IN_TRY_AFTER` 15 s, `SIGN_IN_TRY_WAIT` 60 s, `SIGN_IN_TRY_EVERY` 1800 s (`app/src/shared/sign-in.ts`); `alerts.signInTryAfter` and `alerts.signInTryWait` of the agent settings override the first two (tests). `checks.ts` `SIGNED_OUT` = 15 + 60 + 15 s.

## Agent

- Page scripts (`app/src/agent/teams/scripts/sign-in.ts`): `teamsSignIn` the point of Teams' Sign in when the page says to sign in again and shows exactly one; `microsoftSignIn` a field shown, or the point of this account's tile, or of the one Sign in / Continue; `visibleButtons` for the log.
- `app/src/agent/teams/sign-in-actions.ts`: `pressTeamsSignIn`, `pressMicrosoft` (the owner's input drained first), both inside `withInput` with `cdpClick`.
- Job `sign-in` (`app/src/agent/jobs/sign-in.ts`), every round, any page, while Teams is signed out and neither the owner nor a call is on: the attempt, then Microsoft's page (the agent's tab or a popup of the browser) at each round until dealt with or 60 s passed.
- `watchSignIn` (`app/src/agent/jobs/health.ts`): the push waits for the press, says *The Sign in button did not help*; Teams back after a press: logged, nothing pushed.

## Tests

- Page scripts in Chrome on the rebuilt fixtures: banner with Sign in, page without the banner, two Sign in, Sign in covered; picker with this account, another one and a longer email that contains it, Use another account; password page; code page; a page with one Continue and one with two; Stay signed in.
- Job with a fake browser: nothing before 15 s; one press; a restart does not press again; the tile in the popup once, a round after it shows; the lone Sign in or Continue; the Teams tab itself on the sign-in host; nothing on a page that asks for a field, nor where the owner types, nor 60 s after the attempt; 30 min between attempts; never for an account never signed in or once told; nothing when Teams shows two Sign in.
- Health job: the push after the press and its minute, with its text; no push when the press brought Teams back; with nothing pressed, 60 s as before.
- Loop: the job on any page, not while the owner uses Teams or a call rings or runs.
- The local relay in one process (`test/local/relay.test.ts`): its fake Teams banner has a Sign in that signs in on a trusted click only; the relay presses it, Teams comes back, nothing is pushed.
- Checks: a sign-out that the press ends is a normal check.

## Revision: an attempt only with something to act on (2026-09-29, evening)

Found on prod at the restart of the deploy: slot 2 starts through the hosts of the proxy of its tenant, and Teams read as signed out from 16:13:35 to past 16:13:50Z, on a page still loading. The attempt began 15 s in, found no Sign in and pressed nothing, as it should, but it counted as the attempt of that sign-out and held off the next one for 30 minutes. Now an attempt starts only once Teams shows its Sign in or a Microsoft sign-in page shows (checked at every round from 15 s on, until the push); the 30 minutes follow only an attempt that pressed something; the buttons of a sign-out that started no attempt are listed once, when the push goes out, so a real sign-out whose screens differ from these still says what it showed.

## Docs

`teams-selectors.md` (*Expired session*), `limitations.md` (*Expiring session*), `architecture.md` (loop table, checked accounts), `operations.md` (log lines).
