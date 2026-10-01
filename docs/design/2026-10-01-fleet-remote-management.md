# Fleet remote management

Date: 2026-10-01. A command channel on each relay host, reachable through a hub VM, so a relay can be updated and inspected remotely without an inbound connection to the host and without a shell login on it. Builds on the [local relay](2026-09-26-local-relay.md) and [an account on another computer](2026-09-27-relay-joins-server.md). Reference prior art: the `python-proxy` bundle, whose SSH reverse-tunnel and HTTP command runner this design reuses in Node.

## Problem

A relay on another computer runs `node dist/relay.cjs` under pm2 in the interactive desktop session of its user, started at logon by the `TeamsRelay` scheduled task (Windows) or `pm2 startup` (Linux). The hosts are workstations and VDIs behind NAT: nothing on them listens for an inbound connection, and the relay only ever connects out to the server it joined.

Updating one to the current `main` means, on that host: `git pull`, `npm ci --ignore-scripts`, `npm run build:relay`, restart the relay. Today that requires an RDP or physical session on each host. There is no remote channel, so a fleet of hosts (the Zurich VDI, office PCs) falls behind the server release until someone connects to each one.

## Approach

Each host runs a command API (`cmdapi`) bound to its own loopback, and holds open a reverse SSH tunnel to a hub VM that publishes that cmdapi on the VM's loopback at a per-host port. pm2 runs both next to the relay and brings them back at logon, so no bespoke supervisor is needed and the autostart already in place carries them. A control machine (a laptop, or the VM itself) runs a `fleet` CLI that reaches each host by SSHing the VM and curling the published cmdapi: it runs commands, performs the update sequence, and reports status.

```
control machine                         hub VM (oracle-vm)                relay host (VDI)
fleet CLI ───ssh oracle-vm──▶ sshd ──loopback:PORT──▶ reverse tunnel ──▶ cmdapi 127.0.0.1:8765
  exec / update / status                 (held open by the host)           │ runs the command
                                                                           ▼
                                                            git pull, npm ci, build:relay, pm2 restart
```

The hub VM is the same box as the TeamsRelay production server (`oracle-vm`), so the tunnels land on the server the relays already talk to. Nothing is installed on the VM: the reverse tunnel needs only its sshd and the host's SSH key.

### Why pm2, not a ported supervisor

`python-proxy` keeps its tunnel alive with a POSIX-only supervisor (process groups, `killpg`). The relay hosts are Windows VDIs, where that does not run, and pm2 is already present and already resurrects the relay at logon. So cmdapi and the tunnel are pm2 apps: pm2 redials a dropped tunnel and restarts a dead cmdapi, cross-platform, with no new autostart mechanism competing with the logon task.

### Why cmdapi is separate from the relay API

The relay serves a small API on loopback for the phone (`src/local/server.ts`), reachable from the phone over HTTPS through Tailscale Serve or the LAN. cmdapi runs arbitrary commands: it is remote code execution by design, a different trust boundary. It is a separate process on a separate port, reached only through the SSH tunnel, never exposed to the phone and never mounted on the relay's API.

## Components

All in `app/`, bundled with esbuild like the relay.

- `src/fleet/cmdapi/` runs on each host, bundled to `dist/cmdapi.cjs` (`npm run build:cmdapi`):
  - `config.ts` reads `CMDAPI_*` from the environment. Refuses to start off loopback with no token.
  - `runner.ts` runs one command: a string command through a shell (PowerShell on Windows, `/bin/sh` on POSIX), or `args` directly with no shell. A deadline kills the whole process tree (`taskkill /T` on Windows, a process-group kill on POSIX); output is capped per stream; partial output from a killed command is kept.
  - `server.ts` serves `GET /health` (no auth) and `GET|POST /command` (bearer token when set). A non-zero exit stays HTTP 200 with the exit code in the body; 4xx is a request declined before anything ran.
  - `main.ts` loads `relay.env`, prints the resolved posture, starts the server.
