export const apps = [{
  name: 'clashd27-cancer-researcher',
  script: 'lib/tick-engine.js',
  env: {
    RESEARCH_DOMAIN: 'cancer-research',
    CLASHD27_ENABLE_LEGACY_RESEARCH: 'true',
    TICK_INTERVAL_MS: '300000',
    MAX_FINDINGS_PER_DAY: '50',
    MIN_PUBLISH_SCORE: '0.80',
    MIN_NOVELTY_SCORE: '0.70',
    DEEP_DIVE_THRESHOLD: '0.75'
  },
  cron_restart: '0 6 * * *',
  watch: false,
  autorestart: true,
  max_memory_restart: '500M'
}];

export default { apps };
