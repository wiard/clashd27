/**
 * CLASHD-27 — Shared Rate Limiter
 * Named rate-limiter instances for external API calls.
 */

class RateLimiter {
  /**
   * @param {string} name - identifier for logging
   * @param {number} maxPerSecond - max requests per second
   */
  constructor(name, maxPerSecond) {
    this.name = name;
    this.maxPerSecond = maxPerSecond;
    this.minIntervalMs = Math.ceil(1000 / maxPerSecond);
    this.lastCallTs = 0;
  }

  /**
   * Wait until it's safe to make the next request.
   * Returns immediately if enough time has passed.
   */
  async throttle() {
    const now = Date.now();
    const elapsed = now - this.lastCallTs;
    if (elapsed < this.minIntervalMs) {
      const wait = this.minIntervalMs - elapsed;
      await new Promise(r => setTimeout(r, wait));
    }
    this.lastCallTs = Date.now();
  }
}

// Named instances for each external API
const limiters = {
  pubmed: new RateLimiter('pubmed', 3),
  nih: new RateLimiter('nih', 2),
  clinicaltrials: new RateLimiter('clinicaltrials', 5),
  europepmc: new RateLimiter('europepmc', 3),
};

module.exports = { RateLimiter, limiters };
