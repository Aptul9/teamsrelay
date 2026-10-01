// pm2 for the local relay: npx pm2 start ecosystem.config.cjs, then npx pm2 save. Start at logon:
// scripts/relay-autostart.ps1 (Windows) or pm2 startup (Linux, desktop session). The browser window needs the desktop
// of the signed-in user.
//
// Fleet remote management is opt-in and per component. Nothing below runs unless its flags are set in relay.env:
//   FLEET_VM           the hub VM's ssh alias (~/.ssh/config), shared by every tunnel. Empty = fleet off entirely.
//   FLEET_CMDAPI_PORT  turn on cmdapi + its reverse tunnel; this is the VM loopback port it is published on. Empty = off.
// Future slots (not wired yet): FLEET_SSH_PORT, FLEET_PROXY_PORT. See docs/design/2026-10-01-fleet-remote-management.md.
// Per-component control at runtime: npx pm2 stop|start teamsrelay-cmdapi (and -tunnel).

// relay.env next to this file (pm2 does not load it on its own); a missing file is fine, the process environment is
// then the only source
try {
  process.loadEnvFile(`${__dirname}/relay.env`);
} catch {
  // no relay.env: rely on the process environment
}

// The pm2 apps a host runs, decided from its environment. Pure, so ecosystem.config.cjs can be tested without pm2.
function fleetApps(env, dir) {
  const apps = [
    {
      name: "teamsrelay",
      script: "dist/relay.cjs",
      cwd: dir,
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

  // Command API + the reverse tunnel that publishes it on the VM's loopback. Both on, or both off, together.
  if (env.FLEET_VM && env.FLEET_CMDAPI_PORT) {
    const cmdPort = env.CMDAPI_PORT || "8765";
    apps.push({
      name: "teamsrelay-cmdapi",
      script: "dist/cmdapi.cjs",
      cwd: dir,
      exp_backoff_restart_delay: 1000,
      min_uptime: 10000,
      max_restarts: 50,
      max_memory_restart: "200M",
      time: true,
    });
    apps.push({
      name: "teamsrelay-cmdapi-tunnel",
      // pm2 is the supervisor: if ssh drops, pm2 redials it. The VM alias (~/.ssh/config) carries its own keepalive;
      // ExitOnForwardFailure makes ssh exit (so pm2 redials) when the VM port is still held by a dropped tunnel.
      script: "ssh",
      args: ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", "-R", `127.0.0.1:${env.FLEET_CMDAPI_PORT}:127.0.0.1:${cmdPort}`, env.FLEET_VM],
      interpreter: "none",
      exp_backoff_restart_delay: 1000,
      min_uptime: 10000,
      max_restarts: 50,
      time: true,
    });
  }

  return apps;
}

module.exports = { apps: fleetApps(process.env, __dirname), fleetApps };
