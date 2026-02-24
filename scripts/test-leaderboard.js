const fs = require('fs');
const path = require('path');

const tmpDir = path.join('/tmp', `clashd27-leaderboard-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

process.env.GAPS_INDEX_FILE = path.join(tmpDir, 'gaps-index.json');
process.env.FINDINGS_FILE = path.join(tmpDir, 'findings.json');
process.env.GITHUB_CACHE_FILE = path.join(tmpDir, 'github-cache.json');
process.env.GITHUB_USAGE_FILE = path.join(tmpDir, 'github-usage.json');

const { recordGap, updateGapStatus, safeWriteJSON } = require('../lib/gap-recorder');
const { computeLeaderboard } = require('../lib/leaderboard');

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    process.exit(1);
  }
  console.log(`[PASS] ${name}`);
}

function makeFinding(id, score, repo, paper) {
  return {
    id,
    type: 'discovery',
    timestamp: new Date().toISOString(),
    scores: { total: score },
    cellLabels: ['LLMs', 'FormalVerification'],
    supporting_sources: [paper],
    source: `https://github.com/${repo}`
  };
}

(async () => {
  const findings = [
    makeFinding('gap-1', 90, 'owner1/repo1', 'Paper A'),
    makeFinding('gap-2', 80, 'owner1/repo1', 'Paper B'),
    makeFinding('gap-3', 70, 'owner2/repo2', 'Paper C'),
    makeFinding('gap-4', 60, 'owner2/repo2', 'Paper D'),
    makeFinding('gap-5', 50, 'owner2/repo2', 'Paper E'),
    makeFinding('gap-6', 40, 'owner3/repo3', 'Paper F'),
    makeFinding('gap-7', 30, 'owner3/repo3', 'Paper G'),
    makeFinding('gap-8', 20, 'owner1/repo1', 'Paper H'),
    makeFinding('gap-9', 10, 'owner1/repo1', 'Paper I'),
    // Duplicate by hash (same paper + repo as gap-1)
    makeFinding('gap-10', 95, 'owner1/repo1', 'Paper A')
  ];

  safeWriteJSON(process.env.FINDINGS_FILE, { findings });
  safeWriteJSON(process.env.GAPS_INDEX_FILE, { gaps: [] });

  for (const finding of findings) {
    await recordGap({ discovery_id: finding.id, timestamp: finding.timestamp });
  }

  const gapsIndex = JSON.parse(fs.readFileSync(process.env.GAPS_INDEX_FILE, 'utf8'));
  assert('Dedupes duplicate gap by hash', gapsIndex.gaps.length === 9);

  updateGapStatus('gap-2', 'posted');
  updateGapStatus('gap-3', 'resolved');
  updateGapStatus('gap-4', 'resolved');

  const leaderboard = computeLeaderboard();
  assert('Leaderboard returns 3 repos', leaderboard.length === 3);

  const top = leaderboard[0];
  assert('Top repo sorted by openCount desc', top.repo === 'owner2/repo2');

  const second = leaderboard[1];
  assert('Second repo sorted by openCount + score', second.repo === 'owner1/repo1');

  const third = leaderboard[2];
  assert('Third repo is remaining', third.repo === 'owner3/repo3');

  console.log('[DONE] Leaderboard tests passed.');
})();
