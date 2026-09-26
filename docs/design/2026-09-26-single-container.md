# One container for every Teams account: implementation plan

Decision: [2026-09-26-single-container.md](../decisions/2026-09-26-single-container.md).

**Goal:** the browser and the agent of every Teams account run in one container, `browsers`, started and stopped by the web app without Docker: no containers created per account in advance, no wipe containers, no socket proxy.

**Architecture:** image `teamsrelay-browsers` = pinned `lscr.io/linuxserver/chromium` + Node 24 + `agent.cjs` + `supervisor.cjs`. The supervisor, an s6 service running as root, starts per account one Chromium (user `abc`, profile `/profiles/N`, DevTools on `127.0.0.1:9221+N`) and one agent, restarts them when they exit, empties a profile on request and brings the window of an account to the front of the shared desktop. The web app calls it over HTTP on a unix socket in the volume `control`. Caddy sends `/desktop/` to `browsers:3000` after `/api/authcheck`.

**Stack:** Node 24, TypeScript 6, zod 4, esbuild 0.28, Vitest 5; linuxserver/chromium (Chromium 153 on Debian 13, labwc on Wayland, Selkies); `wlrctl` 0.2.2 from Debian.

## Constraints

- A profile keeps its host path, `config/N`, and the layout of the old `chromium-N` container: `HOME` is the profile directory, the Chromium profile is `$HOME/.config/chromium`. Signed-in sessions survive the change.
- `data/`, `vapid/` and the control socket are mounted under `/root` (mode 700). Chromium runs as `abc`, removed from `sudo`, so it cannot read them. Agents and supervisor run as root.
- Chromium runs with its sandbox (no `--no-sandbox`) and without `--remote-allow-origins`.
- The agent, its environment variables and the `data/N/messages.db` contract do not change.
- The web app flows (add, remove, stop, start, keep-alive under one lock) do not change; only the client behind `slotUp`, `slotDown` and `wipeSlot` does.
- One desktop for every account: all accounts belong to one person.

## Spike (2026-09-26, throwaway container, removed)

Two Chromium 153 as `abc` on one labwc desktop, started by a root Node process:

- Sandbox works without `--no-sandbox` under `seccomp:unconfined`: renderers in seccomp filter mode, own user and PID namespaces.
- A covered window is not throttled with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`: 100 timer ticks and 600 animation frames per 10 s in both windows.
- `--class=X` sets the Wayland app id; `wlrctl toplevel focus app_id:X` moves the focus (checked with `wlrctl toplevel find app_id:X state:focused`).
- Playwright `connectOverCDP` works without `--remote-allow-origins`; a WebSocket with a web origin gets 403.
- `gpasswd -d abc sudo` in the image survives the container init: `sudo -n` asks for a password.

## Tasks

1. **Supervised process** (`src/supervisor/process.ts`): start, restart with backoff (1 s doubling to 60 s, reset after 5 min up), stop with SIGTERM then SIGKILL after a grace, whole process group. Tests with Node child processes as fake browser and agent.
2. **Accounts** (`src/supervisor/accounts.ts`): Chromium and agent command lines and environments, profile directory owned by `PUID:PGID`, stale `Singleton*` files removed, wipe (entries of `/profiles/N` deleted, emptiness checked, refused while running), show (`wlrctl`), status. One queue per account. Tests on temporary directories.
3. **Control server** (`src/supervisor/server.ts`, `config.ts`, `main.ts`): `POST /accounts/N/start|stop|wipe|show`, `GET /accounts`, socket mode 600; `--check` and `status` subcommands; waits for the Wayland socket; stops every account on SIGTERM. Tests over a socket (named pipe on Windows).
4. **Web app**: `lib/control.ts` replaces `lib/docker.ts`; `lib/slots.ts`, the account routes and `server/boot.ts` use it; `/api/desktop/[slot]` shows the window and redirects to `/desktop/`; `/api/authcheck` lets through users with an account; `DESKTOP_URL` default `/api/desktop/{n}`. Tests updated.
5. **Image**: `app/Dockerfile` targets `web` and `browsers`; s6 service `svc-teamsrelay` after `svc-de`; `/defaults/autostart_wayland` without browser; `wlrctl`; `node agent.cjs --check` and `node supervisor.cjs --check` in the image build.
6. **Stack**: `docker-compose.yml` (`browsers`, `webapp`, `caddy`; networks `default` and `desktop`; volume `control`), `compose.local.yml`, `caddy/Caddyfile`, `.env.example`, `deploy/remote-deploy.sh` (no profiles, `up -d --remove-orphans`, supervisor status instead of Docker restart counts), CI, Dependabot.
7. **Docs**: README, architecture, security, operations, setup, configuration, limitations.
8. **Local switch** on the running stack, slot 2 only (slot 1 stays stopped by its owner), rollback image kept; pull request into `main`, not merged (a merge deploys).

## Checklist

- [ ] Lint, type check, tests and build of `app/`; `node dist/agent.cjs --check`, `node dist/supervisor.cjs --check`.
- [ ] Both images build; the checks pass inside `teamsrelay-browsers`.
- [ ] Compose files and Caddyfile validate; `bash -n deploy/remote-deploy.sh`.
- [ ] Local stack: 3 containers; slot 2 green without a new sign-in; chat list and conversation update; a message to the self chat is sent; stop and start from the app; slot 1 stays stopped.
- [ ] Desktop: `/desktop/` opens for the owner, 302 to the login without a session; `/api/desktop/2` brings the window of slot 2 to the front.
- [ ] Hardening live: renderers of the running browser in seccomp filter mode; `abc` cannot list `/root/data`, cannot open the control socket, has no sudo.
- [ ] Wipe of an account without a session (slot 4, no browser started): entries deleted, emptiness checked; refused while running.
- [ ] CI green on the pull request.
