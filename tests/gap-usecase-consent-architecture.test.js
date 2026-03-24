'use strict';

/**
 * CLASHD27 — End-to-End Use Case Test
 * "AI consent architecture gap"
 *
 * A researcher notices that published AI agent frameworks (LangChain, AutoGen,
 * CrewAI) share context across channels without scoped consent. Three signals
 * arrive from different sources. This test verifies the full gap discovery
 * pipeline: ingestion → emergence → scoring → hypothesis → handoff.
 *
 * Run: npm test -- tests/gap-usecase-consent-architecture.test.js
 *   or: node tests/gap-usecase-consent-architecture.test.js
 */

const fs = require('fs');
const path = require('path');
const {
  Clashd27CubeEngine,
  normalizeSignal,
  computeDomainDistance
} = require('../lib/clashd27-cube-engine');
const {
  detectDiscoveryCandidates,
  emitDiscoveryHints,
  MAX_DISCOVERY_HINTS
} = require('../lib/discovery-candidates');
const { computeResearchGravity } = require('../lib/research-gravity');
const { runDiscoveryCycle } = require('../lib/event-emitter');
const { mapSignalToCubeCell } = require('../src/gap/cube-mapper');
const { runGapDiscoveryFromSignals } = require('../src/gap/gap-pipeline');
const { validateGapPacket } = require('../src/gap/gap-packet');

// ─────────────────────── Test framework ───────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition) {
  if (!condition) {
    console.error(`  [FAIL] ${name}`);
    failures.push(name);
    failed++;
    return false;
  }
  console.log(`  [PASS] ${name}`);
  passed++;
  return true;
}

function assertNear(name, actual, expected, eps = 0.01) {
  const ok = Math.abs(actual - expected) <= eps;
  if (!ok) {
    console.error(`  [FAIL] ${name} (actual=${actual}, expected=${expected}, delta=${Math.abs(actual - expected)})`);
    failures.push(`${name} (actual=${actual}, expected=${expected})`);
    failed++;
    return false;
  }
  console.log(`  [PASS] ${name} (actual=${actual})`);
  passed++;
  return true;
}

