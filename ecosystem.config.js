require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  apps: [{
    name: 'clashd27-bot',
    script: 'bot.js',
    cwd: '/home/greenbanaanas/clashd27',
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      DISCORD_TOKEN: process.env.DISCORD_TOKEN
    }
  }]
};
