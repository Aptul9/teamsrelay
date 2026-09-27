// pm2 for the local relay: npx pm2 start ecosystem.config.cjs, then npx pm2 save. Start at logon:
// scripts/relay-autostart.ps1 (Windows) or pm2 startup (Linux, desktop session). The browser window needs the desktop
// of the signed-in user.
module.exports = {
  apps: [
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
  ],
};
