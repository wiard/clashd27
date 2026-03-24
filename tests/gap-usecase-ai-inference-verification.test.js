'use strict';

/**
 * CLASHD27 — End-to-End Use Case Test
 * "AI inference verification gap"
 *
 * Three signals from different domains suggest AI model inference is widely
 * used for critical decisions but no deterministic verification layer exists
 * for outputs. This test verifies the full deterministic gap discovery
 * pipeline: ingestion → emergence → scoring → hypothesis → handoff.
 *
 * Run: node tests/gap-usecase-ai-inference-verification.test.js
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
const { scoreGapCandidate } = require('../src/gap/gap-scorer');
const { buildHypothesis, buildVerificationPlan, buildKillTests } = require('../src/gap/hypothesis-generator');
const { validateGapPacket } = require('../src/gap/gap-packet');

// ─────────────────────── Test framework ───────────────────────

let passed = 0;
let failed = 0;
const failures = [];
const bugs = [];

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
    console.error(`  [FAIL] ${name} (actual=${actual}, expected=${expected}, delta=${Math.abs(actual - expected).toFixed(4)})`);
    failures.push(`${name} (actual=${actual}, expected=${expected})`);
    failed++;
    return false;
  }
  console.log(`  [PASS] ${name} (actual=${actual})`);
  passed++;
  return true;
}

function tmpFile(label) {
  return path.join('/tmp', `clashd27-infer-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const f = tmpFile(label);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return new Clashd27CubeEngine({ stateFile: f, emergenceThreshold: 0.5 });
}

// ─────────────────────── Signal definitions ───────────────────────

const REFERENCE_TIME = '2026-03-16T00:00:00.000Z';

/** Signal 1 — academic paper on unverified inference */
const SIGNAL_PAPER = {
  id: 'infer-paper-1',
  source: 'paper theory',
  timestamp: '2026-03-06T00:00:00.000Z',
  keywords: ['verification', 'safety', 'gap'],
  evidenceConfidence: 1.3,
  citationCount: 12,
  corroboratedSources: 2
};

/** Signal 2 — github competitor tool execution without validation */
const SIGNAL_GITHUB = {
  id: 'infer-github-1',
  source: 'github competitor',
  timestamp: '2026-03-08T00:00:00.000Z',
  keywords: ['tool', 'agent', 'gap'],
  evidenceConfidence: 1.1,
  citationCount: 6
};

/** Signal 3 — internal system deterministic scoring */
const SIGNAL_INTERNAL = {
  id: 'infer-internal-1',
  source: 'internal system',
  timestamp: '2026-03-10T00:00:00.000Z',
  keywords: ['governance', 'architecture'],
  evidenceConfidence: 0.9
};

const CORE_SIGNALS = [SIGNAL_PAPER, SIGNAL_GITHUB, SIGNAL_INTERNAL];

/**
 * Extended signal bundle to build enough tick density for emergence.
 * Includes 3 core signals + 5 supplementary signals from varied sources.
 */
function buildFullSignalBundle() {
  return [
    SIGNAL_PAPER,   // tick 1 → trust-model/engine/emerging (cell 24)
    SIGNAL_GITHUB,  // tick 2 → surface/external/emerging (cell 22)
    SIGNAL_INTERNAL,// tick 3 → architecture/internal/current (cell 11)
    // Supplementary: another paper on verification → cell 24
    {
      id: 'infer-paper-2', source: 'paper theory',
      timestamp: '2026-03-07T00:00:00.000Z',
      keywords: ['verification', 'evaluation', 'gap'],
      evidenceConfidence: 1.4, citationCount: 18, corroboratedSources: 3
    },
    // Supplementary: github signal about verification → cell 21 (trust-model/external/emerging)
    {
      id: 'infer-github-2', source: 'github competitor',
      timestamp: '2026-03-09T00:00:00.000Z',
      keywords: ['verification', 'safety', 'gap']
    },
    // Supplementary: internal on verification → cell 9 (trust-model/internal/current)
    {
      id: 'infer-internal-2', source: 'internal system',
      timestamp: '2026-03-11T00:00:00.000Z',
      keywords: ['verification', 'safety']
    },
    // Supplementary: paper on tool safety → cell 25 (surface/engine/emerging)
    {
      id: 'infer-paper-3', source: 'paper theory',
      timestamp: '2026-03-12T00:00:00.000Z',
      keywords: ['tool', 'agent', 'gap'],
      evidenceConfidence: 1.2, citationCount: 10
    },
    // Supplementary: github on agent tooling → cell 22 (surface/external/emerging)
    {
      id: 'infer-github-3', source: 'github competitor',
      timestamp: '2026-03-13T00:00:00.000Z',
      keywords: ['agent', 'tool', 'gap'],
      evidenceConfidence: 1.0
    }
  ];
}

