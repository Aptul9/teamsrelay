# Multi-user web app: implementation plan

Decision: [2026-09-26-multi-user-nextjs.md](../decisions/2026-09-26-multi-user-nextjs.md). Audit: [2026-09-26-dependency-audit.md](../decisions/2026-09-26-dependency-audit.md).

**Goal:** several users on one TeamsRelay server, each with their own login, Teams accounts and push devices, served by a Next.js web app.

**Architecture:** the Next.js app replaces `webapp/` (FastAPI and `index.html`). It keeps the API paths of the previous web app and the SQLite contract with the agents: commands and data in `data/N/messages.db`, slot ownership and push subscriptions in `data/app.db`. The Python agents change only where they read `app.db` and in the chat matching fix.

**Stack:** Next.js 16.3 (App Router, standalone output), React 19.3, TypeScript 6.0, better-auth 1.7 with the admin plugin, better-sqlite3 13, Vitest 5, ESLint 10, Node 24 LTS. Agent: Python 3.14, Playwright 1.63, pywebpush 2.5.

## Constraints

- TypeScript stays on 6.0: TypeScript 7 is the native compiler, and Next.js type checking relies on the JavaScript API of the `typescript` package.
- No public sign-up. The first administrator is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` when the user table is empty.
- Every per-account request checks that the session user owns the slot, administrators included.
- Legacy tables `accounts` and `push_subs` in `app.db` are read once for the migration and never written.
- The agent keeps the tables and command types of `data/N/messages.db` unchanged.
- API paths and JSON shapes of the previous web app are kept (see `docs/api.md`), plus `/api/events` and the admin endpoints.
- Code, UI text, comments and documentation are in English.

## Data model

`data/app.db`:

| Table | Owner | Columns |
|---|---|---|
| `user`, `session`, `account`, `verification` | better-auth | better-auth schema plus `role`, `banned`, `banReason`, `banExpires` (admin plugin) |
| `teams_accounts` | web app | `slot INTEGER PRIMARY KEY`, `owner_id TEXT NOT NULL`, `added INTEGER NOT NULL` |
| `push_subscriptions` | web app | `endpoint TEXT PRIMARY KEY`, `user_id TEXT NOT NULL`, `sub TEXT NOT NULL`, `created INTEGER NOT NULL` |
| `accounts`, `push_subs` | legacy, read-only | previous release |

`PRAGMA user_version` = 2 once the web app schema and the legacy migration are applied.

`data/N/messages.db` is unchanged: `chats`, `chat_messages`, `readby`, `activity`, `commands`, `messages`, `state`.

## Tasks

### 1. Dependency refresh

Files: `agent/Dockerfile`, `agent/requirements.txt` (new), `docker-compose.yml`, `.github/workflows/ci-cd.yml`, `.github/dependabot.yml` (new).

- Agent image on `python:3.14-slim`, dependencies from `requirements.txt`: `playwright==1.63.0`, `pywebpush==2.5.0`.
- `caddy:2.11.4-alpine`; Chromium pinned by digest; `wollomatic/socket-proxy:1.13.1` with `-allowPOST=(/v1\.[0-9]+)?/containers/teams-(chromium|agent)-[0-9]+/(start|stop)`, read-only, all capabilities dropped.
- CI actions on v7, Node 24.
- Verify: `docker compose config -q`, image builds, a POST to another container's start endpoint through the proxy returns 403.

### 2. Chat matching in the agent

Files: `agent/agent.py`, `agent/test_agent.py` (new), `webapp/test/agent-open-chat.test.ts` (new).

- `OPEN_CHAT_ROW_JS` (named constant): parse the chat name of each row exactly as `CHATS_JS` does; click the row whose name equals the requested name, otherwise the only row whose name starts with it; no match or several prefix matches: no click.
- `same_chat(cur, name)`: equal names match; names that are prefixes of each other match only when the open title is not another known chat (`chats` table).
- Verify: `python -m unittest agent/test_agent.py`; the fixture test runs `CHATS_JS` and `OPEN_CHAT_ROW_JS` in Chrome on a page with "Luca Bianchini" listed above "Luca Bianchi" and expects the second row to be clicked.

### 3. Web app scaffold

Files: `webapp/package.json`, `webapp/tsconfig.json`, `webapp/next.config.ts`, `webapp/eslint.config.mjs`, `webapp/vitest.config.ts`, `webapp/Dockerfile`, `webapp/.dockerignore`, `webapp/public/*` (service worker, manifest, icons moved from `webapp/static`).

- `output: "standalone"`, image `node:24-slim`, listens on 8090, runs `node server.js`.
- Scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `test`.
- Verify: `npm run build`, `docker build ./webapp`.

### 4. Databases

Files: `webapp/src/lib/config.ts`, `webapp/src/lib/appdb.ts`, `webapp/src/lib/slotdb.ts`, tests in `webapp/test/`.

- `appdb.ts`: opens `app.db` (WAL), applies the web app schema, migrates legacy slots and devices to a given user id; queries for `teams_accounts` and `push_subscriptions`.
- `slotdb.ts`: opens `data/N/messages.db` read-write without creating it; reads chats, messages (with `extra` merged), activity, feed, state, command status; inserts commands.
- Verify: Vitest on a temporary directory: schema idempotent, legacy migration, command insert and read back, missing slot database gives "not ready".

### 5. Authentication

Files: `webapp/src/lib/auth.ts`, `webapp/src/lib/auth-client.ts`, `webapp/src/lib/session.ts`, `webapp/src/instrumentation.ts`, `webapp/src/proxy.ts`, `webapp/src/app/api/auth/[...all]/route.ts`, `webapp/src/app/login/page.tsx`.

- better-auth on the same `app.db`: email and password, `disableSignUp`, admin plugin, 30-day sessions refreshed daily.
- `instrumentation.ts` runs the better-auth migrations, the web app schema and, with an empty user table, creates the administrator from `ADMIN_EMAIL` / `ADMIN_PASSWORD` and hands the legacy data to it.
- `session.ts`: `requireUser(request)`, `requireAdmin(request)`, `requireSlot(request)` (slot from `?a=N`, owned by the session user, otherwise 404).
- Verify: Vitest for `requireSlot` ownership rules; login and logout through the browser.

### 6. Slots

Files: `webapp/src/lib/docker.ts`, `webapp/src/lib/slots.ts`, `webapp/src/app/api/accounts/route.ts`, `webapp/src/app/api/accounts/[slot]/route.ts`.

- Free slot allocation from `SLOT_COUNT`, per-user cap `ACCOUNTS_PER_USER`, wipe of `config/N` and `data/N`, start and stop through the socket proxy, a loop that keeps owned slots running (every 60 s, under the same lock as add and remove).
- Verify: Vitest with a stub Docker client (allocation, cap, rollback when start fails); add and remove from the UI against the local stack.

### 7. API

Files: `webapp/src/app/api/**/route.ts`, `webapp/src/app/media/[file]/route.ts`, `webapp/src/app/files/[file]/route.ts`, `webapp/src/lib/http.ts`.

- Same paths, parameters and bodies as the previous web app. File name checks on `/media` and `/files` kept (`[0-9a-f]{16}` names).
- `/api/authcheck`: parses `X-Forwarded-Uri`, `/desktop/N/` requires ownership of N; no session: 302 to `/login?next=`; foreign slot: 403.
- `/api/push/subscribe` stores the subscription for the session user.
- Verify: Vitest on input validation; curl against the local stack for 401, 403, 404 and a queued command.

### 8. Server-sent events

Files: `webapp/src/app/api/events/route.ts`, `webapp/src/lib/stream.ts`.

- One stream per open PWA: `?a=N&chat=<name>`. Every second the server reads chats, open chat messages, health, activity and the user's accounts, and emits an event only for the parts whose content changed. Comment ping every 20 s.
- Verify: `curl -N` shows `chats` and `health` events once, then again only after a change in `messages.db`.

### 9. PWA

Files: `webapp/src/app/page.tsx`, `webapp/src/app/layout.tsx`, `webapp/src/app/globals.css`, `webapp/src/components/*.tsx`, `webapp/src/lib/api.ts`.

- Port of the previous `index.html` behaviour: account switcher, status panel, chat list with filters and pull to refresh, conversation with pending messages, reply, edit, delete and undo, reactions and pills, downloads, activity feed, desktop tab, push opt-in, notification click opening the right account.
- Message HTML produced by the agent is sanitized again in the browser (DOMPurify) before rendering.
- Verify: local stack with a seeded `messages.db` (`webapp/scripts/seed-slot.mjs`), every view exercised in Chrome.

### 10. Administration

Files: `webapp/src/app/admin/page.tsx`, `webapp/src/app/api/admin/users/**/route.ts`.

- List users with their slots, create a user, set a password, revoke sessions, delete a user (frees and wipes their slots first). Own password change and sign-out of other devices for every user.
- Verify: create a second user locally, check that it sees none of the first user's slots, desktops or events.

### 11. Agent: owner-scoped push

Files: `agent/agent.py`.

- `push_all` and `push_count` read `push_subscriptions` joined to `teams_accounts` on the owner of `ACCOUNT`; expired endpoints are deleted there. `acc_label` counts the accounts of the same owner. The agent no longer creates tables in `app.db`.
- Verify: `python -m unittest agent/test_agent.py` on a temporary `app.db` with two users.

### 12. Compose, Caddy, deploy

Files: `docker-compose.yml`, `compose.local.yml`, `compose.local.env`, `caddy/Caddyfile`, `deploy/remote-deploy.sh`, `.env.example`.

- Network `slotN` per slot with `chromium-N` and Caddy; `default` for Caddy and web app; internal `control` for web app and proxy.
- One Caddy route for every desktop: `/desktop/{n}/` with `forward_auth` and upstream `chromium-{n}:3000`.
- Deploy preflight: `.env` must define `BETTER_AUTH_SECRET` (or the old `SESSION_SECRET`) and, while `app.db` has no users, `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Legacy layout migration removed.
- Verify: `docker compose config -q` (production and local), `caddy validate`, local stack up, a desktop of one user refused to another user.

### 13. CI

Files: `.github/workflows/ci-cd.yml`.

- Agent: `py_compile`, unit tests. Web app: `npm ci`, lint, typecheck, test, build. Compose and Caddy validation, image builds. Docs build removed.

### 14. Documentation

Files: `README.md`, `docs/*.md`; removed: `docs/.vitepress`, `docs/guida`, `docs/riferimento`, `docs/appendici`, `docs/index.md`, `docs/public`, root `package.json` and `package-lock.json`.

- English, plain Markdown: README, architecture, setup, configuration, operations, security, API, Teams selectors, limitations.

## Later phases

- Agent ported to TypeScript (Node Playwright), sharing types and page scripts with the web app.
- Read path from the CDP network layer instead of the DOM, after a spike on live Teams.
- Sending images and files.
- Conversation ids instead of display names.