- The reverse tunnel is a pm2 app in `ecosystem.config.cjs`: `ssh -N -R 127.0.0.1:<FLEET_CMDAPI_PORT>:127.0.0.1:<CMDAPI_PORT> <FLEET_VM>`, added only when `FLEET_VM` and `FLEET_CMDAPI_PORT` are set. The app set is decided by `fleetApps(env, dir)`, a pure function exported from the config file so it is unit-tested without pm2.
- `src/fleet/cli/` runs on the control machine, bundled to `dist/fleet.cjs` (`npm run build:fleet`):
  - `inventory.ts` reads the hosts from `fleet.hosts.json` (untracked; holds the tokens).
  - `client.ts` builds the `ssh <vm> "curl ... /command"` invocation and parses the result.
  - `update.ts` holds the update sequence.
  - `main.ts` is the CLI: `exec <host|all> <command...>`, `update <host|all>`, `status <host|all>`.

## Configuration

Fleet management is opt-in and per component: nothing runs unless its flags are set. Per host, in `relay.env` (see `relay.env.example`): `FLEET_VM` (the hub VM's ssh alias, shared by every tunnel) and, to turn cmdapi on, `FLEET_CMDAPI_PORT` (unique per host) plus the `CMDAPI_*` knobs (`CMDAPI_TOKEN`, `CMDAPI_TIMEOUT=600`, `CMDAPI_CWD` set to `app/` so updates land there). `FLEET_SSH_PORT` and `FLEET_PROXY_PORT` are reserved for later components and inert today. At runtime a component is toggled with `npx pm2 stop|start teamsrelay-cmdapi` (and `-tunnel`) without editing `relay.env`.

On the control machine, `fleet.hosts.json` (from `fleet.hosts.example.json`) maps each host name to its `vm`, `port`, `token` and `appDir`.

## Security

- cmdapi binds loopback; a non-loopback bind with an empty token refuses to start.
- The tunnel publishes cmdapi on the VM's loopback only (`-R 127.0.0.1:...`), never on the VM's public IP.
- Access is gated by the SSH key to the VM; the bearer token is defence in depth, checked with a timing-safe compare.
- A command runs as the relay's own interactive user, unelevated: it can restart that user's pm2, nothing more. Deadline and output cap bound every command.
- Tokens live in untracked files (`relay.env`, `fleet.hosts.json`), never committed.
- Known tradeoff: the `fleet` CLI puts the token on the remote `curl` command line, so it shows in the VM's process list for the moment the command runs. The VM is single-tenant and owned by the operator; SSH-to-the-VM is the real gate. Accepted, as in `python-proxy`.

## Out of scope

- An interactive SSH shell or SOCKS into a host, for now. cmdapi covers remote update and inspection without it. When it is added it will be a flagged component (`FLEET_SSH_PORT`) reached through its own reverse tunnel. Admin-installed software is ruled out, so the OS OpenSSH Server route (which needs `Add-WindowsCapability` and the sshd service, both admin) is rejected; the route is a pure-Node `ssh2` server embedded in the host process. `ssh2` is MIT, Node >= 10.16, latest 1.17.0 (2025-08-20, actively maintained); its runtime deps (`asn1`, `bcrypt-pbkdf`) are pure JavaScript and its only native pieces (`cpu-features`, `nan`) are optional and skipped under the project's `npm ci --ignore-scripts`, so it installs with no compiler and no admin. The cost is owning the SSH server surface (host key, public-key auth, pty/exec), which is why it is deferred rather than bundled in now.
- Remote Teams re-sign-in. The sign-in happens in the relay's desktop browser window; `fleet status` flags a signed-out relay, and the fix is still an RDP session.
- Central port allocation and host discovery. With a handful of hosts the inventory file and a hand-kept port map suffice.

## Verification

- Unit: runner (exit codes, output cap, timeout tree-kill, shell wrapping), config (loopback/token refusal, shell and cwd resolution), server (health, the three input forms, token 401, exit passthrough), inventory parsing, the ssh+curl invocation, the update sequence, and the per-component flag gating (`fleetApps`).
- End to end: the cmdapi bundle built and run as a process, driven over HTTP (health, token enforced, a command run and its output returned). This proves the bundle runs and the whole request path works, not each piece in isolation.
- Before a real rollout, the full path is proven on one host (cmdapi and tunnel under pm2, the tunnel bound on the VM loopback, `fleet exec` returning output, `fleet update` running the sequence and the relay coming back online), then hosts are updated one at a time.
