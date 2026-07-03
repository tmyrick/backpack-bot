// pm2 process config for the backpack-bot server.
// Keeps the sniper alive across crashes/reboots so armed job timers aren't lost.
//
// Usage (from repo root):
//   npm run build            # compile server -> packages/server/dist
//   npx pm2 start ecosystem.config.cjs
//   npx pm2 logs backpack-bot
//   npx pm2 save             # persist process list
//   npx pm2 startup          # print the boot command to run once (needs admin/sudo)
//
// Run the two lines above (save + startup) once so pm2 relaunches the bot on reboot.

const path = require("path");

module.exports = {
  apps: [
    {
      name: "backpack-bot",
      cwd: __dirname,
      script: path.join("packages", "server", "dist", "index.js"),
      // node >=20.6 loads .env directly; keeps secrets out of the pm2 process list.
      node_args: "--env-file=.env",

      // Supervision: auto-restart on crash, with backoff so a crash loop doesn't hammer recreation.gov.
      autorestart: true,
      restart_delay: 2000,
      exp_backoff_restart_delay: 5000,
      max_restarts: 20,

      // Never file-watch in production; an editor save must not kill an in-flight snipe.
      watch: false,

      // Give graceful shutdown time to close Playwright browsers / end cart keep-alive.
      kill_timeout: 20000,

      // Intentionally no max_memory_restart: a memory-based restart could kill the
      // process mid-booking and drop a cart. Add one only if you hit real leaks.

      time: true, // timestamp log lines
      env: {
        NODE_ENV: "production",
        // Resolved relative to cwd (repo root) -> ./data, matching the dev data dir.
        DATA_DIR: "data",
        CLIENT_DIST_PATH: path.join("packages", "client", "dist"),
        // PORT: "3001",
        // HEADLESS: "true",
      },
    },
  ],
};
