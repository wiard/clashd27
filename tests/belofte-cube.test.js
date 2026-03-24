'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runBelofteCube } = require('../src/bieb/belofte-cube');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    failed += 1;
  } else {
    console.log(`[PASS] ${name}`);
    passed += 1;
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belofte-cube-'));
}

function makeGap(overrides = {}) {
  return {
    libraryId: overrides.libraryId || `lib-${Math.random().toString(36).slice(2, 10)}`,
    gapId: overrides.gapId || `gap-${Math.random().toString(36).slice(2, 10)}`,
    fingerprint: overrides.fingerprint || `fp-${Math.random().toString(36).slice(2, 10)}`,
    title: overrides.title || 'Signals clustered in trust-model/engine/current indicate an ungoverned capability',
    hypothesis: overrides.hypothesis || 'Signals clustered in trust-model/engine/current indicate an ungoverned capability worth formal review.',
    score: overrides.score == null ? 0.72 : overrides.score,
    domain: overrides.domain || 'ai-safety',
    domainId: overrides.domainId || overrides.domain || 'ai-safety',
    domains: overrides.domains || [overrides.domain || 'ai-safety'],
    cells: overrides.cells || ['trust-model/engine/current'],
    papers: overrides.papers || [],
    paperCount: overrides.paperCount || 3,
    runCount: overrides.runCount || 2,
    scoreHistory: overrides.scoreHistory || [
      { score: overrides.score == null ? 0.72 : overrides.score, runId: 'r1', runDate: '2026-03-16T00:00:00.000Z', domainId: overrides.domain || 'ai-safety', papersContributing: 3 }
    ]
  };
}

function writeGapLibrary(filePath) {
  const gaps = [
    makeGap({
      fingerprint: 'fp-a',
      gapId: 'gap-a',
      title: 'Consent architecture gap in agent memory',
      hypothesis: 'Agent memory lacks bounded consent architecture.',
      score: 0.82,
      domain: 'ai-governance',
      domains: ['ai-governance'],
      cells: ['architecture/engine/current']
    }),
    makeGap({
      fingerprint: 'fp-b',
      gapId: 'gap-b',
      title: 'Verification blind spot in clinical AI',
      hypothesis: 'Clinical AI verification is inconsistent across deployment contexts.',
      score: 0.76,
      domain: 'healthcare-ai',
      domains: ['healthcare-ai'],
      cells: ['trust-model/engine/emerging']
    }),
    makeGap({
      fingerprint: 'fp-c',
      gapId: 'gap-c',
      title: 'Risk scoring mismatch in legal automation',
      hypothesis: 'Legal automation lacks calibrated risk scoring.',
      score: 0.69,
      domain: 'legal-ai',
      domains: ['legal-ai'],
      cells: ['surface/internal/current']
    }),
    makeGap({
      fingerprint: 'fp-d',
      gapId: 'gap-d',
      title: 'Monitoring residue in finance copilots',
      hypothesis: 'Finance copilots lack residue-aware monitoring.',
      score: 0.63,
      domain: 'finance-ai',
      domains: ['finance-ai'],
      cells: ['surface/external/emerging']
    })
  ];

  fs.writeFileSync(filePath, gaps.map((gap) => JSON.stringify(gap)).join('\n') + '\n');
}

const tmpDir = makeTmpDir();
const gapLibraryPath = path.join(tmpDir, 'gap-library.jsonl');
const beloftesFile = path.join(tmpDir, 'promise-library', 'beloftes.jsonl');
const indexFile = path.join(tmpDir, 'promise-library', 'beloftes-index.json');
const latestCubeFile = path.join(tmpDir, 'promise-library', 'latest-cube.json');
const runsFile = path.join(tmpDir, 'promise-library', 'runs.jsonl');

writeGapLibrary(gapLibraryPath);

const cubeRun = runBelofteCube({
  gapLibraryPath,
  maxRealGaps: 10,
  seed: 'belofte-cube-test'
});

assert('1. runBelofteCube() returns 27 cells', Array.isArray(cubeRun.cells) && cubeRun.cells.length === 27);
assert('2. cells include real gap packets when library is non-empty', cubeRun.cells.some((cell) => cell.type === 'gap-packet'));
assert(
  '3. fallback concepts fill remaining cells',
  cubeRun.cells.filter((cell) => cell.type === 'concept').length > 0
    && cubeRun.cells.filter((cell) => cell.type !== 'gap-packet').length === 23
);
assert('4. topConstellations contains 10 entries', Array.isArray(cubeRun.topConstellations) && cubeRun.topConstellations.length === 10);

const firstConstellation = cubeRun.topConstellations[0] || {};
assert(
  '5. each constellation has hypothesis, domains, score, type',
  typeof firstConstellation.hypothesis === 'string'
    && Array.isArray(firstConstellation.domains)
    && typeof firstConstellation.score === 'number'
    && typeof firstConstellation.type === 'string'
);
assert(
  '6. constellation scores stay between 0 and 1',
  cubeRun.topConstellations.every((constellation) => constellation.score >= 0 && constellation.score <= 1)
);

const bieb = new BeloofteLibrary({
  beloftesFile,
  indexFile,
  latestCubeFile,
  runsFile,
  legacyBeloftesFile: false
});

bieb.saveRun(cubeRun);
assert('7. saveRun() writes to runs.jsonl', fs.existsSync(runsFile) && fs.readFileSync(runsFile, 'utf8').trim().length > 0);

const firstUpsert = bieb.addOrUpdateBeloftes(cubeRun);
const secondRun = runBelofteCube({
  gapLibraryPath,
  maxRealGaps: 10,
  seed: 'belofte-cube-test'
});
secondRun.runId = `${secondRun.runId}-repeat`;
secondRun.timestamp = '2026-03-16T12:00:00.000Z';
const secondUpsert = bieb.addOrUpdateBeloftes(secondRun);
const topBelofte = bieb.getAll()[0];

assert('8. addOrUpdateBeloftes() increments bevestigd on second run', firstUpsert.entries.length > 0 && secondUpsert.updated > 0 && topBelofte.bevestigd >= 2);

bieb.saveRun({
  ...cubeRun,
  runId: 'cube-overwrite-check',
  timestamp: '2026-03-16T13:00:00.000Z'
});
const latestCube = JSON.parse(fs.readFileSync(latestCubeFile, 'utf8'));
assert('9. latest-cube.json is overwritten on each run', latestCube.runId === 'cube-overwrite-check');

const stats = bieb.stats();
assert(
  '10. stats() returns correct counts',
  stats.totalBeloftes > 0
    && stats.totalRuns >= 2
    && typeof stats.byType === 'object'
    && typeof stats.byDomain === 'object'
);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\n${passed} tests passed.`);