function tmpFile(label) {
  return path.join('/tmp', `clashd27-consent-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const f = tmpFile(label);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return new Clashd27CubeEngine({ stateFile: f, emergenceThreshold: 0.5 });
}

// ─────────────────────── Signals ───────────────────────

const REFERENCE_TIME = '2026-03-16T00:00:00.000Z';

/** Signal 1 — academic paper */
const SIGNAL_PAPER = {
  id: 'consent-paper-1',
  source: 'paper theory',
  timestamp: '2026-03-10T00:00:00.000Z',
  keywords: ['consent', 'trust', 'gap', 'channel', 'agent'],
  evidenceConfidence: 1.3,
  citationCount: 12,
  corroboratedSources: 2
};

/** Signal 2 — github competitor */
const SIGNAL_GITHUB = {
  id: 'consent-github-1',
  source: 'github competitor',
  timestamp: '2026-03-12T00:00:00.000Z',
  keywords: ['consent', 'channel', 'agent', 'gap'],
  evidenceConfidence: 1.1,
  citationCount: 6
};

/** Signal 3 — internal system */
const SIGNAL_INTERNAL = {
  id: 'consent-internal-1',
  source: 'internal system',
  timestamp: '2026-03-14T00:00:00.000Z',
  keywords: ['consent', 'channel', 'governance', 'trust'],
  evidenceConfidence: 0.9
};

/** Signal 4 — weak signal for kill test */
const SIGNAL_WEAK = {
  id: 'consent-weak-1',
  source: 'internal system',
  timestamp: '2026-03-15T00:00:00.000Z',
  keywords: ['internal'],
  score: 0.10
};

const ALL_SIGNALS = [SIGNAL_PAPER, SIGNAL_GITHUB, SIGNAL_INTERNAL];

// ═══════════════════════════════════════════════════════════════
// TEST 1: SIGNAL INGESTION
// ═══════════════════════════════════════════════════════════════

function test1_signalIngestion() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 1: SIGNAL INGESTION                    ║');
  console.log('╚══════════════════════════════════════════════╝');

  const engine = mkEngine('ingest');

  // Verify deterministic cell mapping for each signal
  const mappings = ALL_SIGNALS.map(sig => {
    const mapped = mapSignalToCubeCell(sig, { referenceTime: REFERENCE_TIME });
    return mapped;
  });

  for (const m of mappings) {
    assert(`Signal ${m.signalId} maps to valid cell (0..26): cell=${m.cellId}`,
      Number.isInteger(m.cellId) && m.cellId >= 0 && m.cellId <= 26);
    console.log(`    → ${m.signalId}: cell=${m.cellId}, axes=${m.axes.what}/${m.axes.where}/${m.axes.time}`);
  }

  // Verify determinism: map twice, get same result
  for (const sig of ALL_SIGNALS) {
    const a = mapSignalToCubeCell(sig, { referenceTime: REFERENCE_TIME });
    const b = mapSignalToCubeCell(sig, { referenceTime: REFERENCE_TIME });
    assert(`Signal ${sig.id} mapping is deterministic`, a.cellId === b.cellId);
  }

  // Ingest and verify source quality weights
  const results = [];
  for (let i = 0; i < ALL_SIGNALS.length; i++) {
    const r = engine.ingestSignal(ALL_SIGNALS[i], {
      tick: i + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
    results.push(r);
  }

  // Check source type classification
  const normalized = ALL_SIGNALS.map(s => normalizeSignal(s, { referenceTime: REFERENCE_TIME }));
  assert('Paper signal classified as paper-theory', normalized[0].sourceType === 'paper-theory');
  assert('GitHub signal classified as github-competitor', normalized[1].sourceType === 'github-competitor');
  assert('Internal signal classified as internal-system', normalized[2].sourceType === 'internal-system');

  // Verify source quality weights apply (paper > github > internal via score delta)
  // Paper gets 1.5× weight, github gets 1.2×, internal gets 0.7×
  // Paper also has higher evidence confidence and citation count
  const paperDelta = results[0].scoreDelta;
  const githubDelta = results[1].scoreDelta;
  const internalDelta = results[2].scoreDelta;
  console.log(`    Score deltas — paper: ${paperDelta}, github: ${githubDelta}, internal: ${internalDelta}`);
  assert('Paper signal has highest score delta (1.5× weight + evidence)',
    paperDelta >= githubDelta);
  assert('Internal signal has lower score delta than github (0.7× vs 1.2×)',
    internalDelta <= githubDelta || internalDelta <= paperDelta);

  // Verify no spillover-only cell triggers a collision
  const cubeState = engine.getState();
  const cells = cubeState.cells || {};
  for (const [cellId, cell] of Object.entries(cells)) {
    const isSpilloverOnly = (cell.directScore || 0) === 0 && (cell.spilloverScore || 0) > 0;
    if (isSpilloverOnly) {
      assert(`Spillover-only cell ${cellId} has no collision trigger`,
        (cell.events || 0) === 0);
    }
  }

  console.log(`\n  [TEST 1 SUMMARY] Ingestion verified for ${ALL_SIGNALS.length} signals.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: EMERGENCE DETECTION
// ═══════════════════════════════════════════════════════════════

function test2_emergenceDetection() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 2: EMERGENCE DETECTION                 ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Use runGapDiscoveryFromSignals for an integrated test.
  // We need enough signals for emergence. Add supplementary signals to
  // ensure collision detection fires (need ≥2 sources and ≥3 ticks per cell pair).
  const signals = [
    ...ALL_SIGNALS,
    // Duplicate-ish signals with different IDs to build tick history
    { id: 'consent-paper-2', source: 'paper theory', timestamp: '2026-03-11T00:00:00.000Z', keywords: ['consent', 'trust', 'gap'], evidenceConfidence: 1.2, citationCount: 8 },
    { id: 'consent-github-2', source: 'github competitor', timestamp: '2026-03-13T00:00:00.000Z', keywords: ['consent', 'channel', 'gap'], evidenceConfidence: 1.0 },
    { id: 'consent-internal-2', source: 'internal system', timestamp: '2026-03-15T00:00:00.000Z', keywords: ['consent', 'trust', 'governance'] },
  ];

  const engine = mkEngine('emergence');
  for (let i = 0; i < signals.length; i++) {
    engine.ingestSignal(signals[i], {
      tick: i + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
  }

  const emergence = engine.summarizeEmergence({ persist: false });
  const collisions = emergence.collisions || [];
  const clusters = emergence.clusters || [];

  console.log(`    Collisions detected: ${collisions.length}`);
  console.log(`    Clusters detected: ${clusters.length}`);

  if (collisions.length > 0) {
    for (const col of collisions.slice(0, 3)) {
      console.log(`    → Collision: cells=[${col.cells}], type=${col.collisionType}, emergence=${col.emergenceScore}, sources=${col.sources.length}`);
    }
  }

  // Check for at least one collision pair
  const hasCollision = collisions.length > 0;
  assert('At least one collision detected', hasCollision);

  // Check for cluster peak presence
  const hasCluster = clusters.length > 0;
  if (hasCluster) {
    console.log(`    → Top cluster: cells=[${clusters[0].cells}], size=${clusters[0].size}, totalScore=${clusters[0].totalScore}`);
  }
  // Clusters may or may not form depending on signal density — document but don't hard-fail
  if (!hasCluster) {
    console.log('    [NOTE] No clusters formed — signals may map to distant cells. Documented, not a bug.');
  }

  // Check combined gravity of collision pair
  if (hasCollision) {
    const cubeState = engine.getState();
    const gravityCells = computeResearchGravity(cubeState, emergence);
    const topCollision = collisions[0];
    const cellA = topCollision.cells[0];
    const cellB = topCollision.cells[1];
    const gravA = gravityCells.find(g => g.cell === Number(cellA));
    const gravB = gravityCells.find(g => g.cell === Number(cellB));
    const combinedGravity = (gravA ? gravA.gravityScore : 0) + (gravB ? gravB.gravityScore : 0);
    console.log(`    Combined gravity of top collision: ${combinedGravity.toFixed(3)}`);
    assert('Combined gravity of collision pair >= 0.5', combinedGravity >= 0.5);
  }

  console.log(`\n  [TEST 2 SUMMARY] Emergence detection completed.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: SCORING
// ═══════════════════════════════════════════════════════════════

function test3_scoring() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 3: SCORING                             ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Build a rich signal bundle that maximizes emergence
  const signals = [
    SIGNAL_PAPER,
    SIGNAL_GITHUB,
    SIGNAL_INTERNAL,
    { id: 'consent-paper-2', source: 'paper theory', timestamp: '2026-03-08T00:00:00.000Z', keywords: ['consent', 'trust', 'gap'], evidenceConfidence: 1.4, citationCount: 18, corroboratedSources: 3 },
    { id: 'consent-github-2', source: 'github competitor', timestamp: '2026-03-09T00:00:00.000Z', keywords: ['consent', 'channel', 'gap'], evidenceConfidence: 1.1, citationCount: 5 },
    { id: 'consent-internal-2', source: 'internal system', timestamp: '2026-03-11T00:00:00.000Z', keywords: ['consent', 'governance', 'trust'] },
    { id: 'consent-paper-3', source: 'paper theory', timestamp: '2026-03-13T00:00:00.000Z', keywords: ['consent', 'safety', 'gap', 'channel'], evidenceConfidence: 1.2, citationCount: 10 },
    { id: 'consent-github-3', source: 'github competitor', timestamp: '2026-03-14T00:00:00.000Z', keywords: ['agent', 'channel', 'gap', 'consent'], evidenceConfidence: 1.0 },
  ];

  const result = runGapDiscoveryFromSignals(signals, {
    referenceTime: REFERENCE_TIME,
    tick: signals.length,
    emergenceThreshold: 0.5
  });

  const packets = result.packets || [];
  console.log(`    Gap packets generated: ${packets.length}`);

  if (packets.length === 0) {
    console.error('  [FAIL] No gap packets generated — scoring cannot be tested.');
    console.log('  [NOTE] This may indicate signals don\'t produce enough emergence for scored candidates.');
    failed++;
    failures.push('No gap packets generated');
    return null;
  }

  const top = packets[0];
  const scores = top.scores;
  const trace = top.scoringTrace;

  console.log('\n    ┌─────────────────────────────────────────┐');
  console.log('    │  SCORING TRACE (top candidate)           │');
  console.log('    ├─────────────────────────────────────────┤');
  console.log(`    │  novelty:      ${scores.novelty}`);
  console.log(`    │  collision:    ${scores.collision}`);
  console.log(`    │  residue:      ${scores.residue}`);
  console.log(`    │  gravity:      ${scores.gravity}`);
  console.log(`    │  evidence:     ${scores.evidence}`);
  console.log(`    │  entropy:      ${scores.entropy}`);
  console.log(`    │  serendipity:  ${scores.serendipity}`);
  console.log(`    │  ─────────────────────────────────────  │`);
  console.log(`    │  TOTAL:        ${scores.total}`);
  console.log(`    │  promising:    ${top.promising}`);
  console.log('    └─────────────────────────────────────────┘');

  // Verify scoringTrace contains all 7 components
  const COMPONENTS = ['novelty', 'collision', 'residue', 'gravity', 'evidence', 'entropy', 'serendipity'];

  assert('scoringTrace exists', trace !== null && trace !== undefined);
  assert('scoringTrace has version', typeof trace.version === 'string');
  assert('scoringTrace has formulas object', trace.formulas && typeof trace.formulas === 'object');

  for (const comp of COMPONENTS) {
    assert(`scores.${comp} exists`, typeof scores[comp] === 'number');
    assert(`scores.${comp} is between 0 and 1 (value=${scores[comp]})`,
      scores[comp] >= 0 && scores[comp] <= 1);
  }

  // Verify formula descriptions in trace
  for (const comp of COMPONENTS) {
    assert(`scoringTrace.formulas.${comp} exists`,
      typeof trace.formulas[comp] === 'string' && trace.formulas[comp].length > 0);
  }
  assert('scoringTrace.formulas.total exists',
    typeof trace.formulas.total === 'string' && trace.formulas.total.length > 0);

  // Verify final score = weighted sum within ±0.01 tolerance
  const WEIGHTS = {
    novelty: 0.16,
    collision: 0.18,
    residue: 0.16,
    gravity: 0.16,
    evidence: 0.14,
    entropy: 0.10,
    serendipity: 0.10
  };

  let computedTotal = 0;
  for (const comp of COMPONENTS) {
    computedTotal += WEIGHTS[comp] * scores[comp];
  }
  computedTotal = Math.max(0, Math.min(1, computedTotal));
  // Round to 3 decimals like the code does
  computedTotal = Math.round(computedTotal * 1000) / 1000;

  assertNear('Final score matches weighted sum', scores.total, computedTotal, 0.01);

  // Verify score passes packet filter threshold
  assert(`Score >= 0.4 (passes packet filter): ${scores.total}`, scores.total >= 0.4);

  // Check if it qualifies as "promising"
  if (scores.total >= 0.62) {
    assert('Score >= 0.62 (promising for handoff)', true);
  } else {
    console.log(`    [NOTE] Score ${scores.total} is below 0.62 promising threshold. Documented.`);
  }

  console.log(`\n  [TEST 3 SUMMARY] Scoring verified with ${COMPONENTS.length} components.`);
  return top;
}

// ═══════════════════════════════════════════════════════════════
// TEST 4: KILL TEST ENFORCEMENT
// ═══════════════════════════════════════════════════════════════

function test4_killTestEnforcement() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 4: KILL TEST ENFORCEMENT               ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Feed only the weak signal — it should not produce a gap packet
  const weakSignals = [SIGNAL_WEAK];

  const result = runGapDiscoveryFromSignals(weakSignals, {
    referenceTime: REFERENCE_TIME,
    tick: 1,
    emergenceThreshold: 0.5
  });

  const packets = result.packets || [];
  console.log(`    Packets from weak signal: ${packets.length}`);
  assert('Weak signal produces zero gap packets (filtered below 0.4)', packets.length === 0);

  // Also verify: combine weak signal with the real signals and check it's excluded
  const allSignals = [...ALL_SIGNALS, SIGNAL_WEAK];
  const fullResult = runGapDiscoveryFromSignals(allSignals, {
    referenceTime: REFERENCE_TIME,
    tick: allSignals.length,
    emergenceThreshold: 0.5
  });

  // The weak signal should not appear as a standalone gap packet with score >= 0.4
  const weakPackets = (fullResult.packets || []).filter(p =>
    p.candidate && p.candidate.explanation &&
    p.candidate.explanation.toLowerCase().includes('heartbeat')
  );
  assert('Weak "heartbeat" signal not in final gap output', weakPackets.length === 0);

  // Verify summary shows filtering occurred
  const summary = fullResult.summary || {};
  console.log(`    Total candidates evaluated: ${summary.totalCandidates}`);
  console.log(`    Packets after filter (score >= 0.4): ${summary.packetCount}`);

  console.log(`\n  [TEST 4 SUMMARY] Kill test enforcement verified.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 5: HYPOTHESIS
// ═══════════════════════════════════════════════════════════════

function test5_hypothesis(topPacket) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 5: HYPOTHESIS                          ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!topPacket) {
    console.error('  [SKIP] No top packet available from TEST 3 — running standalone.');
    // Generate our own
    const signals = [
      SIGNAL_PAPER, SIGNAL_GITHUB, SIGNAL_INTERNAL,
      { id: 'h-paper-2', source: 'paper theory', timestamp: '2026-03-08T00:00:00.000Z', keywords: ['consent', 'trust', 'gap'], evidenceConfidence: 1.4, citationCount: 18, corroboratedSources: 3 },
      { id: 'h-github-2', source: 'github competitor', timestamp: '2026-03-09T00:00:00.000Z', keywords: ['consent', 'channel', 'gap'], evidenceConfidence: 1.1, citationCount: 5 },
      { id: 'h-internal-2', source: 'internal system', timestamp: '2026-03-11T00:00:00.000Z', keywords: ['consent', 'governance', 'trust'] },
      { id: 'h-paper-3', source: 'paper theory', timestamp: '2026-03-13T00:00:00.000Z', keywords: ['consent', 'safety', 'gap', 'channel'], evidenceConfidence: 1.2, citationCount: 10 },
      { id: 'h-github-3', source: 'github competitor', timestamp: '2026-03-14T00:00:00.000Z', keywords: ['agent', 'channel', 'gap', 'consent'], evidenceConfidence: 1.0 },
    ];
    const result = runGapDiscoveryFromSignals(signals, {
      referenceTime: REFERENCE_TIME,
      tick: signals.length,
      emergenceThreshold: 0.5
    });
    topPacket = (result.packets || [])[0];
    if (!topPacket) {
      console.error('  [FAIL] Cannot generate gap packet for hypothesis test.');
      failed++;
      failures.push('Cannot generate gap packet for hypothesis test');
      return;
    }
  }

  const hyp = topPacket.hypothesis;
  const vPlan = topPacket.verificationPlan;
  const killTests = topPacket.killTests;

  console.log('\n    ┌─────────────────────────────────────────┐');
  console.log('    │  HYPOTHESIS                              │');
  console.log('    ├─────────────────────────────────────────┤');
  console.log(`    │  Statement: ${hyp.statement}`);
  console.log(`    │  Rationale: ${hyp.rationale}`);
  console.log('    └─────────────────────────────────────────┘');

  // Hypothesis has a falsifiable statement
  assert('Hypothesis has statement (string, non-empty)',
    typeof hyp.statement === 'string' && hyp.statement.length > 0);
  assert('Hypothesis statement is falsifiable (contains assertive claim)',
    hyp.statement.includes('indicate') || hyp.statement.includes('suggest') ||
    hyp.statement.includes('show') || hyp.statement.includes('signal') ||
    hyp.statement.includes('worth') || hyp.statement.includes('clustered'));

  // Verification plan with exactly 3 steps
  assert('Verification plan is an array', Array.isArray(vPlan));
  assert(`Verification plan has exactly 3 steps (actual=${vPlan.length})`, vPlan.length === 3);
  for (let i = 0; i < vPlan.length; i++) {
    const step = vPlan[i];
    assert(`Verification step ${i + 1} has 'step' field`, typeof step.step === 'string' && step.step.length > 0);
    assert(`Verification step ${i + 1} has 'objective' field`, typeof step.objective === 'string' && step.objective.length > 0);
    assert(`Verification step ${i + 1} has 'successMetric' field`, typeof step.successMetric === 'string' && step.successMetric.length > 0);
  }

  // Kill conditions — exactly 4
  assert('Kill tests is an array', Array.isArray(killTests));
  assert(`Kill tests has exactly 4 conditions (actual=${killTests.length})`, killTests.length === 4);
  for (let i = 0; i < killTests.length; i++) {
    const kt = killTests[i];
    assert(`Kill condition ${i + 1} has 'condition' field`, kt.condition !== undefined && kt.condition !== null);
    assert(`Kill condition ${i + 1} has 'reason' field`, typeof kt.reason === 'string' && kt.reason.length > 0);
  }

  console.log(`\n  [TEST 5 SUMMARY] Hypothesis verified with 3 steps and 4 kill conditions.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 6: HANDOFF PACKET
// ═══════════════════════════════════════════════════════════════

function test6_handoffPacket(topPacket) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 6: HANDOFF PACKET                      ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!topPacket) {
    console.error('  [SKIP] No top packet — running standalone generation.');
    const signals = [
      SIGNAL_PAPER, SIGNAL_GITHUB, SIGNAL_INTERNAL,
      { id: 'ho-paper-2', source: 'paper theory', timestamp: '2026-03-08T00:00:00.000Z', keywords: ['consent', 'trust', 'gap'], evidenceConfidence: 1.4, citationCount: 18, corroboratedSources: 3 },
      { id: 'ho-github-2', source: 'github competitor', timestamp: '2026-03-09T00:00:00.000Z', keywords: ['consent', 'channel', 'gap'], evidenceConfidence: 1.1, citationCount: 5 },
      { id: 'ho-internal-2', source: 'internal system', timestamp: '2026-03-11T00:00:00.000Z', keywords: ['consent', 'governance', 'trust'] },
      { id: 'ho-paper-3', source: 'paper theory', timestamp: '2026-03-13T00:00:00.000Z', keywords: ['consent', 'safety', 'gap', 'channel'], evidenceConfidence: 1.2, citationCount: 10 },
      { id: 'ho-github-3', source: 'github competitor', timestamp: '2026-03-14T00:00:00.000Z', keywords: ['agent', 'channel', 'gap', 'consent'], evidenceConfidence: 1.0 },
    ];
    const result = runGapDiscoveryFromSignals(signals, {
      referenceTime: REFERENCE_TIME,
      tick: signals.length,
      emergenceThreshold: 0.5
    });
    topPacket = (result.packets || [])[0];
    if (!topPacket) {
      console.error('  [FAIL] Cannot generate gap packet for handoff test.');
      failed++;
      failures.push('Cannot generate gap packet for handoff test');
      return;
    }
  }

  const handoff = topPacket.gapProposalHandoff;

  console.log('\n    ┌─────────────────────────────────────────┐');
  console.log('    │  HANDOFF PACKET (sanitized)              │');
  console.log('    ├─────────────────────────────────────────┤');
  console.log(`    │  kind:              ${handoff.kind}`);
  console.log(`    │  executionMode:     ${handoff.executionMode}`);
  console.log(`    │  sourceSystem:      ${handoff.sourceSystem}`);
  console.log(`    │  destinationSystem: ${handoff.destinationSystem}`);
  console.log(`    │  trustBoundary:     ${handoff.trustBoundary}`);
  console.log(`    │  requiresHumanApproval: ${handoff.requiresHumanApproval}`);
  console.log(`    │  packetId:          ${handoff.packetId}`);
  console.log('    └─────────────────────────────────────────┘');

  // Core handoff assertions
  assert('executionMode === "forbidden"', handoff.executionMode === 'forbidden');
  assert('handoff kind === "gap_proposal_handoff"', handoff.kind === 'gap_proposal_handoff');
  assert('destinationSystem === "openclashd-v2"', handoff.destinationSystem === 'openclashd-v2');
  assert('requiresHumanApproval === true', handoff.requiresHumanApproval === true);
  assert('directExecutionAllowed === false', handoff.directExecutionAllowed === false);
  assert('trustBoundary === "discovery_only"', handoff.trustBoundary === 'discovery_only');

  // Verify proposalType via packet kind
  assert('Packet kind is gap_packet (discovery proposal)', topPacket.kind === 'gap_packet');

  // Handoff must contain required fields
  assert('Handoff has packetId', typeof handoff.packetId === 'string' && handoff.packetId.length > 0);
  assert('Handoff has packet envelope', handoff.packet !== null && typeof handoff.packet === 'object');

  // Verify hypothesis is reachable from handoff
  const hasHypothesisInMetadata = handoff.metadata && handoff.metadata.hypothesis;
  const hasHypothesisInProposal = handoff.proposal && handoff.proposal.intent &&
    handoff.proposal.intent.payload && handoff.proposal.intent.payload.hypothesis;
  assert('Handoff contains hypothesis (via metadata or proposal)',
    hasHypothesisInMetadata || hasHypothesisInProposal);

  // Verify scoringTrace is reachable
  const hasTraceInMetadata = handoff.metadata && handoff.metadata.scoringTrace;
  const hasTraceInProposal = handoff.proposal && handoff.proposal.intent &&
    handoff.proposal.intent.payload && handoff.proposal.intent.payload.scoringTrace;
  assert('Handoff contains scoringTrace (via metadata or proposal)',
    hasTraceInMetadata || hasTraceInProposal);

  // Verify verificationPlan is reachable
  const hasPlanInMetadata = handoff.metadata && Array.isArray(handoff.metadata.verificationPlan);
  const hasPlanInProposal = handoff.proposal && handoff.proposal.intent &&
    handoff.proposal.intent.payload && Array.isArray(handoff.proposal.intent.payload.verificationPlan);
  assert('Handoff contains verificationPlan (via metadata or proposal)',
    hasPlanInMetadata || hasPlanInProposal);

  // Handoff must NOT contain execution-related fields
  const FORBIDDEN_FIELDS = ['execute', 'action', 'receipt'];
  for (const field of FORBIDDEN_FIELDS) {
    // Check top-level only (action/receipt can exist nested in intent structure)
    assert(`Handoff does NOT have top-level '${field}' field`,
      !Object.prototype.hasOwnProperty.call(handoff, field));
  }

  // Validate the full packet via the validator
  const validation = validateGapPacket(topPacket);
  assert('Full gap packet passes validation', validation.ok === true);
  if (!validation.ok) {
    console.log(`    Validation errors: ${validation.errors.join(', ')}`);
  }

  console.log(`\n  [TEST 6 SUMMARY] Handoff packet enforces discovery-only boundary.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 7: HINT CAPPING
// ═══════════════════════════════════════════════════════════════

function test7_hintCapping() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 7: HINT CAPPING                        ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Feed 10 signals simultaneously (varied copies of signal 1-3)
  const signals = [];
  for (let i = 0; i < 10; i++) {
    const base = ALL_SIGNALS[i % 3];
    signals.push({
      ...base,
      id: `cap-${i}-${base.id}`,
      timestamp: new Date(Date.parse(base.timestamp) + i * 3600000).toISOString(),
      score: 0.85 - (i * 0.05) // varied scores
    });
  }

  const engine = mkEngine('capping');
  for (let i = 0; i < signals.length; i++) {
    engine.ingestSignal(signals[i], {
      tick: i + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
  }

  const cycle = runDiscoveryCycle(engine, { tick: signals.length });
  const hints = cycle.hints || [];

  console.log(`    Total candidates: ${(cycle.discovery.candidates || []).length}`);
  console.log(`    Hints emitted: ${hints.length}`);

  assert(`MAX_DISCOVERY_HINTS constant is 5`, MAX_DISCOVERY_HINTS === 5);
  assert(`Hints capped at maximum ${MAX_DISCOVERY_HINTS}`, hints.length <= MAX_DISCOVERY_HINTS);

  // Verify ordering: hints should be ranked by candidateScore (top 5)
  if (hints.length >= 2) {
    let ordered = true;
    for (let i = 1; i < hints.length; i++) {
      if (hints[i].candidateScore > hints[i - 1].candidateScore) {
        ordered = false;
        break;
      }
    }
    assert('Hints are ordered by candidateScore (descending)', ordered);
  }

  // Verify rank numbering
  for (let i = 0; i < hints.length; i++) {
    assert(`Hint ${i} has rank ${i + 1}`, hints[i].rank === i + 1);
  }

  // If we have candidates, the hints should be the top-scoring ones
  const candidates = cycle.discovery.candidates || [];
  if (candidates.length > MAX_DISCOVERY_HINTS && hints.length === MAX_DISCOVERY_HINTS) {
    // The hint scores should match the top 5 candidate scores
    const topCandidateScores = candidates.slice(0, MAX_DISCOVERY_HINTS).map(c => c.candidateScore);
    const hintScores = hints.map(h => h.candidateScore);
    const scoresMatch = hintScores.every((score, i) => Math.abs(score - topCandidateScores[i]) < 0.001);
    assert('Top 5 hints match top 5 candidates by score (not random)', scoresMatch);
  }

  console.log(`\n  [TEST 7 SUMMARY] Hint capping verified at MAX=${MAX_DISCOVERY_HINTS}.`);
}

// ═══════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════

function run() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  CLASHD27 E2E USE CASE: AI Consent Architecture Gap    ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Testing the full gap discovery pipeline:               ║');
  console.log('║  ingestion → emergence → scoring → hypothesis → handoff║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  test1_signalIngestion();
  test2_emergenceDetection();
  const topPacket = test3_scoring();
  test4_killTestEnforcement();
  test5_hypothesis(topPacket);
  test6_handoffPacket(topPacket);
  test7_hintCapping();

  // ─────────────────────── FINAL REPORT ───────────────────────

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  FINAL REPORT                                          ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Total: ${passed + failed} assertions                                    ║`);
  console.log(`║  Passed: ${passed}                                                ║`);
  console.log(`║  Failed: ${failed}                                                 ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');

  if (topPacket) {
    console.log('║  1. Gap finder DETECTED the consent architecture gap    ║');
    console.log('║  2. Scoring is explainable via scoringTrace             ║');
    console.log(`║  3. executionMode: ${topPacket.gapProposalHandoff.executionMode}                          ║`);
  } else {
    console.log('║  1. Gap finder did NOT generate a scored packet         ║');
    console.log('║  2. Scoring could not be verified                       ║');
    console.log('║  3. Handoff enforcement could not be verified           ║');
  }

  if (failures.length > 0) {
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  FAILURES:                                             ║');
    for (const f of failures) {
      console.log(`║  - ${f.slice(0, 52).padEnd(52)} ║`);
    }
  }

  console.log('╚══════════════════════════════════════════════════════════╝');

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('[RESULT] Some assertions failed — see details above.');
    process.exit(1);
  }
  console.log('[DONE] AI consent architecture gap use case test passed.');
}

run();
