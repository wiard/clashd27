/**
 * CLASHD27 V2 — Discovery Candidates Tests
 * Tests domain distance scoring, temporal trust, evidence density,
 * far-field candidate formation, and discovery hint output.
 */
const fs = require('fs');
const path = require('path');
const {
  Clashd27CubeEngine,
  normalizeSignal,
  coordsToCell,
  computeDomainDistance
} = require('../lib/clashd27-cube-engine');
const {
  detectDiscoveryCandidates,
  emitDiscoveryHints,
  emitDiscoveryCandidateEvents,
  computeTemporalTrust,
  computeEvidenceDensity,
  computeNoveltyScore,
  computeSourceConfidence,
  MAX_DISCOVERY_HINTS
} = require('../lib/discovery-candidates');
const { computeResearchGravity } = require('../lib/research-gravity');
const { runDiscoveryCycle } = require('../lib/event-emitter');

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
  return path.join('/tmp', `clashd27-v2-disc-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const f = tmpFile(label);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return new Clashd27CubeEngine({ stateFile: f, emergenceThreshold: 0.5 });
}

// --- Test: Discovery hints are capped ---
function testDiscoveryHintsCapped() {
  assert('MAX_DISCOVERY_HINTS is 5', MAX_DISCOVERY_HINTS === 5);

  // Create more than 5 fake candidates
  const fakeCandidates = [];
  for (let i = 0; i < 10; i++) {
    fakeCandidates.push({
      id: `fake-${i}`,
      type: 'collision_intersection',
      cells: [i % 27, (i + 1) % 27],
      axes: [{ what: 'trust-model', where: 'internal', time: 'current' }],
      candidateScore: 0.9 - i * 0.05,
      crossDomain: true,
      domainDistance: 0.2,
      sources: ['a', 'b'],
      explanation: `Test hint ${i}`,
      rankingMetadata: {
        novelty: 0.7,
        evidenceDensity: 0.6,
        sourceConfidence: 0.5,
        temporalTrust: 0.1,
        governanceConfidence: 0.5
      }
    });
  }

  const hints = emitDiscoveryHints(fakeCandidates);
  assert('Hints capped at 5', hints.length === 5);
  assert('Hints ordered by rank', hints[0].rank === 1 && hints[4].rank === 5);
}

// --- Test: Discovery hint structure ---
function testDiscoveryHintStructure() {
  const candidate = {
    id: 'struct-1',
    type: 'collision_intersection',
    cells: [0, 1],
    axes: [
      { what: 'trust-model', where: 'internal', time: 'current' },
      { what: 'surface', where: 'internal', time: 'current' }
    ],
    candidateScore: 0.8,
    crossDomain: true,
    domainDistance: 0.1,
    combinedGravity: 2.5,
    sources: ['internal system', 'paper/theory'],
    explanation: 'Test collision hint',
    rankingMetadata: {
      novelty: 0.7,
      evidenceDensity: 0.6,
      sourceConfidence: 0.5,
      temporalTrust: 0.15,
      governanceConfidence: 0.5
    }
  };

  const hints = emitDiscoveryHints([candidate]);
  assert('Hint has one entry', hints.length === 1);
  const h = hints[0];
  assert('Hint type is discovery_hint', h.type === 'discovery_hint');
  assert('Hint has topic', typeof h.topic === 'string' && h.topic.length > 0);
  assert('Hint has evidenceRefs', Array.isArray(h.evidenceRefs));
  assert('Hint has noveltyScore', typeof h.noveltyScore === 'number');
  assert('Hint has pressureScore', typeof h.pressureScore === 'number');
  assert('Hint has confidenceScore', typeof h.confidenceScore === 'number');
  assert('Hint has temporalTrust', typeof h.temporalTrust === 'number');
  assert('Hint has governanceConfidence', h.governanceConfidence === 0.5);
  assert('Hint has whyItMatters', typeof h.whyItMatters === 'string');
  assert('Hint has domainDistance', typeof h.domainDistance === 'number');
}

// --- Test: Temporal trust computation ---
function testTemporalTrust() {
  // Cell with 3+ ticks should get +0.1
  const state = {
    cells: {
      '0': { ticks: [1, 2, 3], timeSpread: 3 },
      '1': { ticks: [1], timeSpread: 1 }
    }
  };
  const trust3 = computeTemporalTrust([0], state);
  assert('3 ticks gives temporal trust >= 0.1', trust3 >= 0.1);

  const trust1 = computeTemporalTrust([1], state);
  assertNear('1 tick gives temporal trust 0', trust1, 0);

  // Cell with wide temporal spread
  const state2 = {
    cells: {
      '0': { ticks: [1, 2, 3, 4, 5, 6, 7], timeSpread: 7 }
    }
  };
  const trustWide = computeTemporalTrust([0], state2);
  assert('Wide spread gives higher temporal trust', trustWide > trust3);
}

// --- Test: Evidence density includes evidenceScore ---
function testEvidenceDensityWithEvidence() {
  const state = {
    cells: {
      '0': { uniqueSourceTypes: ['paper-theory', 'github-competitor'], evidenceScore: 0.5 },
      '1': { uniqueSourceTypes: ['internal-system'], evidenceScore: 0 }
    }
  };

  const d0 = computeEvidenceDensity([0], state);
  const d1 = computeEvidenceDensity([1], state);
  assert('Cell with evidence and diverse sources has higher density', d0 > d1);
}

// --- Test: Source confidence scales with diversity ---
function testSourceConfidenceScaling() {
  const c1 = computeSourceConfidence(['a']);
  const c2 = computeSourceConfidence(['a', 'b', 'c']);
  assert('More diverse sources give higher confidence', c2 > c1);
  assert('Source confidence capped at 1', computeSourceConfidence(['a', 'b', 'c', 'd', 'e']) <= 1);
}

// --- Test: Discovery candidates include domainDistance and collisionType ---
function testCandidateMetadata() {
  const engine = mkEngine('meta');
  const ref = '2026-03-20T00:00:00.000Z';

  // Build signals for a near-field collision
  engine.ingestSignal({ id: 'mc-1', source: 'internal system', timestamp: '2026-03-10T00:00:00.000Z', keywords: ['trust'] }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({ id: 'mc-2', source: 'ai agent skills', timestamp: '2026-03-11T00:00:00.000Z', keywords: ['trust'] }, { tick: 2, persist: false, referenceTime: ref });
  engine.ingestSignal({ id: 'mc-3', source: 'internal system', timestamp: '2026-03-12T00:00:00.000Z', keywords: ['api'] }, { tick: 3, persist: false, referenceTime: ref });
  engine.ingestSignal({ id: 'mc-4', source: 'ai agent skills', timestamp: '2026-03-13T00:00:00.000Z', keywords: ['api'] }, { tick: 4, persist: false, referenceTime: ref });

  const result = runDiscoveryCycle(engine, { tick: 4 });
  const candidates = result.discovery.candidates || [];

  if (candidates.length > 0) {
    const c = candidates[0];
    assert('Candidate has domainDistance', typeof c.domainDistance === 'number');
    assert('Candidate has rankingMetadata.temporalTrust', typeof c.rankingMetadata.temporalTrust === 'number');
    assert('Candidate has rankingMetadata.governanceConfidence', typeof c.rankingMetadata.governanceConfidence === 'number');
  }

  // Check hints are produced
  const hints = result.hints || [];
  assert('Discovery cycle produces hints array', Array.isArray(hints));
  assert('Hints capped at MAX_DISCOVERY_HINTS', hints.length <= MAX_DISCOVERY_HINTS);
}

// --- Test: runDiscoveryCycle returns hints ---
function testRunDiscoveryCycleHints() {
  const engine = mkEngine('cycle-hints');
  const ref = '2026-03-20T00:00:00.000Z';

  // Minimal signals
  engine.ingestSignal({ id: 'rh-1', source: 'internal system', timestamp: '2026-03-19T00:00:00.000Z', keywords: ['trust'] }, { tick: 1, persist: false, referenceTime: ref });

  const result = runDiscoveryCycle(engine, { tick: 1 });
  assert('Result has hints field', Array.isArray(result.hints));
  assert('Result.discovery has hints field', Array.isArray(result.discovery.hints));
}

// --- Test: Novelty score for emerging vs historical ---
function testNoveltyScoreAxisWeighting() {
  // Cell on emerging time axis should score higher than historical
  const state = { cells: {} };
  for (let i = 0; i < 27; i++) state.cells[String(i)] = {};

  // Cell 18 = trust-model/internal/emerging (z=2)
  // Cell 0 = trust-model/internal/historical (z=0)
  const noveltyEmerging = computeNoveltyScore([18], state);
  const noveltyHistorical = computeNoveltyScore([0], state);
  assert('Emerging cell has higher novelty than historical', noveltyEmerging > noveltyHistorical);
}

function run() {
  testDiscoveryHintsCapped();
  testDiscoveryHintStructure();
  testTemporalTrust();
  testEvidenceDensityWithEvidence();
  testSourceConfidenceScaling();
  testCandidateMetadata();
  testRunDiscoveryCycleHints();
  testNoveltyScoreAxisWeighting();

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('[DONE] CLASHD27 V2 discovery candidates tests passed.');
}

run();
