# The agent leaves Teams to the owner: implementation plan

Spec: [2026-09-29-owner-in-teams.md](2026-09-29-owner-in-teams.md). Branch `fix/pause-while-desktop-used`, on `fix/chat-back-on-screen`. Each task red first.

## Global constraints

- Nothing of the owner is ever taken for the agent's own: a span covers only what the agent runs, the tail is 1 s.
- Commands of the app, reads and the call watch never wait for the owner.
- Commit author `Aptul9 <aptul99@gmail.com>`, Conventional Commits; PR body empty; merge subject with `[skip ci]` unless the owner asks for the deploy.

### Task 1: the agent's own input

**Files:** `app/src/agent/teams/input.ts`; test `app/test/agent/input.test.ts`.

- `asAgent(page, fn)`, `byAgent(page, t)`, `TAIL_MS`; `withInput` runs each sequence inside `asAgent`.

### Task 2: input on the page

**Files:** `app/src/agent/teams/scripts/page-state.ts`; test `app/test/agent/page-state.test.ts`.

- `watchInput()` (`"installed"` once, then `"already"`), `drainInput(): number[]`.

### Task 3: the pause

**Files:** `app/src/shared/slot-db/state.ts` (`STATE.desktop`, `Desktop`, `AgentHealth.desktop`), `app/src/agent/logic/owner.ts`, `app/src/agent/context.ts`, `app/src/agent/jobs/page-setup.ts`, `app/src/agent/loop.ts`, `app/src/agent/commands/index.ts`, `app/src/agent/jobs/health.ts`; tests `app/test/agent/commands.test.ts`, `app/test/agent/health-job.test.ts`, `app/test/local/relay.test.ts`.

- `noteOwnerInput(a)` in the `page` job, `ownerUses(a)` in `free()`, the presence keeper and `awayFromChats`; commands, parking, feed and Read by inside `asAgent`; `desktop: "in-use"` in the health row.

### Task 4: the desktop opened from the app

**Files:** `app/src/lib/slotdb.ts` (`markDesktop`), `app/src/app/api/desktop/[slot]/route.ts`, `app/src/components/StatusPanel.tsx`; test `app/test/desktop-routes.test.ts`.

### Task 5: docs

`docs/limitations.md`, `docs/architecture.md`, `docs/operations.md`.
