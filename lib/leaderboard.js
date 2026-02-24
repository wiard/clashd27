const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GAPS_INDEX_FILE = process.env.GAPS_INDEX_FILE || path.join(DATA_DIR, 'gaps-index.json');

const cache = {
  mtimeMs: null,
  leaderboard: []
};

function readGapsIndex() {
  try {
    if (fs.existsSync(GAPS_INDEX_FILE)) {
      const raw = fs.readFileSync(GAPS_INDEX_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    try {
      if (fs.existsSync(GAPS_INDEX_FILE)) {
        const backup = `${GAPS_INDEX_FILE}.corrupt-${Date.now()}.json`;
        fs.renameSync(GAPS_INDEX_FILE, backup);
      }
    } catch (err) {
      // ignore backup errors
    }
    try {
      const tmp = GAPS_INDEX_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ gaps: [] }, null, 2));
      fs.renameSync(tmp, GAPS_INDEX_FILE);
    } catch (err) {
      // ignore reset errors
    }
  }
  return { gaps: [] };
}

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

  const data = readGapsIndex();
  const gaps = Array.isArray(data.gaps) ? data.gaps : [];
  const agg = {};

  for (const gap of gaps) {
    const repos = Array.isArray(gap.githubRepos) ? gap.githubRepos : [];
    for (const repo of repos) {
      const key = repo.full_name || repo.repo || repo;
      if (!key) continue;
      if (!agg[key]) {
        agg[key] = {
          repo: key,
          gapCount: 0,
          totalScore: 0,
          openCount: 0,
          postedCount: 0,
          resolvedCount: 0,
          stars: 0,
          xHandle: null
        };
      }
      const entry = agg[key];
      entry.gapCount += 1;
      entry.totalScore += (gap.score || 0);
      if (gap.status === 'posted') entry.postedCount += 1;
      else if (gap.status === 'resolved') entry.resolvedCount += 1;
      else entry.openCount += 1;

      if (typeof repo.stars === 'number') {
        entry.stars = repo.stars;
      }
      if (repo.xHandle) {
        entry.xHandle = repo.xHandle;
      }
    }
  }

  const leaderboard = Object.values(agg)
    .sort((a, b) => {
      if (b.openCount !== a.openCount) return b.openCount - a.openCount;
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return (b.stars || 0) - (a.stars || 0);
    })
    .slice(0, 50);

  cache.leaderboard = leaderboard;
  updateCacheMeta();
  return leaderboard;
}

module.exports = {
  computeLeaderboard
};
