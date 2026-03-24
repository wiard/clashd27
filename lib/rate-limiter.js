'use strict';

class TokenBucket {
  constructor({ ratePerSecond, burst }) {
    this.capacity = Math.max(1, Number(burst) || 1);
    this.tokens = this.capacity;
    this.refillRate = Math.max(0.1, Number(ratePerSecond) || 1);
    this.lastRefillAt = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - this.lastRefillAt) / 1000);
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedSeconds * this.refillRate));
    this.lastRefillAt = now;
  }

  async take() {
    while (true) {
      this._refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(50, Math.ceil((deficit / this.refillRate) * 1000));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const buckets = {
  'semantic-scholar': new TokenBucket({ ratePerSecond: 1, burst: 5 }),
  'openalex': new TokenBucket({ ratePerSecond: 10, burst: 10 }),
  'pubmed': new TokenBucket({ ratePerSecond: 3, burst: 3 })
};

async function schedule(apiName, fn) {
  const bucket = buckets[apiName];
  if (!bucket) {
    return fn();
  }
  await bucket.take();
  return fn();
}

module.exports = {
  schedule
};
