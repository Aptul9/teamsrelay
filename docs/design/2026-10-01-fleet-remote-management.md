# Fleet remote management

Date: 2026-10-01. A command channel and an SSH shell on each relay host, reachable through a hub VM, so a relay can be updated, inspected and logged into remotely without an inbound connection to the host and without admin-installed software on it. Builds on the [local relay](2026-09-26-local-relay.md) and [an account on another computer](2026-09-27-relay-joins-server.md). Reference prior art: the `python-proxy` bundle, whose single control process over a reverse SSH tunnel this design reuses in Node.

## Problem

A relay on another computer runs `node dist/relay.cjs` under pm2 in the interactive desktop session of its user, started at logon by the `TeamsRelay` scheduled task (Windows) or `pm2 startup` (Linux). The hosts are workstations and VDIs behind NAT: nothing on them listens for an inbound connection, and the relay only ever connects out.

Updating one to the current `main` means, on that host: `git pull`, `npm ci --ignore-scripts`, `npm run build:relay`, restart. Today that needs an RDP or physical session on each host. There is no remote channel, and the hosts are often locked corporate VDIs where admin, and therefore the OS OpenSSH Server, is unavailable.

## Approach

Each host runs **two processes**, separate on purpose: the relay, and a **fleet agent**. The agent reads `fleet.config.json`, starts the components enabled there (a command API, an SSH server), and holds open one reverse SSH tunnel per component that publishes it on the hub VM's loopback. pm2 runs both and brings them back at logon; the relay is untouched by anything the agent does. A control machine (a laptop, or the VM) runs a `fleet` CLI that reaches each host through the VM.

```
control machine                         hub VM (oracle-vm)                 relay host (VDI)
fleet CLI ───ssh oracle-vm──▶ sshd ──loopback:CMDAPI──▶ reverse tunnel ──▶ cmdapi 127.0.0.1    (fleet agent)
you (ssh) ───ssh oracle-vm -p─▶      ──loopback:SSH────▶ reverse tunnel ──▶ ssh2 server 127.0.0.1
                                      (tunnels held open by the agent)      relay (own process, untouched)
```

The hub VM is the same box as the TeamsRelay production server (`oracle-vm`), so the tunnels land on the server the relays already talk to. Nothing is installed on the VM: the reverse tunnels need only its sshd and the host's SSH key.

### One agent process, not a pm2 app per piece

`python-proxy` kept its proxy, SSH exposure and command API under one control process over a reverse tunnel. This mirrors that: the agent is one process that runs cmdapi and the ssh2 server in-process and owns (spawns, redials) the ssh tunnels, so a host runs the relay plus exactly one fleet process, toggled with two npm commands (`npm run relay`, `npm run fleet:agent`). pm2 supervises the agent; the agent supervises its tunnels.

### SSH: embedded by default, OS server optional

An inbound shell needs an SSH server, and both options are offered so the choice is the host's, not the design's. The default is `library`: a pure-Node SSH server, **`ssh2`**, embedded in the agent, which needs no admin, no OS feature and no firewall change (a locked VDI can use it). `ssh2` is MIT, Node >= 10.16, latest 1.17.0 (2025-08-20, maintained); its runtime deps (`asn1`, `bcrypt-pbkdf`) are pure JavaScript and its only native pieces (`cpu-features`, `nan`) are optional and skipped under `npm ci --ignore-scripts`, so it installs with no compiler. The trade is that the project owns the server surface (host key, public-key auth, the shell it exposes), and there is no pty. Where the host already runs the OS OpenSSH Server (or admin can install it), `system` mode tunnels straight to it for a full OS shell with pty and sftp. Either way the reverse tunnel uses the OS OpenSSH **client**, which ships with Windows 10/11 and macOS and needs no admin.

## Components

All in `app/`, bundled with esbuild like the relay.

- Fleet agent, `src/fleet/agent/` → `dist/fleet-agent.cjs` (`npm run build:fleet-agent`, run with `npm run fleet:agent`):
  - `config.ts` reads and validates `fleet.config.json` (one hub VM; `cmdapi` and `ssh` each enabled independently; an enabled component must carry its VM port and its secret).
  - `tunnel.ts` builds and supervises `ssh -N -R 127.0.0.1:<vmPort>:127.0.0.1:<localPort> <vm>`, redialing with backoff.
  - `main.ts` starts the enabled components and their tunnels, idles if none, and stops cleanly on a signal.
