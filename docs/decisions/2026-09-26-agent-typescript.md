# Agent in TypeScript, one image with two entrypoints

Date: 2026-09-26. Status: accepted. Plan and parity checklist: [2026-09-26-agent-typescript-plan.md](../design/2026-09-26-agent-typescript-plan.md).

## Context

After the multi-user release the web app was TypeScript and the agent a single Python file, `agent/agent.py`: 1203 lines, 59 functions, 30 scripts run inside the Teams page as JavaScript strings. Its Python dependencies were only a CDP client (Playwright, which already runs a bundled Node driver) and a Web Push library. Two languages, two images and two test setups served one product.

Chrome DevTools listens on `127.0.0.1:9222` inside each `chromium-N` container, without authentication. The agent reaches it only because it shares the network namespace of that container.

## Options

| Process model | Consequence |
|---|---|
| One package, one image, two entrypoints (web app, agent); one agent process per slot as today | Same isolation as before; one codebase, one build, one test runner. |
| One process for the web app and every agent | DevTools would have to listen on the slot networks, and the web app would join them: a page open in a slot browser could reach the web app, which undoes the network isolation of [security.md](../security.md). |
| Keep the Python agent | Two languages; page scripts stay strings extracted by regular expression for their tests. |

| Push TTL | Consequence |
|---|---|
| 0, as pywebpush sent | A phone offline or asleep at that moment loses the push. |
| 1 hour | A phone back within the hour gets the push; later ones are dropped, the app still shows the chats. |
| 24 hours or the web-push default of 4 weeks | A phone off overnight gets every push of the night at once, one notification each (`sw.js` gives every push its own tag). |

## Decision

- The agent is rewritten in TypeScript inside the web app package, renamed `app/`. esbuild bundles it into `agent.cjs`; `playwright-core` and `better-sqlite3` stay external and are copied into the image explicitly, because the standalone output of Next.js traces only the web app.
- One image, `teamsrelay`. The web app runs `node server.js`; `agent-N` runs `node agent.cjs` in the network namespace of `chromium-N`.
- The SQLite contract of `data/N/messages.db` does not change: tables, columns, command types and statuses, state keys. It is described once in `app/src/shared/slot-db` and used by both sides. A slot can run either agent during the migration.
- Push TTL: 1 hour for every push.
- The VAPID keys stay: the agent derives the public key from `vapid/private_key.pem` and stops at start when it differs from `vapid/appkey.txt`.
- Page scripts are TypeScript functions passed to `page.evaluate`; selectors, hosts and the English texts read on the page live in `app/src/agent/teams/selectors.ts` and reach the scripts as argument.

## Consequences

- The Python tooling goes: `agent/`, `tools/gen_vapid.py` (replaced by `app/scripts/gen-vapid.mjs`), `tools/genicons.py` (the icons are committed PNGs, the 512 px one is the master), the Python CI step and pip in Dependabot.
- Every image change recreates the agent containers at the next deploy; the web app starts them again within seconds. The agent code is no longer mounted from the repository.
- The deploy check waits for each running agent to keep its restart count and to write a health row younger than a minute.
- Push and self-check texts are in English, like the web app.
- The agent needs 75-136 MB of memory (anonymous, garbage collector cycles included; 77-136 MB idle) where the Python agent and its Node driver needed 120-161 MB, measured on the local stack on both accounts.
