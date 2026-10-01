// pm2 for the local relay: npx pm2 start ecosystem.config.cjs, then npx pm2 save. Start at logon:
// scripts/relay-autostart.ps1 (Windows) or pm2 startup (Linux, desktop session). The browser window needs the desktop
// of the signed-in user.
//
// Fleet remote management (optional): set FLEET_VM (the hub VM's ssh alias) and FLEET_PORT (the VM loopback port this
// host's cmdapi is published on) in relay.env, and this file also starts cmdapi and the reverse tunnel that carries it.
// pm2 keeps both alive and brings them back at logon with the relay. See docs/design/2026-10-01-fleet-remote-management.md.
const fs = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, "relay.env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const apps = [
  {
    name: "teamsrelay",
    script: "dist/relay.cjs",
    cwd: __dirname,
    // after a crash: again at once, then waiting longer while it keeps crashing (up to 15 s), and giving up after
    // 50 crashes in a row within 10 s of their start: pm2 ls then shows it errored, the log says why
    exp_backoff_restart_delay: 1000,
    min_uptime: 10000,
    max_restarts: 50,
    // stop: the relay closes the browser itself, so that the profile is written out
    shutdown_with_message: true,
    kill_timeout: 15000,
    // the Node process only (the browser is apart): 75-140 MB for the agent of a slot
    max_memory_restart: "600M",
    time: true,
  },
];

// Only when the host is wired into the fleet: the command API and the reverse tunnel that publishes it on the VM.
if (process.env.FLEET_VM && process.env.FLEET_PORT) {
  const vm = process.env.FLEET_VM;
  const vmPort = process.env.FLEET_PORT;
  const cmdPort = process.env.CMDAPI_PORT || "8765";

  apps.push({
    name: "teamsrelay-cmdapi",
    script: "dist/cmdapi.cjs",
    cwd: __dirname,
    exp_backoff_restart_delay: 1000,
    min_uptime: 10000,
    max_restarts: 50,
    max_memory_restart: "200M",
    time: true,
  });

  apps.push({
    name: "teamsrelay-tunnel",
    // pm2 is the supervisor: if ssh drops, pm2 redials it. The VM alias (~/.ssh/config) carries its own keepalive;
    // ExitOnForwardFailure makes ssh exit (so pm2 redials) when the VM port is still held by a dropped tunnel.
    script: "ssh",
    args: ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-R", `127.0.0.1:${vmPort}:127.0.0.1:${cmdPort}`, vm],
    interpreter: "none",
    exp_backoff_restart_delay: 1000,
    min_uptime: 10000,
    max_restarts: 50,
    time: true,
  });
}

module.exports = { apps };
