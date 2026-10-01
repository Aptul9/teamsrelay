// pm2 for the local relay: npx pm2 start ecosystem.config.cjs, then npx pm2 save. Start at logon:
// scripts/relay-autostart.ps1 (Windows) or pm2 startup (Linux, desktop session). The browser window needs the desktop
// of the signed-in user.
//
// Fleet remote management runs as its own process, separate from the relay: the fleet agent (dist/fleet-agent.cjs),
// which runs the components enabled in fleet.config.json (cmdapi, ssh) and the reverse tunnels that publish them on the
// hub VM. It is opt-in: set FLEET_AGENT=on in relay.env to have pm2 start it here, or run it standalone with
// `npm run fleet:agent`. Nothing fleet runs otherwise. See docs/design/2026-10-01-fleet-remote-management.md.

// relay.env next to this file (pm2 does not load it on its own); a missing file is fine, the process environment is
// then the only source
try {
  process.loadEnvFile(`${__dirname}/relay.env`);
} catch {
  // no relay.env: rely on the process environment
}

const restart = { exp_backoff_restart_delay: 1000, min_uptime: 10000, max_restarts: 50, time: true };

// The pm2 apps a host runs, decided from its environment. Pure, so ecosystem.config.cjs can be tested without pm2.
function fleetApps(env, dir) {
  const apps = [
    {
      name: "teamsrelay",
      script: "dist/relay.cjs",
      cwd: dir,
      ...restart,
      // stop: the relay closes the browser itself, so that the profile is written out
      shutdown_with_message: true,
      kill_timeout: 15000,
      // the Node process only (the browser is apart): 75-140 MB for the agent of a slot
      max_memory_restart: "600M",
    },
  ];

  // The fleet agent: a separate process, off unless FLEET_AGENT is set. Which components it runs (cmdapi, ssh) and
  // their settings live in fleet.config.json, not here.
  if (env.FLEET_AGENT) {
    apps.push({
      name: "teamsrelay-fleet",
      script: "dist/fleet-agent.cjs",
      cwd: dir,
      ...restart,
      kill_timeout: 8000,
      max_memory_restart: "250M",
    });
  }

  return apps;
}

module.exports = { apps: fleetApps(process.env, __dirname), fleetApps };