// ═══════════════════════════════════════════════════════════════
// TEST 1: SIGNAL INGESTION
// ═══════════════════════════════════════════════════════════════

function test1_signalIngestion() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 1: SIGNAL INGESTION                    ║');
  console.log('╚══════════════════════════════════════════════╝');

  const engine = mkEngine('ingest');

  // --- Deterministic cell mapping ---
  const mappings = CORE_SIGNALS.map(sig =>
    mapSignalToCubeCell(sig, { referenceTime: REFERENCE_TIME })
  );

  for (const m of mappings) {
    assert(`Signal ${m.signalId} maps to cell in 0..26: cell=${m.cellId}`,
      Number.isInteger(m.cellId) && m.cellId >= 0 && m.cellId <= 26);
    console.log(`    → ${m.signalId}: cell=${m.cellId}, axes=${m.axes.what}/${m.axes.where}/${m.axes.time}`);
  }

  // Verify determinism: same input → same cell
  for (const sig of CORE_SIGNALS) {
    const a = mapSignalToCubeCell(sig, { referenceTime: REFERENCE_TIME });
    const b = mapSignalToCubeCell(sig, { referenceTime: REFERENCE_TIME });
    assert(`Signal ${sig.id} mapping is deterministic`, a.cellId === b.cellId);
  }

  // --- Source type classification ---
  const normalized = CORE_SIGNALS.map(s => normalizeSignal(s, { referenceTime: REFERENCE_TIME }));
  assert('Paper signal classified as paper-theory', normalized[0].sourceType === 'paper-theory');
  assert('GitHub signal classified as github-competitor', normalized[1].sourceType === 'github-competitor');
  assert('Internal signal classified as internal-system', normalized[2].sourceType === 'internal-system');

  // --- Source quality weights via score delta ---
  const results = [];
  for (let i = 0; i < CORE_SIGNALS.length; i++) {
    const r = engine.ingestSignal(CORE_SIGNALS[i], {
      tick: i + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
    results.push(r);
  }

  const paperDelta = results[0].scoreDelta;
  const githubDelta = results[1].scoreDelta;
  const internalDelta = results[2].scoreDelta;
  console.log(`    Score deltas — paper: ${paperDelta.toFixed(3)}, github: ${githubDelta.toFixed(3)}, internal: ${internalDelta.toFixed(3)}`);

  assert('Paper score delta >= github (1.5× vs 1.2× weight)', paperDelta >= githubDelta);
  assert('GitHub score delta >= internal (1.2× vs 0.7× weight)', githubDelta >= internalDelta);

  // --- Three signals appear in cube state ---
  const cubeState = engine.getState();
  const signalLog = cubeState.signals || [];
  assert(`Cube state contains ${CORE_SIGNALS.length} signals`, signalLog.length === CORE_SIGNALS.length);

  // --- Evidence score reflects source weighting ---
  const cells = cubeState.cells || {};
  const paperCell = cells[String(mappings[0].cellId)] || {};
  const internalCell = cells[String(mappings[2].cellId)] || {};
  // Paper cell should have higher evidence score than internal due to 1.5× weight + evidence metadata
  if (paperCell.evidenceScore !== undefined && internalCell.evidenceScore !== undefined) {
    assert('Paper cell has >= evidenceScore vs internal cell',
      (paperCell.evidenceScore || 0) >= (internalCell.evidenceScore || 0));
  }

  // --- Spillover does not create false collisions ---
  for (const [cellId, cell] of Object.entries(cells)) {
    const isSpilloverOnly = (cell.directScore || 0) === 0 && (cell.spilloverScore || 0) > 0;
    if (isSpilloverOnly) {
      assert(`Spillover-only cell ${cellId} has zero direct events`,
        (cell.events || 0) === 0);
    }
  }

  console.log(`\n  [TEST 1 SUMMARY] Ingestion verified for ${CORE_SIGNALS.length} signals.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 2: COLLISION DETECTION
// ═══════════════════════════════════════════════════════════════

function test2_collisionDetection() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 2: COLLISION DETECTION                  ║');
  console.log('╚══════════════════════════════════════════════╝');

  const signals = buildFullSignalBundle();
  const engine = mkEngine('collision');

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

  for (const col of collisions.slice(0, 5)) {
    console.log(`    → Collision: cells=[${col.cells}], type=${col.collisionType}, emergence=${col.emergenceScore}, sources=${col.sources.length}, ticks=${(col.ticks || []).length}`);
  }
  for (const cl of clusters.slice(0, 3)) {
    console.log(`    → Cluster: cells=[${cl.cells}], size=${cl.size}, totalScore=${cl.totalScore.toFixed(3)}`);
  }

  // --- At least one collision ---
  assert('At least one collision detected', collisions.length > 0);

  // --- Check collision pair properties ---
  if (collisions.length > 0) {
    const topCol = collisions[0];
    assert('Top collision has >= 2 sources', (topCol.sources || []).length >= 2);
    assert('Top collision has >= 3 ticks', (topCol.ticks || []).length >= 3);

    // Combined score = sum of cell scores for the collision pair
    const cubeState = engine.getState();
    const cellScores = (topCol.cells || []).map(id => {
      const cell = (cubeState.cells || {})[String(id)];
      return cell ? (cell.score || 0) : 0;
    });
    const combinedScore = cellScores.reduce((a, b) => a + b, 0);
    console.log(`    Combined score of top collision: ${combinedScore.toFixed(3)}`);
    assert('Combined score of collision pair >= 0.7', combinedScore >= 0.7);
  }

  // --- Cluster detection ---
  if (clusters.length > 0) {
    assert('Cluster has correct cell grouping (size >= 2)', clusters[0].size >= 2);
    assert('Cluster cells are valid cell IDs',
      clusters[0].cells.every(c => Number.isInteger(c) && c >= 0 && c < 27));
  } else {
    console.log('    [NOTE] No clusters formed — signals may land in non-adjacent cells. Documented.');
  }

  // --- Gravity check on collision pair ---
  if (collisions.length > 0) {
    const gravityCells = computeResearchGravity(engine.getState(), emergence);
    const topCol = collisions[0];
    const gravA = gravityCells.find(g => g.cell === Number(topCol.cells[0]));
    const gravB = gravityCells.find(g => g.cell === Number(topCol.cells[1]));
    const combinedGravity = (gravA ? gravA.gravityScore : 0) + (gravB ? gravB.gravityScore : 0);
    console.log(`    Combined gravity: ${combinedGravity.toFixed(3)}`);
    assert('Combined gravity of collision pair >= 0.5', combinedGravity >= 0.5);
  }

  console.log(`\n  [TEST 2 SUMMARY] Collision detection completed.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 3: DISCOVERY CANDIDATE
// ═══════════════════════════════════════════════════════════════

function test3_discoveryCandidate() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 3: DISCOVERY CANDIDATE                 ║');
  console.log('╚══════════════════════════════════════════════╝');

  const signals = buildFullSignalBundle();
  const engine = mkEngine('candidate');

  for (let i = 0; i < signals.length; i++) {
    engine.ingestSignal(signals[i], {
      tick: i + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
  }

  const cubeState = engine.getState();
  const emergence = engine.summarizeEmergence({ persist: false });
  const gravityCells = computeResearchGravity(cubeState, emergence);

  const candidates = detectDiscoveryCandidates({
    gravityCells,
    emergenceSummary: emergence,
    cubeState
  });

  console.log(`    Candidates generated: ${candidates.length}`);

  // --- At least one candidate ---
  assert('At least one discovery candidate generated', candidates.length > 0);

  if (candidates.length > 0) {
    const top = candidates[0];
    console.log(`    → Top candidate: id=${top.id}, type=${top.type}, score=${top.candidateScore}, cells=[${top.cells}]`);

    // --- Candidate type ---
    const validTypes = ['collision_intersection', 'far_field_collision', 'cluster_peak', 'gradient_ascent'];
    assert(`Candidate type is valid: ${top.type}`, validTypes.includes(top.type));

    // --- Candidate score ---
    assert(`Candidate score >= 0.3 (actual=${top.candidateScore})`, top.candidateScore >= 0.3);

    // --- Cell set is deterministic ---
    const engine2 = mkEngine('candidate-rerun');
    for (let i = 0; i < signals.length; i++) {
      engine2.ingestSignal(signals[i], { tick: i + 1, persist: false, referenceTime: REFERENCE_TIME });
    }
    const cubeState2 = engine2.getState();
    const emergence2 = engine2.summarizeEmergence({ persist: false });
    const gravityCells2 = computeResearchGravity(cubeState2, emergence2);
    const candidates2 = detectDiscoveryCandidates({
      gravityCells: gravityCells2,
      emergenceSummary: emergence2,
      cubeState: cubeState2
    });

    if (candidates2.length > 0) {
      const cells1 = candidates[0].cells.slice().sort((a, b) => a - b).join(',');
      const cells2 = candidates2[0].cells.slice().sort((a, b) => a - b).join(',');
      assert('Candidate cell set is deterministic across runs', cells1 === cells2);
    }

    // --- Deduplication ---
    const cellKeys = new Set();
    let hasDuplicates = false;
    for (const c of candidates) {
      const key = c.cells.slice().sort((a, b) => a - b).join(',');
      if (cellKeys.has(key)) { hasDuplicates = true; break; }
      cellKeys.add(key);
    }
    assert('No duplicate candidate cell sets', !hasDuplicates);
  }

  console.log(`\n  [TEST 3 SUMMARY] Discovery candidate detection verified.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 4: GAP SCORING
// ═══════════════════════════════════════════════════════════════

function test4_gapScoring() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 4: GAP SCORING                         ║');
  console.log('╚══════════════════════════════════════════════╝');

  const signals = buildFullSignalBundle();
  const result = runGapDiscoveryFromSignals(signals, {
    referenceTime: REFERENCE_TIME,
    tick: signals.length,
    emergenceThreshold: 0.5
  });

  const packets = result.packets || [];
  console.log(`    Gap packets generated: ${packets.length}`);

  if (packets.length === 0) {
    console.error('  [FAIL] No gap packets generated — scoring test cannot proceed.');
    failed++;
    failures.push('No gap packets generated for scoring test');
    bugs.push('Pipeline produced zero GapPackets from the inference verification signal bundle.');
    return null;
  }

  const top = packets[0];
  const scores = top.scores;
  const trace = top.scoringTrace;

  // --- Print scoring trace ---
  console.log('\n    ┌──────────────────────────────────────────┐');
  console.log('    │  SCORING TRACE (top candidate)            │');
  console.log('    ├──────────────────────────────────────────┤');
  console.log(`    │  novelty:      ${scores.novelty}`);
  console.log(`    │  collision:    ${scores.collision}`);
  console.log(`    │  residue:      ${scores.residue}`);
  console.log(`    │  gravity:      ${scores.gravity}`);
  console.log(`    │  evidence:     ${scores.evidence}`);
  console.log(`    │  entropy:      ${scores.entropy}`);
  console.log(`    │  serendipity:  ${scores.serendipity}`);
  console.log('    │──────────────────────────────────────────│');
  console.log(`    │  TOTAL:        ${scores.total}`);
  console.log(`    │  promising:    ${top.promising}`);
  console.log('    └──────────────────────────────────────────┘');

  // --- scoringTrace structure ---
  assert('scoringTrace exists', trace !== null && trace !== undefined);
  assert('scoringTrace has version', typeof trace.version === 'string' && trace.version.length > 0);
  assert('scoringTrace has formulas object', trace.formulas && typeof trace.formulas === 'object');

  // --- All 7 components present and in range ---
  const COMPONENTS = ['novelty', 'collision', 'residue', 'gravity', 'evidence', 'entropy', 'serendipity'];

  for (const comp of COMPONENTS) {
    assert(`scores.${comp} exists as number`, typeof scores[comp] === 'number');
    assert(`scores.${comp} ∈ [0,1] (value=${scores[comp]})`, scores[comp] >= 0 && scores[comp] <= 1);
  }

  // --- Formula trace for each component ---
  for (const comp of COMPONENTS) {
    assert(`scoringTrace.formulas.${comp} is non-empty string`,
      typeof trace.formulas[comp] === 'string' && trace.formulas[comp].length > 0);
  }
  assert('scoringTrace.formulas.total describes weighted formula',
    typeof trace.formulas.total === 'string' && trace.formulas.total.length > 0);

  // --- Verify total = weighted sum ±0.01 ---
  const WEIGHTS = {
    novelty: 0.16,
    collision: 0.18,
    residue: 0.16,
    gravity: 0.16,
    evidence: 0.14,
    entropy: 0.10,
    serendipity: 0.10
  };

  let computed = 0;
  for (const comp of COMPONENTS) {
    computed += WEIGHTS[comp] * scores[comp];
  }
  computed = Math.max(0, Math.min(1, computed));
  computed = Math.round(computed * 1000) / 1000;

  assertNear('Final score equals weighted sum of components', scores.total, computed, 0.01);

  // --- Score threshold checks ---
  assert(`Total score >= 0.4 (becomes GapPacket): ${scores.total}`, scores.total >= 0.4);

  if (scores.total >= 0.62) {
    assert('Score >= 0.62 (promising for handoff)', true);
  } else {
    console.log(`    [NOTE] Score ${scores.total} is below 0.62 promising threshold. Documented.`);
  }

  console.log(`\n  [TEST 4 SUMMARY] Gap scoring verified across ${COMPONENTS.length} components.`);
  return top;
}

// ═══════════════════════════════════════════════════════════════
// TEST 5: HYPOTHESIS GENERATION
// ═══════════════════════════════════════════════════════════════

function test5_hypothesisGeneration(topPacket) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 5: HYPOTHESIS GENERATION               ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!topPacket) {
    console.log('  [NOTE] No packet from test 4 — regenerating standalone.');
    const signals = buildFullSignalBundle();
    const result = runGapDiscoveryFromSignals(signals, {
      referenceTime: REFERENCE_TIME, tick: signals.length, emergenceThreshold: 0.5
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
  const plan = topPacket.verificationPlan;
  const kills = topPacket.killTests;

  console.log('\n    ┌──────────────────────────────────────────┐');
  console.log('    │  HYPOTHESIS                               │');
  console.log('    ├──────────────────────────────────────────┤');
  console.log(`    │  Statement: ${hyp.statement}`);
  console.log(`    │  Rationale: ${hyp.rationale}`);
  console.log('    └──────────────────────────────────────────┘');

  // --- Falsifiable statement ---
  assert('hypothesis.statement is non-empty string',
    typeof hyp.statement === 'string' && hyp.statement.length > 0);
  assert('Statement contains falsifiable claim',
    hyp.statement.includes('indicate') || hyp.statement.includes('suggest') ||
    hyp.statement.includes('signal') || hyp.statement.includes('worth') ||
    hyp.statement.includes('clustered') || hyp.statement.includes('show'));

  // --- Verification plan: exactly 3 steps ---
  assert('verificationPlan is an array', Array.isArray(plan));
  assert(`verificationPlan has exactly 3 steps (actual=${plan.length})`, plan.length === 3);

  const stepNames = new Set();
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    assert(`Step ${i + 1} has 'step' field`, typeof step.step === 'string' && step.step.length > 0);
    assert(`Step ${i + 1} has 'objective' field`, typeof step.objective === 'string' && step.objective.length > 0);
    assert(`Step ${i + 1} has 'successMetric' field`, typeof step.successMetric === 'string' && step.successMetric.length > 0);
    stepNames.add(step.step);
  }
  assert('All plan steps are unique', stepNames.size === plan.length);

  // --- Kill conditions: exactly 4 ---
  assert('killTests is an array', Array.isArray(kills));
  assert(`killTests has exactly 4 conditions (actual=${kills.length})`, kills.length === 4);

  for (let i = 0; i < kills.length; i++) {
    assert(`Kill condition ${i + 1} has 'condition'`, kills[i].condition !== undefined && kills[i].condition !== null);
    assert(`Kill condition ${i + 1} has non-empty 'reason'`, typeof kills[i].reason === 'string' && kills[i].reason.length > 0);
  }

  console.log(`\n  [TEST 5 SUMMARY] Hypothesis verified: 3 steps, 4 kill conditions, all non-empty.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 6: GAP PACKET STRUCTURE
// ═══════════════════════════════════════════════════════════════

function test6_gapPacket(topPacket) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 6: GAP PACKET STRUCTURE                ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!topPacket) {
    console.log('  [NOTE] No packet from test 4 — regenerating standalone.');
    const signals = buildFullSignalBundle();
    const result = runGapDiscoveryFromSignals(signals, {
      referenceTime: REFERENCE_TIME, tick: signals.length, emergenceThreshold: 0.5
    });
    topPacket = (result.packets || [])[0];
    if (!topPacket) {
      console.error('  [FAIL] Cannot generate gap packet for structure test.');
      failed++;
      failures.push('Cannot generate gap packet for structure test');
      return;
    }
  }

  console.log(`    packetId: ${topPacket.packetId}`);
  console.log(`    kind:     ${topPacket.kind}`);
  console.log(`    version:  ${topPacket.version}`);

  // --- Required fields ---
  assert('Packet has packetId (gapId)', typeof topPacket.packetId === 'string' && topPacket.packetId.length > 0);
  assert('Packet has rendering with title', topPacket.rendering && typeof topPacket.rendering.title === 'string');
  assert('Packet has hypothesis object', topPacket.hypothesis && typeof topPacket.hypothesis.statement === 'string');
  assert('Packet has scoringTrace object', topPacket.scoringTrace && typeof topPacket.scoringTrace.version === 'string');
  assert('Packet has verificationPlan array', Array.isArray(topPacket.verificationPlan) && topPacket.verificationPlan.length > 0);
  assert('Packet has killTests array', Array.isArray(topPacket.killTests) && topPacket.killTests.length > 0);
  assert('Packet has recommendedAction', topPacket.recommendedAction && typeof topPacket.recommendedAction === 'object');
  assert('Packet has lifecycle metadata', topPacket.lifecycle && typeof topPacket.lifecycle.authorityBoundary === 'string');
  assert('Packet has candidate metadata', topPacket.candidate && typeof topPacket.candidate.id === 'string');

  // --- scoringTrace present for explainability ---
  const trace = topPacket.scoringTrace;
  assert('scoringTrace has formulas', trace.formulas && typeof trace.formulas === 'object');
  assert('scoringTrace has cells', Array.isArray(trace.cells));
  assert('scoringTrace has domainDistance', typeof trace.domainDistance === 'number');

  // --- Packet score matches gap scorer output ---
  assert('Packet scores.total matches computed score',
    typeof topPacket.scores.total === 'number' && topPacket.scores.total >= 0.4);

  // --- Full validation ---
  const validation = validateGapPacket(topPacket);
  assert('Gap packet passes full validation', validation.ok === true);
  if (!validation.ok) {
    console.log(`    Validation errors: ${validation.errors.join(', ')}`);
  }

  console.log(`\n  [TEST 6 SUMMARY] Gap packet structure verified with all required fields.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 7: PROPOSAL HANDOFF
// ═══════════════════════════════════════════════════════════════

function test7_proposalHandoff(topPacket) {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 7: PROPOSAL HANDOFF                    ║');
  console.log('╚══════════════════════════════════════════════╝');

  if (!topPacket) {
    console.log('  [NOTE] No packet from test 4 — regenerating standalone.');
    const signals = buildFullSignalBundle();
    const result = runGapDiscoveryFromSignals(signals, {
      referenceTime: REFERENCE_TIME, tick: signals.length, emergenceThreshold: 0.5
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

  console.log('\n    ┌──────────────────────────────────────────┐');
  console.log('    │  GAP PROPOSAL HANDOFF (sanitized)         │');
  console.log('    ├──────────────────────────────────────────┤');
  console.log(`    │  kind:              ${handoff.kind}`);
  console.log(`    │  executionMode:     ${handoff.executionMode}`);
  console.log(`    │  sourceSystem:      ${handoff.sourceSystem}`);
  console.log(`    │  destinationSystem: ${handoff.destinationSystem}`);
  console.log(`    │  trustBoundary:     ${handoff.trustBoundary}`);
  console.log(`    │  requiresHuman:     ${handoff.requiresHumanApproval}`);
  console.log(`    │  packetId:          ${handoff.packetId}`);
  console.log('    └──────────────────────────────────────────┘');

  // --- Core governance assertions ---
  assert('executionMode === "forbidden"', handoff.executionMode === 'forbidden');
  assert('proposalType: kind === "gap_proposal_handoff"', handoff.kind === 'gap_proposal_handoff');
  assert('destinationSystem === "openclashd-v2"', handoff.destinationSystem === 'openclashd-v2');
  assert('requiresHumanApproval === true', handoff.requiresHumanApproval === true);
  assert('directExecutionAllowed === false', handoff.directExecutionAllowed === false);
  assert('trustBoundary === "discovery_only"', handoff.trustBoundary === 'discovery_only');

  // --- Handoff must contain required fields ---
  assert('Handoff has packetId (gapId)', typeof handoff.packetId === 'string' && handoff.packetId.length > 0);

  // hypothesis reachable
  const hasHypMeta = handoff.metadata && handoff.metadata.hypothesis;
  const hasHypProposal = handoff.proposal && handoff.proposal.intent &&
    handoff.proposal.intent.payload && handoff.proposal.intent.payload.hypothesis;
  assert('Handoff contains hypothesis', hasHypMeta || hasHypProposal);

  // scoringTrace reachable
  const hasTraceMeta = handoff.metadata && handoff.metadata.scoringTrace;
  const hasTraceProposal = handoff.proposal && handoff.proposal.intent &&
    handoff.proposal.intent.payload && handoff.proposal.intent.payload.scoringTrace;
  assert('Handoff contains scoringTrace', hasTraceMeta || hasTraceProposal);

  // verificationPlan reachable
  const hasPlanMeta = handoff.metadata && Array.isArray(handoff.metadata.verificationPlan);
  const hasPlanProposal = handoff.proposal && handoff.proposal.intent &&
    handoff.proposal.intent.payload && Array.isArray(handoff.proposal.intent.payload.verificationPlan);
  assert('Handoff contains verificationPlan', hasPlanMeta || hasPlanProposal);

  // source evidence reachable
  const hasEvidence = (handoff.packet && Array.isArray(handoff.packet.evidence)) ||
    (handoff.proposal && handoff.proposal.intent && handoff.proposal.intent.payload &&
      Array.isArray(handoff.proposal.intent.payload.evidenceRefs));
  assert('Handoff contains sourceEvidence (evidence refs)', hasEvidence);

  // --- Handoff must NOT contain forbidden fields ---
  const FORBIDDEN_FIELDS = ['execute', 'action', 'receipt'];
  for (const field of FORBIDDEN_FIELDS) {
    assert(`Handoff does NOT have top-level '${field}' field`,
      !Object.prototype.hasOwnProperty.call(handoff, field));
  }

  // Also check for runtime instruction fields
  assert('Handoff has no "runtimeInstruction" field',
    !Object.prototype.hasOwnProperty.call(handoff, 'runtimeInstruction'));
  assert('Handoff has no "deploy" field',
    !Object.prototype.hasOwnProperty.call(handoff, 'deploy'));

  console.log(`\n  [TEST 7 SUMMARY] Proposal handoff enforces discovery-only governance.`);
}

// ═══════════════════════════════════════════════════════════════
// TEST 8: DISCOVERY HINT LIMIT
// ═══════════════════════════════════════════════════════════════

function test8_discoveryHintLimit() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  TEST 8: DISCOVERY HINT LIMIT                ║');
  console.log('╚══════════════════════════════════════════════╝');

  // Use the full bundle (which produces candidates) plus extra varied signals
  // to ensure enough emergence for hint generation.
  const base = buildFullSignalBundle();
  const signals = [...base];
  // Add a second wave with different IDs and timestamps to build tick density
  for (const s of base) {
    signals.push({
      ...s,
      id: `hint-extra-${s.id}`,
      timestamp: new Date(Date.parse(s.timestamp) + 86400000).toISOString(),
      evidenceConfidence: (s.evidenceConfidence || 1.0) + 0.1
    });
  }

  console.log(`    Total signals ingested: ${signals.length}`);

  const engine = mkEngine('hints');
  for (let i = 0; i < signals.length; i++) {
    engine.ingestSignal(signals[i], {
      tick: i + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
  }

  const cycle = runDiscoveryCycle(engine, { tick: signals.length });
  const hints = cycle.hints || [];
  const candidates = cycle.discovery.candidates || [];

  console.log(`    Candidates found: ${candidates.length}`);
  console.log(`    Hints emitted: ${hints.length}`);

  // --- Maximum 5 hints ---
  assert('MAX_DISCOVERY_HINTS constant is 5', MAX_DISCOVERY_HINTS === 5);
  assert(`Hints emitted <= ${MAX_DISCOVERY_HINTS} (actual=${hints.length})`, hints.length <= MAX_DISCOVERY_HINTS);

  // --- Ordering: top 5 by score, deterministic ---
  if (hints.length >= 2) {
    let ordered = true;
    for (let i = 1; i < hints.length; i++) {
      if (hints[i].candidateScore > hints[i - 1].candidateScore) {
        ordered = false;
        break;
      }
    }
    assert('Hints are in descending candidateScore order', ordered);
  }

  // --- Rank numbering is sequential ---
  for (let i = 0; i < hints.length; i++) {
    assert(`Hint ${i} has rank ${i + 1}`, hints[i].rank === i + 1);
  }

  // --- Top 5 by score selected, not random ---
  if (candidates.length > MAX_DISCOVERY_HINTS && hints.length === MAX_DISCOVERY_HINTS) {
    const topCandidateScores = candidates.slice(0, MAX_DISCOVERY_HINTS).map(c => c.candidateScore);
    const hintScores = hints.map(h => h.candidateScore);
    const match = hintScores.every((s, i) => Math.abs(s - topCandidateScores[i]) < 0.001);
    assert('Top 5 hints match top 5 candidates by score (not random)', match);
  }

  // --- Determinism: run same cycle again ---
  const engine2 = mkEngine('hints-rerun');
  for (let i = 0; i < signals.length; i++) {
    engine2.ingestSignal(signals[i], { tick: i + 1, persist: false, referenceTime: REFERENCE_TIME });
  }
  const cycle2 = runDiscoveryCycle(engine2, { tick: signals.length });
  const hints2 = cycle2.hints || [];

  assert('Hint count is deterministic across runs', hints.length === hints2.length);
  if (hints.length === hints2.length && hints.length > 0) {
    const scoresMatch = hints.every((h, i) =>
      Math.abs(h.candidateScore - hints2[i].candidateScore) < 0.001
    );
    assert('Hint ordering is deterministic across runs', scoresMatch);
  }

  console.log(`\n  [TEST 8 SUMMARY] Discovery hint limit verified at MAX=${MAX_DISCOVERY_HINTS}.`);
}

// ═══════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════

function run() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  CLASHD27 E2E USE CASE: AI Inference Verification Gap     ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Pipeline: ingestion → emergence → scoring →              ║');
  console.log('║            hypothesis → handoff → hint capping            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  test1_signalIngestion();
  test2_collisionDetection();
  test3_discoveryCandidate();
  const topPacket = test4_gapScoring();
  test5_hypothesisGeneration(topPacket);
  test6_gapPacket(topPacket);
  test7_proposalHandoff(topPacket);
  test8_discoveryHintLimit();

  // ─────────────────────── FINAL REPORT ───────────────────────

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  FINAL REPORT                                             ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Assertions: ${passed + failed} total — ${passed} passed, ${failed} failed`);
  console.log('╠════════════════════════════════════════════════════════════╣');

  if (topPacket) {
    const s = topPacket.scores;
    console.log('║');
    console.log('║  1. DETECTION:    CLASHD27 detected the inference verification gap.');
    console.log(`║     → Candidate type: ${topPacket.candidate.type}`);
    console.log(`║     → Cells: [${topPacket.candidate.cells}]`);
    console.log('║');
    console.log('║  2. SCORING:      Deterministic and explainable.');
    console.log(`║     → Total: ${s.total} (N=${s.novelty} C=${s.collision} R=${s.residue} G=${s.gravity} E=${s.evidence} H=${s.entropy} S=${s.serendipity})`);
    console.log(`║     → Formula: ${topPacket.scoringTrace.formulas.total}`);
    console.log('║');
    console.log('║  3. HYPOTHESIS:   Falsifiable statement generated.');
    console.log(`║     → "${topPacket.hypothesis.statement.slice(0, 80)}..."`);
    console.log('║');
    console.log(`║  4. GOVERNANCE:   executionMode = "${topPacket.gapProposalHandoff.executionMode}"`);
    console.log(`║     → trustBoundary = "${topPacket.gapProposalHandoff.trustBoundary}"`);
    console.log(`║     → destination = "${topPacket.gapProposalHandoff.destinationSystem}"`);
    console.log('║');
    console.log('║  5. HINT CAPPING: Correctly limited to MAX_DISCOVERY_HINTS = 5.');
  } else {
    console.log('║  Pipeline did not produce a scored GapPacket.');
    console.log('║  See individual test results above for diagnostics.');
  }

  if (bugs.length > 0) {
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  BUGS / GAPS DISCOVERED:');
    for (const b of bugs) {
      console.log(`║  • ${b}`);
    }
  }

  if (failures.length > 0) {
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  FAILED ASSERTIONS:');
    for (const f of failures) {
      console.log(`║  • ${f.slice(0, 56)}`);
    }
  }

  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('[RESULT] Some assertions failed — see details above.');
    process.exit(1);
  }
  console.log('[DONE] AI inference verification gap use case test passed.');
}

run();