- Command API, `src/fleet/cmdapi/` (used in-process by the agent; also buildable standalone as `dist/cmdapi.cjs`):
  - `runner.ts` runs one command: a string through a shell (PowerShell on Windows, `/bin/sh` on POSIX) or `args` with no shell; a deadline kills the whole process tree; output is capped; partial output is kept.
  - `config.ts` refuses a non-loopback bind with no token.
  - `server.ts` serves `GET /health` (no auth) and `GET|POST /command` (bearer token). A non-zero exit stays HTTP 200 with the exit code; 4xx is a request declined before anything ran.
- SSH, two modes chosen by `ssh.mode` in `fleet.config.json`:
  - `library` (default, no admin): the embedded `ssh2` server, `src/fleet/ssh/server.ts`. Public-key auth only (keys from the config), host key generated and persisted on first run. An `exec` request runs the command through the cmdapi runner; a `shell` request spawns an interactive shell piped to the channel (no pseudo-tty: a real one needs a native module, so line editing and full-screen programs are limited; `exec`, and so remote commands and updates, are unaffected). An SFTP subsystem (`src/fleet/ssh/sftp.ts`) backs file transfer (`sftp`, `scp -O`), mapped to the filesystem as the relay's user with no jail, the same trust as the shell.
  - `system`: no embedded server; the agent tunnels straight to the host's own OpenSSH Server on `localPort` (default 22), giving a real OS login shell with full pty and sftp. It needs sshd installed and running on the host (admin to install on Windows), and the host's sshd owns authentication, so no keys live in the fleet config.
- Control CLI, `src/fleet/cli/` → `dist/fleet.cjs` (`npm run fleet`): `exec <host|all> <command...>`, `update <host|all>`, `status <host|all>`, over `fleet.hosts.json`.

## Configuration

- `relay.env` (per host): `FLEET_AGENT` set to any value makes pm2 start the agent via `ecosystem.config.cjs`; empty means no agent. It carries nothing else about the fleet.
- `fleet.config.json` (per host, untracked; holds the cmdapi token and the ssh authorized keys): the hub VM and the per-component settings. Example in `fleet.config.example.json`. The ssh host key is written under `state/` (already untracked).
- `fleet.hosts.json` (control machine, untracked; holds the tokens): the hosts the CLI reaches, each with its `vm`, cmdapi `port`, `token` and `appDir`.

The pm2 app set is a pure `fleetApps(env, dir)` exported from `ecosystem.config.cjs`, unit-tested without pm2.

## Security

- cmdapi and the ssh2 server bind loopback; each tunnel publishes only on the VM's loopback (`-R 127.0.0.1:...`), never the VM's public IP.
- Access is gated by the SSH key to the VM. cmdapi additionally checks a bearer token (timing-safe); the ssh2 server accepts only the configured public keys and presents its own persisted host key.
- Everything runs as the relay's own interactive user, unelevated, and needs no admin to install or run.
- Secrets live in untracked files (`relay.env`, `fleet.config.json`, `fleet.hosts.json`) and the ssh host key under `state/`; none are committed.
- Known tradeoffs, both accepted: the control CLI puts the cmdapi token on the remote `curl` line, so it shows briefly in the VM's process list (the VM is single-tenant and owned by the operator, and SSH-to-the-VM is the real gate); and the ssh2 shell has no pseudo-tty.

## Out of scope

- An HTTP proxy component (python-proxy's split routing). Reserved for the same agent + tunnel pattern, not built.
- A real pseudo-tty for the ssh2 shell (needs a native module, which the no-admin constraint rules out).
- Remote Teams re-sign-in: it needs the relay's desktop browser window; `fleet status` flags a signed-out relay and the fix is an RDP session.

## Verification

- Unit: runner (exit codes, output cap, timeout tree-kill, shell wrapping), cmdapi config (loopback/token refusal), cmdapi server (health, the three input forms, token 401, exit passthrough), agent config (per-component enable and its required fields), tunnel invocation, inventory parsing, the ssh+curl invocation, the update sequence, the pm2 flag gating (`fleetApps`), and the ssh2 server driven by a real in-process ssh2 client (authorized key runs a command, unauthorized key refused).
- End to end: the cmdapi bundle and the fleet-agent bundle each built and run as a process and driven over HTTP (health, token enforced, a command run and its output returned). This proves the bundles run and the request path works, not each piece in isolation.
- Before a real rollout, the full path is proven on one host (agent under pm2, the tunnel bound on the VM loopback, `fleet exec`/`update` working and the relay coming back), then hosts are updated one at a time.
