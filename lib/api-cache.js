/**
 * CLASHD-27 — Shared API Cache
 * File-backed JSON cache with TTL for external API responses.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

class ApiCache {
  /**
   * @param {string} filepath - cache filename (stored in data/)
   * @param {number} ttlHours - time-to-live in hours (default 24)
   */
  constructor(filepath, ttlHours = 24) {
    this.filepath = path.join(DATA_DIR, filepath);
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.cache = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filepath)) {
        this.cache = JSON.parse(fs.readFileSync(this.filepath, 'utf8'));
      }
    } catch (e) {
      this.cache = null;
    }
    if (!this.cache || typeof this.cache !== 'object') {
      this.cache = { entries: {}, created: Date.now() };
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.filepath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
      fs.renameSync(tmp, this.filepath);
    } catch (e) {
      // Non-fatal: cache write failure shouldn't break callers
    }
  }

  /**
   * Get a cached value by key. Returns null if missing or expired.
   */
  get(key) {
    const entry = this.cache.entries[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      delete this.cache.entries[key];
      return null;
    }
    return entry.value;
  }

  /**
   * Set a cache entry.
   */
  set(key, value) {
    this.cache.entries[key] = { value, ts: Date.now() };
    this._save();
  }

  /**
   * Remove expired entries and persist.
   */
  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of Object.entries(this.cache.entries)) {
      if (now - entry.ts > this.ttlMs) {
        delete this.cache.entries[key];
        removed++;
      }
    }
    if (removed > 0) this._save();
    return removed;
  }
}

module.exports = { ApiCache };
