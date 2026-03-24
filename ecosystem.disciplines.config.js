export const apps = [{
  name: 'clashd27-discipline-runner',
  script: 'lib/discipline-runner.js',
  env: {
    MIN_PUBLISH_SCORE: '0.80',
    DEEP_DIVE_THRESHOLD: '0.75',
    TICK_INTERVAL_MS: '600000',
    MAX_GAPS_PER_DISCIPLINE: '20'
  },
  cron_restart: '0 3 * * *',
  watch: false,
  autorestart: true,
  max_memory_restart: '600M'
}];

export default { apps };
