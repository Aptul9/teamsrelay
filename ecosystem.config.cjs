// pm2: npx pm2 start ecosystem.config.cjs, then npx pm2 save. Start at logon: scripts/install-autostart.ps1
// (Windows) or pm2 startup (Linux, desktop session). The browser window needs the desktop of the signed-in user.
module.exports = {
  apps: [
    {
      name: "teamsrelay",
      script: "dist/relay.cjs",
      cwd: __dirname,
      // after a crash: again at once, then waiting longer while it keeps crashing
      exp_backoff_restart_delay: 1000,
      // stop: the relay closes the browser itself, so that the profile is written out
      shutdown_with_message: true,
      kill_timeout: 15000,
      // the Node process only (the browser is apart): 75-140 MB in teamsrelay
      max_memory_restart: "600M",
      time: true,
    },
  ],
};
