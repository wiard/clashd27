'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { detectBeloftes, scoreBelofteCandidate, classifyBelofte } = require('../src/bieb/belofte-detector');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');
const { BELOFTE_TYPES } = require('../src/bieb/belofte');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    failed++;
  } else {
    console.log(`[PASS] ${name}`);
    passed++;
  }
}

function assertNear(name, actual, expected, eps = 0.05) {
  const ok = Math.abs(actual - expected) <= eps;
  if (!ok) {
    console.error(`[FAIL] ${name} (actual=${actual}, expected=${expected}, eps=${eps})`);
    failed++;
  } else {
    console.log(`[PASS] ${name}`);
    passed++;
  }
}

function makeGap(overrides = {}) {
  return {
    fingerprint: overrides.fingerprint || `fp-${Math.random().toString(36).slice(2, 10)}`,
    title: overrides.title || 'Test gap',
    hypothesis: overrides.hypothesis || 'Signals indicate a missing control surface.',
    cells: overrides.cells || ['trust-model/engine/historical'],
    domain: overrides.domain || 'ai-safety',
    domainId: overrides.domainId || overrides.domain || 'ai-safety',
    domains: overrides.domains || [overrides.domain || 'ai-safety'],
    domainHistory: overrides.domainHistory || (overrides.domains || [overrides.domain || 'ai-safety']).map((d) => ({
      domainId: d,
      domainLabel: d,
      runId: 'test-run',
      score: overrides.score || 0.6,
      date: new Date().toISOString()
    })),
    crossDomain: (overrides.domains || []).length > 1,
    score: overrides.score || 0.6,
    scoreHistory: overrides.scoreHistory || [
      { score: overrides.score || 0.6, runId: 'test-run', runDate: new Date().toISOString(), domainId: overrides.domain || 'ai-safety', papersContributing: 3 }
    ],
    runCount: overrides.runCount || 1,
    status: overrides.status || 'confirmed',
    scoreTrend: overrides.scoreTrend || 'stable',
    lastSeenDaysAgo: 0,
    ...overrides
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belofte-test-'));
}

// ─── Test 1: detectBeloftes returns empty for empty library ──────────
(function test1() {
  const result = detectBeloftes([]);
  assert('1. detectBeloftes() returns empty array for empty library', Array.isArray(result) && result.length === 0);
})();

// ─── Test 2: Two gaps from different domains in same cell → verborgen_verbinding ──
(function test2() {
  const gapA = makeGap({
    fingerprint: 'fp-aaa',
    domain: 'ai-safety',
    domains: ['ai-safety'],
    cells: ['trust-model/engine/historical'],
    hypothesis: 'Signals indicate a missing control surface in trust model engine.',
    score: 0.7,
    runCount: 3
  });
  const gapB = makeGap({
    fingerprint: 'fp-bbb',
    domain: 'healthcare-ai',
    domains: ['healthcare-ai'],
    cells: ['trust-model/engine/historical'],
    hypothesis: 'Signals indicate a missing control surface in trust model engine.',
    score: 0.7,
    runCount: 3
  });

  const result = detectBeloftes([gapA, gapB]);
  const verbinding = result.find((b) =>
    b.type === BELOFTE_TYPES.VERBORGEN_VERBINDING ||
    b.type === BELOFTE_TYPES.CROSS_DOMEIN_BOTSING
  );
  assert('2. Two gaps from different domains in same cell produce candidate', verbinding != null);
})();

// ─── Test 3: Gap appearing in 3+ domains → herhalende_probleemstructuur ──
(function test3() {
  const gap = makeGap({
    fingerprint: 'fp-multi',
    domain: 'ai-safety',
    domains: ['ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai', 'finance-ai', 'education-ai'],
    cells: ['architecture/engine/current'],
    hypothesis: 'Control surface missing across multiple frameworks.',
    score: 0.75,
    runCount: 8,
    scoreHistory: [
      { score: 0.6, runId: 'r1', runDate: '2026-03-10', domainId: 'ai-safety', papersContributing: 3 },
      { score: 0.7, runId: 'r2', runDate: '2026-03-11', domainId: 'healthcare-ai', papersContributing: 3 },
      { score: 0.65, runId: 'r3', runDate: '2026-03-12', domainId: 'legal-ai', papersContributing: 3 },
      { score: 0.8, runId: 'r4', runDate: '2026-03-13', domainId: 'climate-ai', papersContributing: 3 },
      { score: 0.55, runId: 'r5', runDate: '2026-03-14', domainId: 'finance-ai', papersContributing: 3 },
      { score: 0.75, runId: 'r6', runDate: '2026-03-15', domainId: 'education-ai', papersContributing: 3 }
    ]
  });

  const result = detectBeloftes([gap]);
  const herhalend = result.find((b) => b.type === BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR);
  assert('3. Gap in 3+ domains with runCount >= 2 produces herhalende_probleemstructuur', herhalend != null);
})();

// ─── Test 4: High entropy + high novelty → serendipiteit ──
(function test4() {
  // Create a gap with high score variance (high entropy) and novelty
  const scoreHistory = [];
  const scores = [0.2, 0.8, 0.3, 0.9, 0.1, 0.85, 0.15, 0.95];
  for (const score of scores) {
    scoreHistory.push({
      score,
      runId: `run-${Math.random().toString(36).slice(2)}`,
      runDate: new Date().toISOString(),
      domainId: 'ai-safety',
      papersContributing: 3
    });
  }

  const gap = makeGap({
    fingerprint: 'fp-serendip',
    domain: 'ai-safety',
    domains: ['ai-safety', 'healthcare-ai', 'finance-ai', 'legal-ai'],
    cells: ['surface/external/emerging'],
    hypothesis: 'Unexpected convergence of unrelated signals.',
    score: 0.7,
    scoreHistory,
    runCount: 2,
    lastSeenDaysAgo: 0
  });

  const result = detectBeloftes([gap]);
  // Should have at least a serendipiteit or herhalende candidate
  const serendip = result.find((b) => b.type === BELOFTE_TYPES.SERENDIPITEIT);
  const hasCandidate = serendip != null || result.length > 0;
  assert('4. High entropy + high novelty gap produces candidate', hasCandidate);
})();

// ─── Test 5: scoreBelofteCandidate returns score between 0 and 1 ──
(function test5() {
  const { score } = scoreBelofteCandidate({
    overlap: 0.8,
    domainDistance: 0.6,
    bevestigingScore: 0.5,
    novelty: 0.7,
    entropy: 0.3
  });
  assert('5. scoreBelofteCandidate() returns score between 0 and 1', score >= 0 && score <= 1);
})();

// ─── Test 6: scoreBelofteCandidate returns full scoreTrace ──
(function test6() {
  const { scoreTrace } = scoreBelofteCandidate({
    overlap: 0.8,
    domainDistance: 0.6,
    bevestigingScore: 0.5,
    novelty: 0.7,
    entropy: 0.3
  });
  const hasAllKeys = scoreTrace.overlap != null
    && scoreTrace.domainDistance != null
    && scoreTrace.bevestigingScore != null
    && scoreTrace.novelty != null
    && scoreTrace.entropy != null;
  const hasContributions = scoreTrace.overlap.contribution != null
    && scoreTrace.domainDistance.contribution != null;
  assert('6. scoreBelofteCandidate() returns full scoreTrace', hasAllKeys && hasContributions);
})();

// ─── Test 7: classifyBelofte returns correct types ──
(function test7() {
  const verbinding = classifyBelofte({ overlap: 0.7, domainDistance: 0.5, entropy: 0.3, novelty: 0.3, domeinen: ['a', 'b'], runCount: 1 });
  const herhalend = classifyBelofte({ overlap: 0.5, domainDistance: 0.5, entropy: 0.3, novelty: 0.3, domeinen: ['a', 'b', 'c'], runCount: 3 });
  const serendip = classifyBelofte({ overlap: 0.3, domainDistance: 0.3, entropy: 0.8, novelty: 0.8, domeinen: ['a'], runCount: 1 });

  assert('7a. classifyBelofte → verborgen_verbinding', verbinding === BELOFTE_TYPES.VERBORGEN_VERBINDING);
  assert('7b. classifyBelofte → herhalende_probleemstructuur', herhalend === BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR);
  assert('7c. classifyBelofte → serendipiteit', serendip === BELOFTE_TYPES.SERENDIPITEIT);
})();

// ─── Test 8: BeloofteLibrary.addOrUpdate increments bevestigd ──
(function test8() {
  const tmpDir = makeTmpDir();
  const bieb = new BeloofteLibrary({
    beloftesFile: path.join(tmpDir, 'beloftes.jsonl'),
    indexFile: path.join(tmpDir, 'index.json'),
    latestCubeFile: path.join(tmpDir, 'latest-cube.json'),
    runsFile: path.join(tmpDir, 'runs.jsonl'),
    legacyBeloftesFile: false
  });

  const belofte = {
    beloofteId: 'test-belofte-001',
    titel: 'Test belofte',
    type: BELOFTE_TYPES.VERBORGEN_VERBINDING,
    domeinen: ['ai-safety', 'healthcare-ai'],
    cellen: ['trust-model/engine/historical'],
    hypothese: 'Test hypothesis',
    verborgenVerband: 'Test verband',
    bronnengaps: ['fp-a', 'fp-b'],
    score: 0.7,
    scoreTrace: {}
  };

  const first = bieb.addOrUpdate(belofte, 'run-1');
  assert('8a. First addOrUpdate is new', first.isNew === true);

  const second = bieb.addOrUpdate(belofte, 'run-2');
  assert('8b. Second addOrUpdate is not new', second.isNew === false);
  assert('8c. bevestigd incremented to 2', second.belofte.bevestigd === 2);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 9: BeloofteLibrary.query filters by type ──
(function test9() {
  const tmpDir = makeTmpDir();
  const bieb = new BeloofteLibrary({
    beloftesFile: path.join(tmpDir, 'beloftes.jsonl'),
    indexFile: path.join(tmpDir, 'index.json'),
    latestCubeFile: path.join(tmpDir, 'latest-cube.json'),
    runsFile: path.join(tmpDir, 'runs.jsonl'),
    legacyBeloftesFile: false
  });

  bieb.addOrUpdate({
    beloofteId: 'q-001',
    titel: 'Verbinding A',
    type: BELOFTE_TYPES.VERBORGEN_VERBINDING,
    domeinen: ['ai-safety'],
    cellen: ['c1'],
    hypothese: 'h1',
    verborgenVerband: 'v1',
    bronnengaps: ['a'],
    score: 0.7
  }, 'run-1');

  bieb.addOrUpdate({
    beloofteId: 'q-002',
    titel: 'Serendipiteit B',
    type: BELOFTE_TYPES.SERENDIPITEIT,
    domeinen: ['healthcare-ai'],
    cellen: ['c2'],
    hypothese: 'h2',
    verborgenVerband: 'v2',
    bronnengaps: ['b'],
    score: 0.8
  }, 'run-1');

  const verbindingen = bieb.query({ type: BELOFTE_TYPES.VERBORGEN_VERBINDING });
  const serendip = bieb.query({ type: BELOFTE_TYPES.SERENDIPITEIT });

  assert('9a. query({ type: verborgen_verbinding }) returns 1', verbindingen.length === 1);
  assert('9b. query({ type: serendipiteit }) returns 1', serendip.length === 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 10: BeloofteLibrary.stats returns correct counts ──
(function test10() {
  const tmpDir = makeTmpDir();
  const bieb = new BeloofteLibrary({
    beloftesFile: path.join(tmpDir, 'beloftes.jsonl'),
    indexFile: path.join(tmpDir, 'index.json'),
    latestCubeFile: path.join(tmpDir, 'latest-cube.json'),
    runsFile: path.join(tmpDir, 'runs.jsonl'),
    legacyBeloftesFile: false
  });

  bieb.addOrUpdate({
    beloofteId: 's-001',
    titel: 'Stats test 1',
    type: BELOFTE_TYPES.VERBORGEN_VERBINDING,
    domeinen: ['ai-safety', 'healthcare-ai'],
    cellen: ['c1'],
    hypothese: 'h',
    verborgenVerband: 'v',
    bronnengaps: ['a'],
    score: 0.7
  }, 'run-1');

  bieb.addOrUpdate({
    beloofteId: 's-002',
    titel: 'Stats test 2',
    type: BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR,
    domeinen: ['legal-ai', 'climate-ai'],
    cellen: ['c2'],
    hypothese: 'h',
    verborgenVerband: 'v',
    bronnengaps: ['b'],
    score: 0.65
  }, 'run-1');

  const stats = bieb.stats();

  assert('10a. stats().totalBeloftes === 2', stats.totalBeloftes === 2);
  assert('10b. stats().byType has verborgen_verbinding', (stats.byType.verborgen_verbinding || 0) === 1);
  assert('10c. stats().byType has herhalende_probleemstructuur', (stats.byType.herhalende_probleemstructuur || 0) === 1);
  assert('10d. stats().crossDomainCount === 2', stats.crossDomainCount === 2);
  assert('10e. stats().topBeloftes has entries', stats.topBeloftes.length === 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Summary ──
console.log('\n' + '─'.repeat(50));
console.log(`Belofte detector tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
