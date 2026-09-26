# Every Teams account in one container

Date: 2026-09-26. Supersedes the container layout of [2026-09-26-multi-user-nextjs.md](2026-09-26-multi-user-nextjs.md) (one browser, agent and network per slot) and the "one image" point of [2026-09-26-agent-typescript.md](2026-09-26-agent-typescript.md).

## Context

The stack declared 15 containers for 4 accounts: `webapp`, `caddy`, `dockerproxy`, and per slot `chromium-N`, `agent-N` and `wipe-N`, all created in advance. The web app reaches Docker only through a socket proxy that filters method and path, so it can start and stop existing containers but never create one: a create request carries its own binds and privileges. Each slot container was also the boundary between the users of the server.

Every Teams account of this server belongs to one person. The boundary between accounts is no longer needed, and the containers created in advance were the cost of it.

## Options

| Option | Containers (2 accounts) | Notes |
|---|---|---|
| One wipe container, only `SLOT_COUNT` slots created | 8 | Containers still created in advance, socket proxy stays. |
| Privileged manager creating containers on demand | 7 | Own code holding a root-equivalent socket; slot containers leave Compose. |
| One container, one browser and one agent per account, started by a supervisor | 3 | No Docker access from the web app; accounts share one desktop, one loopback, one filesystem. |

## Decision

One container, `browsers`, runs every account: a supervisor starts per account a Chromium with its own profile and DevTools port, and the agent of the account. The web app asks the supervisor over a unix socket to start, stop, wipe and show an account. One remote desktop shows every browser window.

## Consequences

- 3 containers whatever the number of accounts; `SLOT_COUNT` only caps them. No socket proxy, no Docker socket in any container.
- The profiles keep their path, `config/N`: the sessions signed in before the change stay signed in.
- One desktop stream and one set of desktop services for every account: about 190 MB less per extra account. Browsers and agents use what they used before.
- Hardening that the shared container needs: Chromium runs with its sandbox (the image default was `--no-sandbox`), the browser user has no sudo, DevTools refuses web origins, and `data/`, `vapid/` and the control socket sit under `/root`, out of reach of the browser user.
- A browser that escapes its sandbox still reaches every account's profile and DevTools: accepted, every account has the same owner.
- A restart of the container restarts every account.
