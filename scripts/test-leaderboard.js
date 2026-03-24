const fs = require('fs');
const path = require('path');

const tmpDir = path.join('/tmp', `clashd27-leaderboard-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const gapsFile = path.join(tmpDir, 'gaps-index.json');
const findingsFile = path.join(tmpDir, 'findings.json');
process.env.GAPS_INDEX_FILE = gapsFile;
process.env.FINDINGS_FILE = findingsFile;
process.env.GITHUB_TOKEN = '';

const { computeLeaderboard } = require('../lib/gap-leaderboard');
const { updateGapStatus, recordGap } = require('../lib/gap-index');
const { generateDraft } = require('../lib/x-post-generator');

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    process.exit(1);
  }
  console.log(`[PASS] ${name}`);
}

function writeJSON(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function seedIndex() {
  const gaps = [];
  const now = new Date().toISOString();
  const repos = ['owner1/repo1', 'owner2/repo2', 'owner3/repo3'];
  for (let i = 0; i < 10; i += 1) {
    const repo = repos[i % repos.length];
    gaps.push({
      id: `gap-${i + 1}`,
      createdAt: now,
      claim: `Gap ${i + 1}`,
      score: 50 + i,
      corridor: 'LLMs×FormalVerification',
      sources: ['Paper A'],
      repos: [{ repo, maintainer_x_handle: '@handle' }],
      status: i < 2 ? 'resolved' : i < 4 ? 'responded' : 'open'
    });
  }
  writeJSON(gapsFile, { gaps });
}

async function run() {
  writeJSON(findingsFile, { findings: [
    {
      id: 'gap-1',
      discovery: 'Test gap claim',
      scores: { total: 90 },
      cellLabels: ['LLMs', 'FormalVerification'],
      supporting_sources: ['https://github.com/owner1/repo1'],
      timestamp: new Date().toISOString()
    }
  ]});

  writeJSON(gapsFile, { gaps: [] });
  await recordGap({ discovery_id: 'gap-1', source: 'https://github.com/owner1/repo1' });
  await recordGap({ discovery_id: 'gap-1', source: 'https://github.com/owner1/repo1' });
  const index = JSON.parse(fs.readFileSync(gapsFile, 'utf8'));
  assert('Dedupes by id', index.gaps.length === 1);

  seedIndex();
  const leaderboard = computeLeaderboard();
  assert('Leaderboard returns 3 repos', leaderboard.length === 3);
  assert('Sorting prefers resolved', leaderboard[0].resolved >= leaderboard[1].resolved);

  const statusResult = updateGapStatus('gap-1', 'posted');
  assert('Status update works', statusResult.ok === true);

  const draft = generateDraft(
    { id: 'gap-1', claim: 'Test gap claim' },
    { repo: 'owner1/repo1', maintainer_x_handle: '@handle' }
  );
  assert('Draft <= 280', draft.char_count <= 280);

  console.log('[DONE] Leaderboard tests passed.');
}

run();
