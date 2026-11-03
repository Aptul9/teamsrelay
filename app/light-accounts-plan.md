# Light accounts: plan

Planned 2026-11-03. Decision and spike evidence: vault `02_Areas/Decisions/2026-11-03-teamsrelay-light-accounts.md`.

## Goal

A Teams account that runs without its own browser in steady state: about 80 MiB instead of about 2 GiB. It lists chats, pushes new messages, reads chats, sends, replies, edits, deletes and reacts through chatsvc, and reports missed calls and @mentions through the API. Calls stay on browser accounts.

## Decisions

| Topic | Decision |
|---|---|
| Token source | MSAL refresh token captured from the account's browser run, redeemed in Node for ic3 and chatsvcagg access tokens; the rolled refresh token replaces the stored one |
| Browser | starts once a day, one account at a time (checked-mode queue), to capture a fresh 24 h refresh token, then stops |
| Chat list | csa aggregator `GET /api/csa/{region}/api/v2/teams/users/me` every 60 s, mapped to the rows `NewMessageDetector` and `SlotStore.saveChats` already take |
| Conversation ids | from the same poll (title and 1:1 name to id), no IndexedDB |
| Messages and writes | existing page-free chatsvc functions in `src/agent/teams/chatsvc.ts` |
| Process | separate entry `src/agent/light.ts`, bundled to `light.cjs`, no Playwright import |
| Mode | per-account column `light` in `teams_accounts`, set in Settings like `check_every`; needs one browser sign-in first |
| Calls | not available on a light account |

## Constraints

- The refresh token is a credential: `data/N/light-token.json`, mode 600, never committed, never logged, never sent to the web app.
- Every push to `main` deploys: build on `feat/light-accounts`, merge only on the owner's yes.
- No change to how browser accounts behave.

## Tasks

### Task 1: token renewal
`src/agent/light/token.ts`: read and write `light-token.json`; `accessToken(scope)` returns a cached token until 5 min before expiry, else redeems the refresh token at `https://login.microsoftonline.com/{tid}/oauth2/v2.0/token` (header `Origin: https://teams.microsoft.com`), stores the rolled refresh token. A 400 `invalid_grant` marks the account signed out. Tests with mocked fetch: cache hit, renewal, roll persisted, `invalid_grant`, file mode 600.

### Task 2: refresh-token capture
During a browser run of a light account the agent reads the MSAL `refreshtoken` entry from page localStorage and writes `light-token.json`. Test with a fake page.

### Task 3: chat list from csa
`src/agent/light/list.ts`: csa response to `ListRow`-shaped rows (name, preview, time, unread, muted, kind) plus a name-to-conversation-id map. Recorded fixture with names replaced. Tests: 1:1 name from members and last message, titled group, hidden chats skipped, unread from `isRead`.

### Task 4: light loop
`src/agent/light.ts`: poll every 60 s, `saveChats`, `NewMessageDetector`, `Notifier`, health row (`ok`, `login` on `invalid_grant`), open chat via `fetchChatMessages`.

### Task 5: light commands
open, send, reply, edit, delete, react through chatsvc with the poll's conversation ids; image, mentions, undo-delete, downloads answer "not on a light account".

### Task 6: missed calls and @mentions
Spike first: Activity feed through the substrate or csa API with a renewed token. If no endpoint answers, the daily browser run reads the feed instead.

### Task 7: supervisor, mode and daily refresh
`light` column, API, Settings switch; supervisor runs `light.cjs` instead of browser plus agent; checked-mode queue starts the browser once a day for Task 2, then stops it.

### Task 8: prod check
One secondary account switched to light on prod: memory read from the cgroup, a real message pushed, a send round trip, a day across a refresh run.
