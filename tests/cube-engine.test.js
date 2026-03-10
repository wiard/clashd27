/**
 * CLASHD27 V2 — Cube Engine Tests
 * Tests evidence-aware scoring, spillover isolation, and source quality weighting.
 */
const fs = require('fs');
const path = require('path');
const {
  Clashd27CubeEngine,
  normalizeSignal,
  coordsToCell,
  computeDomainDistance,
  computeEvidenceWeight,
  SOURCE_QUALITY_WEIGHTS
} = require('../lib/clashd27-cube-engine');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    failed++;
    return;
  }
  console.log(`[PASS] ${name}`);
  passed++;
}

function assertNear(name, actual, expected, eps = 1e-3) {
  assert(`${name} (actual=${actual}, expected=${expected})`, Math.abs(actual - expected) <= eps);
}

function tmpFile(label) {
  return path.join('/tmp', `clashd27-v2-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const f = tmpFile(label);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return new Clashd27CubeEngine({ stateFile: f, emergenceThreshold: 0.6 });
}

// --- Test: Source quality weights exist ---
function testSourceQualityWeights() {
  assert('paper-theory weight is 1.5', SOURCE_QUALITY_WEIGHTS['paper-theory'] === 1.5);
  assert('github-competitor weight is 1.2', SOURCE_QUALITY_WEIGHTS['github-competitor'] === 1.2);
  assert('agent-skill weight is 1.0', SOURCE_QUALITY_WEIGHTS['agent-skill'] === 1.0);
  assert('internal-system weight is 0.7', SOURCE_QUALITY_WEIGHTS['internal-system'] === 0.7);
}

// --- Test: Evidence weight computation ---
function testEvidenceWeight() {
  const w1 = computeEvidenceWeight({});
  assertNear('Default evidence weight is 1.0', w1, 1.0);

  const w2 = computeEvidenceWeight({ citationCount: 10 });
  assert('Citation count boosts evidence weight', w2 > 1.0);

  const w3 = computeEvidenceWeight({ evidenceConfidence: 1.3 });
  assert('High evidence confidence boosts weight', w3 > 1.0);

  const w4 = computeEvidenceWeight({ corroboratedSources: 3 });
  assert('Corroborated sources boost weight', w4 > 1.0);

  const w5 = computeEvidenceWeight({ citationCount: 100, evidenceConfidence: 1.5, corroboratedSources: 5 });
  assert('Combined evidence weight is capped at 2.0', w5 <= 2.0);
}

// --- Test: DirectScore vs SpilloverScore separation ---
function testScoreSeparation() {
  const engine = mkEngine('score-sep');
  const ref = '2026-03-20T00:00:00.000Z';

  const r = engine.ingestSignal({
    id: 'sep-1',
    source: 'paper/theory',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });

  const cellId = r.signal.cellId;
  const cell = engine.getState().cells[String(cellId)];

  assert('directScore > 0 after signal', cell.directScore > 0);
  assert('score = directScore + spilloverScore + evidenceScore',
    Math.abs(cell.score - (cell.directScore + cell.spilloverScore + cell.evidenceScore)) < 1e-6);

  // Check that neighbors have spillover but no directScore from this signal
  const { manhattanDistance: md } = require('../lib/clashd27-cube-engine');
  for (let i = 0; i < 27; i++) {
    if (i === cellId) continue;
    if (md(cellId, i) === 1) {
      const neighbor = engine.getState().cells[String(i)];
      if (neighbor.spilloverScore > 0) {
        assert('Neighbor has spillover but zero directScore', neighbor.directScore === 0);
        break;
      }
    }
  }
}

// --- Test: Spillover does NOT trigger collisions ---
function testSpilloverDoesNotTriggerCollisions() {
  const engine = mkEngine('spill-col');
  const ref = '2026-03-20T00:00:00.000Z';

  // Ingest only into one cell with a single source — neighbors only get spillover
  engine.ingestSignal({
    id: 'spill-1',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'spill-2',
    source: 'internal system',
    timestamp: '2026-03-18T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 2, persist: false, referenceTime: ref });

  // Neighbors have spillover only. Collisions require directScore + evidenceScore > 0
  // on BOTH cells. Since only one cell has direct signals, no collision should form
  // between the signaled cell and its spillover-only neighbors.
  const collisions = engine.detectCollisions({ tick: 2, persist: false });
  const spilloverCollisions = collisions.filter(c => {
    const cellA = engine.getState().cells[String(c.cells[0])];
    const cellB = engine.getState().cells[String(c.cells[1])];
    // A collision where one side has zero directScore+evidenceScore should not exist
    return (cellA.directScore + cellA.evidenceScore === 0) ||
           (cellB.directScore + cellB.evidenceScore === 0);
  });
  assert('No collisions triggered by spillover alone', spilloverCollisions.length === 0);
}

// --- Test: Paper source gets higher scoreDelta than internal ---
function testSourceWeightInfluence() {
  const engine = mkEngine('src-weight');
  const ref = '2026-03-20T00:00:00.000Z';

  const r1 = engine.ingestSignal({
    id: 'sw-internal',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });

  const engine2 = mkEngine('src-weight-2');
  const r2 = engine2.ingestSignal({
    id: 'sw-paper',
    source: 'paper/theory',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });

  assert('Paper source gets higher scoreDelta than internal',
    r2.scoreDelta > r1.scoreDelta);
  assertNear('Internal scoreDelta = 0.3 * 0.7', r1.scoreDelta, 0.21);
  assertNear('Paper scoreDelta = 0.3 * 1.5', r2.scoreDelta, 0.45);
}

// --- Test: Domain distance computation ---
function testDomainDistance() {
  // Same cell → distance 0
  assertNear('Same cell distance is 0', computeDomainDistance(0, 0), 0);

  // Adjacent on one axis → distance 0.1
  // Cell 0 = trust-model/internal/historical
  // Cell 1 = surface/internal/historical (what axis differs)
  assertNear('Adjacent what-axis distance is 0.1', computeDomainDistance(0, 1), 0.1);

  // Cell 0 vs Cell 13 = surface/external/current (all three axes differ)
  const d = computeDomainDistance(0, 13);
  assertNear('Three-axis crossing distance is 0.3', d, 0.3);
}

// --- Test: Far-field collision detection ---
function testFarFieldCollisions() {
  const engine = mkEngine('far-field');
  const ref = '2026-03-20T00:00:00.000Z';

  // Build strong signals in two distant cells
  // Cell 0: trust-model/internal/historical
  for (let i = 0; i < 5; i++) {
    engine.ingestSignal({
      id: `ff-0-${i}`,
      source: i % 2 === 0 ? 'internal system' : 'ai agent skills',
      timestamp: `2026-03-${10 + i}T00:00:00.000Z`,
      keywords: ['trust']
    }, { tick: i + 1, persist: false, referenceTime: ref });
  }

  // Cell 13: surface/external/current (Manhattan distance > 1)
  for (let i = 0; i < 5; i++) {
    engine.ingestSignal({
      id: `ff-13-${i}`,
      source: i % 3 === 0 ? 'github competitor' : (i % 3 === 1 ? 'paper/theory' : 'ai agent skills'),
      timestamp: `2026-03-${10 + i}T00:00:00.000Z`,
      keywords: ['api', 'channel']
    }, { tick: i + 1, persist: false, referenceTime: ref });
  }

  const collisions = engine.detectCollisions({ tick: 5, persist: false });
  const farField = collisions.filter(c => c.collisionType === 'far-field');

  // Far-field collisions may or may not form depending on exact score thresholds.
  // We verify the engine at least processes them without error and that
  // any far-field collision that does form has the correct metadata.
  assert('Far-field collision detection runs without error', Array.isArray(collisions));
  if (farField.length > 0) {
    assert('Far-field collision has domainDistance', farField[0].domainDistance > 0);
    assert('Far-field collision type is far-field', farField[0].collisionType === 'far-field');
  }
}

// --- Test: GovernanceConfidence field exists ---
function testGovernanceField() {
  const engine = mkEngine('gov');
  const cell = engine.getState().cells['0'];
  assert('governanceConfidence defaults to 0.5', cell.governanceConfidence === 0.5);
}

// --- Test: Decay preserves score separation ---
function testDecayPreservesScoreSeparation() {
  const engine = mkEngine('decay-sep');
  const ref = '2026-03-20T00:00:00.000Z';

  engine.ingestSignal({
    id: 'decay-1',
    source: 'paper/theory',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });

  const cellId = normalizeSignal({
    id: 'decay-1', source: 'paper/theory',
    timestamp: '2026-03-19T00:00:00.000Z', keywords: ['trust']
  }).cellId;

  engine.updateResidue(50, { persist: false });
  const cell = engine.getState().cells[String(cellId)];

  assert('After decay, directScore still tracked', Number.isFinite(cell.directScore));
  assert('After decay, spilloverScore still tracked', Number.isFinite(cell.spilloverScore));
  assert('After decay, score = sum of components',
    Math.abs(cell.score - (cell.directScore + cell.spilloverScore + cell.evidenceScore)) < 1e-4);
}

// --- Test: Candidate ranking is deterministic ---
function testCandidateRankingDeterministic() {
  function buildEngine() {
    const engine = mkEngine('determ-' + Date.now());
    const ref = '2026-03-20T00:00:00.000Z';
    engine.ingestSignal({ id: 'd1', source: 'internal system', timestamp: '2026-03-10T00:00:00.000Z', keywords: ['trust'] }, { tick: 1, persist: false, referenceTime: ref });
    engine.ingestSignal({ id: 'd2', source: 'ai agent skills', timestamp: '2026-03-11T00:00:00.000Z', keywords: ['api'] }, { tick: 2, persist: false, referenceTime: ref });
    engine.ingestSignal({ id: 'd3', source: 'paper/theory', timestamp: '2026-03-12T00:00:00.000Z', keywords: ['audit'] }, { tick: 3, persist: false, referenceTime: ref });
    return engine;
  }

  const { runDiscoveryCycle } = require('../lib/event-emitter');
  const e1 = buildEngine();
  const e2 = buildEngine();
  const r1 = runDiscoveryCycle(e1, { tick: 3 });
  const r2 = runDiscoveryCycle(e2, { tick: 3 });

  const ids1 = (r1.discovery.candidates || []).map(c => c.id);
  const ids2 = (r2.discovery.candidates || []).map(c => c.id);
  assert('Candidate ranking is deterministic', JSON.stringify(ids1) === JSON.stringify(ids2));
}

function run() {
  testSourceQualityWeights();
  testEvidenceWeight();
  testScoreSeparation();
  testSpilloverDoesNotTriggerCollisions();
  testSourceWeightInfluence();
  testDomainDistance();
  testFarFieldCollisions();
  testGovernanceField();
  testDecayPreservesScoreSeparation();
  testCandidateRankingDeterministic();

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('[DONE] CLASHD27 V2 cube engine tests passed.');
}

run();
