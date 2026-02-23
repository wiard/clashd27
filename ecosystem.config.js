// CLASHD-27 PM2 config
// Secrets are loaded by the app via dotenv from /home/greenbanaanas/.secrets/clashd27.env
// Do NOT inject keys here — it causes stale-env bugs on pm2 restart.

module.exports = {
  apps: [{
    name: 'clashd27-bot',
    script: 'bot.js',
    cwd: '/home/greenbanaanas/clashd27',
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
