const fs = require('fs');
const path = require('path');
const { getAllGaps } = require('./gap-index');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GAPS_INDEX_FILE = process.env.GAPS_INDEX_FILE || path.join(DATA_DIR, 'gaps-index.json');

const cache = {
  mtimeMs: null,
  leaderboard: []
};

function shouldUseCache() {
  try {
    if (!fs.existsSync(GAPS_INDEX_FILE)) return cache.mtimeMs === 0;
    const stat = fs.statSync(GAPS_INDEX_FILE);
    return cache.mtimeMs !== null && stat.mtimeMs === cache.mtimeMs;
  } catch (e) {
    return false;
  }
}

function updateCacheMeta() {
  try {
    if (!fs.existsSync(GAPS_INDEX_FILE)) {
      cache.mtimeMs = 0;
      return;
    }
    const stat = fs.statSync(GAPS_INDEX_FILE);
    cache.mtimeMs = stat.mtimeMs;
  } catch (e) {
    cache.mtimeMs = null;
  }
}

function computeLeaderboard() {
  if (shouldUseCache()) return cache.leaderboard;

  const gaps = getAllGaps();
  const agg = {};

  for (const gap of gaps) {
    const repos = Array.isArray(gap.repos) ? gap.repos : [];
    for (const repo of repos) {
      const key = (repo.repo || '').toLowerCase();
      if (!key) continue;
      if (!agg[key]) {
        agg[key] = {
          repo: key,
          gaps_found: 0,
          open: 0,
          responded: 0,
          resolved: 0,
          totalScore: 0,
          maintainer_x_handle: null,
          last_gap_date: null
        };
      }
      const entry = agg[key];
      entry.gaps_found += 1;
      entry.totalScore += gap.score || 0;
      if (gap.status === 'resolved') entry.resolved += 1;
      else if (gap.status === 'responded') entry.responded += 1;
      else entry.open += 1;

      if (repo.maintainer_x_handle) {
        entry.maintainer_x_handle = repo.maintainer_x_handle;
      }
      if (!entry.last_gap_date || (gap.createdAt && gap.createdAt > entry.last_gap_date)) {
        entry.last_gap_date = gap.createdAt || entry.last_gap_date;
      }
    }
  }

  const leaderboard = Object.values(agg)
    .sort((a, b) => {
      if (b.resolved !== a.resolved) return b.resolved - a.resolved;
      if (b.responded !== a.responded) return b.responded - a.responded;
      if (b.open !== a.open) return b.open - a.open;
      return b.gaps_found - a.gaps_found;
    })
    .slice(0, 50);

  cache.leaderboard = leaderboard;
  updateCacheMeta();
  return leaderboard;
}

module.exports = {
  computeLeaderboard
};
