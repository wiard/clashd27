module.exports = {
  apps: [{
    name: 'clashd-27',
    script: 'bot.js',
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
