'use strict';

const fs = require('fs');
const path = require('path');
const {
  Clashd27CubeEngine,
  normalizeSignal
} = require('../lib/clashd27-cube-engine');
const { computeResearchGravity } = require('../lib/research-gravity');
const {
  detectDiscoveryCandidates,
  emitDiscoveryHints
} = require('../lib/discovery-candidates');
const { enrichCandidates } = require('../lib/proposal-metadata');
const { scoreSignalSources } = require('../lib/source-scorer');
const { scoreGapCandidates } = require('../src/gap/gap-scorer');
const {
  buildHypothesis,
  buildVerificationPlan,
  buildKillTests
} = require('../src/gap/hypothesis-generator');
const { mapSignalToCubeCell } = require('../src/gap/cube-mapper');
const { runGapPipeline } = require('../src/gap/gap-pipeline');

let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function pass(name, details) {
  console.log(`[PASS] ${name}`);
  if (details) console.log(details);
  passed += 1;
}

function fail(name, details) {
  console.error(`[FAIL] ${name}`);
  if (details) console.error(details);
  failed += 1;
}

function assert(name, condition, details) {
  if (condition) pass(name, details);
  else fail(name, details);
}

function round(num, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function tmpFile(label) {
  return path.join('/tmp', `clashd27-silent-drift-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const file = tmpFile(label);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return new Clashd27CubeEngine({ stateFile: file, emergenceThreshold: 0.5 });
}

function makeSignalBundle() {
  return [
    {
      id: 'silent-drift-paper',
      type: 'paper-theory',
      source: 'paper theory',
      domain: 'ai-safety',
      title: 'Silent model drift in production AI systems',
      content: 'ML models deployed in production gradually diverge from their original training assumptions. Without deterministic monitoring, drift can accumulate unnoticed.',
      score: 0.83,
      timestamp: '2026-03-01T00:00:00.000Z',
      keywords: ['safety', 'verification', 'drift']
    },
    {
      id: 'silent-drift-industry',
      type: 'industry-report',
      source: 'industry competitor report',
      domain: 'ai-operations',
      title: 'Continuous model updates in AI SaaS platforms',
      content: 'Several AI platforms deploy silent model updates in the background without explicit version review from operators.',
      score: 0.71,
      timestamp: '2026-03-02T00:00:00.000Z',
      keywords: ['trust', 'verification', 'deployment']
    },
    {
      id: 'silent-drift-governance',
      type: 'internal-system',
      source: 'internal system',
      domain: 'ai-governance',
      title: 'CLASHD27 deterministic signal scoring',
      content: 'CLASHD27 produces deterministic scoring traces that allow signal-level auditing and version-aware evaluation.',
      score: 0.64,
      timestamp: '2026-03-03T00:00:00.000Z',
      keywords: ['governance', 'audit', 'policy']
    }
  ];
}

function makePrioritizationSignals() {
  return [
    ...makeSignalBundle(),
    {
      id: 'silent-drift-paper-2',
      type: 'paper-theory',
      source: 'paper theory',
      domain: 'ai-safety',
      title: 'Verification lag in model serving stacks',
      content: 'Serving stacks often update faster than evaluation layers.',
      score: 0.79,
      timestamp: '2026-03-04T00:00:00.000Z',
      keywords: ['safety', 'verification', 'gap', 'monitoring']
    },
    {
      id: 'silent-drift-industry-2',
      type: 'industry-report',
      source: 'industry competitor report',
      domain: 'ai-operations',
      title: 'Background model rollout practices',
      content: 'Background rollouts rarely expose deterministic drift checks to operators.',
      score: 0.69,
      timestamp: '2026-03-05T00:00:00.000Z',
      keywords: ['trust', 'gap', 'monitoring', 'deployment']
    },
    {
      id: 'silent-drift-surface',
      type: 'industry-report',
      source: 'github competitor',
      domain: 'ai-operations',
      title: 'Surface-level drift symptoms',
      content: 'API-level regressions can appear before operators notice model drift.',
      score: 0.66,
      timestamp: '2026-03-06T00:00:00.000Z',
      keywords: ['api', 'channel', 'gap', 'monitoring']
    },
    {
      id: 'silent-drift-architecture',
      type: 'paper-theory',
      source: 'paper theory',
      domain: 'ai-safety',
      title: 'Model version uncertainty',
      content: 'Unreviewed version changes weaken reproducibility guarantees.',
      score: 0.74,
      timestamp: '2026-03-07T00:00:00.000Z',
      keywords: ['architecture', 'verification', 'gap', 'runtime']
    },
    {
      id: 'silent-drift-governance-2',
      type: 'internal-system',
      source: 'internal system',
      domain: 'ai-governance',
      title: 'Auditable scoring traces',
      content: 'Version-aware scoring traces reduce silent drift ambiguity.',
      score: 0.61,
      timestamp: '2026-03-08T00:00:00.000Z',
      keywords: ['audit', 'policy', 'gap', 'knowledge']
    }
  ];
}

function ingestSignals(engine, signals, referenceTime) {
  return signals.map((signal, index) => engine.ingestSignal(signal, {
    tick: index + 1,
    persist: false,
    referenceTime
  }));
}

function replaySignalsForEmergence(referenceTime) {
  const engine = mkEngine('emergence');
  const baseSignals = makeSignalBundle();
  let tick = 0;

  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < baseSignals.length; index += 1) {
      tick += 1;
      const base = baseSignals[index];
      const replayed = {
        ...base,
        id: `${base.id}-round-${round + 1}`,
        timestamp: `2026-03-0${index + round + 1}T00:00:00.000Z`
      };
      engine.ingestSignal(replayed, {
        tick,
        persist: false,
        referenceTime
      });
    }
  }

  return {
    engine,
    state: engine.getState(),
    signals: baseSignals,
    referenceTime,
    mappings: baseSignals.map(signal => mapSignalToCubeCell(signal, { referenceTime }))
  };
}

function collisionHasSpilloverOnlyCell(collision, state) {
  return (collision.cells || []).some(cellId => {
    const cell = state.cells[String(cellId)];
    return ((cell.directScore || 0) + (cell.evidenceScore || 0)) === 0 && (cell.spilloverScore || 0) > 0;
  });
}

function compactHandoff(packet) {
  return {
    gapId: packet.packetId,
    proposalType: 'gap_discovery',
    executionMode: packet.gapProposalHandoff.executionMode,
    destinationSystem: packet.gapProposalHandoff.destinationSystem,
    hypothesis: packet.hypothesis,
    verificationPlan: packet.verificationPlan,
    scoringTrace: packet.scoringTrace
  };
}

function containsForbiddenRuntimeDirective(value) {
  const raw = JSON.stringify(value).toLowerCase();
  return raw.includes('runtime command') ||
    raw.includes('bash ') ||
    raw.includes('sh -c') ||
    raw.includes('curl ') ||
    raw.includes('npm run') ||
    raw.includes('node ');
}

function runSignalIngestionTest() {
  section('1. SIGNAL INGESTION TEST');

  const engine = mkEngine('ingest');
  const referenceTime = '2026-03-10T00:00:00.000Z';
  const signals = makeSignalBundle();
  const mappings = signals.map(signal => mapSignalToCubeCell(signal, { referenceTime }));
  const ingestResults = ingestSignals(engine, signals, referenceTime);
  const state = engine.getState();
  const collisions = engine.detectCollisions({ tick: signals.length, persist: false });

  const observedMappings = mappings.map((mapping, index) => ({
    signalId: signals[index].id,
    domain: signals[index].domain,
    cellId: mapping.cellId,
    axes: mapping.axes
  }));
  console.log('Observed mappings:', JSON.stringify(observedMappings, null, 2));

  assert(
    'each signal maps to a deterministic cube cell',
    mappings.every((mapping, index) => mapping.cellId === normalizeSignal(signals[index], { referenceTime }).cellId),
    JSON.stringify(mappings.map(mapping => ({ signalId: mapping.signalId, cellId: mapping.cellId, parityConsistent: mapping.parityConsistent })), null, 2)
  );
  assert(
    'all domains remain distinct in the scenario',
    new Set(signals.map(signal => signal.domain)).size === 3,
    JSON.stringify(signals.map(signal => ({ id: signal.id, domain: signal.domain })), null, 2)
  );
  assert(
    'all signals appear in cube state',
    state.signals.length === signals.length,
    JSON.stringify(state.signals.map(signal => ({ id: signal.id, sourceType: signal.sourceType, cellId: signal.cellId })), null, 2)
  );

  const observedDeltas = ingestResults.map((result, index) => ({
    signalId: signals[index].id,
    scoreDelta: round(result.scoreDelta, 3)
  }));
  console.log('Observed score deltas:', JSON.stringify(observedDeltas, null, 2));

  assert('paper-theory uses 1.5x source weighting', round(ingestResults[0].scoreDelta, 2) === 0.45, JSON.stringify(observedDeltas[0], null, 2));
  assert('industry-report maps to existing 1.2x competitor weighting', round(ingestResults[1].scoreDelta, 2) === 0.36, JSON.stringify(observedDeltas[1], null, 2));
  assert('internal-system uses 0.7x source weighting', round(ingestResults[2].scoreDelta, 2) === 0.21, JSON.stringify(observedDeltas[2], null, 2));
  assert(
    'no spillover-only cell generates collisions',
    collisions.every(collision => !collisionHasSpilloverOnlyCell(collision, state)),
    JSON.stringify(collisions.map(collision => ({ id: collision.id, cells: collision.cells })), null, 2)
  );

  return {
    baseEngine: engine,
    signals,
    mappings,
    state,
    collisions,
    referenceTime
  };
}

function runCrossDomainCollisionTest(ctx) {
  section('2. CROSS-DOMAIN COLLISION TEST');

  const replay = replaySignalsForEmergence(ctx.referenceTime);
  const emergence = replay.engine.summarizeEmergence({ persist: false });
  const gravityCells = computeResearchGravity(replay.state, emergence);
  const safetyCell = replay.mappings[0].cellId;
  const opsCell = replay.mappings[1].cellId;
  const collision = (emergence.collisions || []).find(item => {
    const key = [...(item.cells || [])].sort((a, b) => a - b).join(',');
    const expected = [safetyCell, opsCell].sort((a, b) => a - b).join(',');
    return key === expected;
  });

  const gravityA = gravityCells.find(cell => cell.cell === safetyCell);
  const gravityB = gravityCells.find(cell => cell.cell === opsCell);
  const combinedGravity = round((gravityA ? gravityA.gravityScore : 0) + (gravityB ? gravityB.gravityScore : 0), 3);

  console.log('Observed collision:', JSON.stringify(collision, null, 2));
  console.log('Observed combined gravity:', combinedGravity);

  assert('collision pair exists between ai-safety and ai-operations cells', !!collision, JSON.stringify({ safetyCell, opsCell }, null, 2));
  assert('collision involves at least two sources', !!collision && (collision.sources || []).length >= 2, JSON.stringify(collision && collision.sources, null, 2));
  assert('combined gravity ≥ 0.5', combinedGravity >= 0.5, JSON.stringify({ combinedGravity }, null, 2));

  return {
    ...replay,
    emergence,
    gravityCells,
    combinedGravity
  };
}

function runGapDetectionTest(ctx) {
  section('3. GAP DETECTION TEST');

  const candidatesA = detectDiscoveryCandidates({
    gravityCells: ctx.gravityCells,
    emergenceSummary: ctx.emergence,
    cubeState: ctx.state
  });
  const candidatesB = detectDiscoveryCandidates({
    gravityCells: ctx.gravityCells,
    emergenceSummary: ctx.emergence,
    cubeState: ctx.state
  });

  console.log('Observed candidates:', JSON.stringify(candidatesA.map(candidate => ({
    id: candidate.id,
    type: candidate.type,
    score: candidate.candidateScore,
    cells: candidate.cells
  })), null, 2));

  const keys = candidatesA.map(candidate => candidate.cells.slice().sort((a, b) => a - b).join(','));
  const deterministicCells = JSON.stringify(candidatesA.map(candidate => candidate.cells)) === JSON.stringify(candidatesB.map(candidate => candidate.cells));

  assert('at least one discovery candidate exists', candidatesA.length > 0, JSON.stringify(candidatesA, null, 2));
  assert(
    'top candidate type remains a promoted discovery shape',
    candidatesA.length > 0 && ['collision_intersection', 'far_field_collision', 'gradient_ascent', 'cluster_peak'].includes(candidatesA[0].type),
    JSON.stringify(candidatesA[0] || null, null, 2)
  );
  assert('candidate score ≥ 0.3', candidatesA.length > 0 && candidatesA[0].candidateScore >= 0.3, JSON.stringify(candidatesA[0] || null, null, 2));
  assert('candidate cell set deterministic', deterministicCells, JSON.stringify({ first: candidatesA.map(c => c.cells), second: candidatesB.map(c => c.cells) }, null, 2));
  assert('duplicate candidates removed', new Set(keys).size === keys.length, JSON.stringify(keys, null, 2));

  return {
    ...ctx,
    candidates: candidatesA
  };
}

function runGapScoringTest(ctx) {
  section('4. GAP SCORING TEST');

  const enriched = enrichCandidates(ctx.candidates);
  const sourceScores = scoreSignalSources(ctx.state, ctx.emergence.collisions || [], ctx.state.emergenceEvents || []);
  const scored = scoreGapCandidates({
    candidates: enriched,
    cubeState: ctx.state,
    emergenceSummary: ctx.emergence,
    gravityCells: ctx.gravityCells,
    sourceScores
  });
  const top = scored[0];
  const scores = top.scores;
  const expectedTotal = round(
    (scores.novelty * 0.16) +
    (scores.collision * 0.18) +
    (scores.residue * 0.16) +
    (scores.gravity * 0.16) +
    (scores.evidence * 0.14) +
    (scores.entropy * 0.10) +
    (scores.serendipity * 0.10),
    3
  );
  const gapPipeline = runGapPipeline({
    tick: ctx.signals.length,
    timestamp: ctx.referenceTime,
    cubeState: ctx.state,
    emergenceSummary: ctx.emergence,
    gravityCells: ctx.gravityCells,
    candidates: ctx.candidates
  });
  const packet = gapPipeline.packets[0];

  console.log('Scoring trace of top candidate:', JSON.stringify(top.scoringTrace, null, 2));

  const formulaKeys = ['novelty', 'collision', 'residue', 'gravity', 'evidence', 'entropy', 'serendipity', 'total'];
  assert('scoringTrace includes all expected formulas', formulaKeys.every(key => Object.prototype.hasOwnProperty.call(top.scoringTrace.formulas || {}, key)), JSON.stringify(top.scoringTrace, null, 2));
  assert('each score is within [0,1]', Object.values(scores).every(value => value >= 0 && value <= 1), JSON.stringify(scores, null, 2));
  assert(
    'total score matches weighted formula within ±0.01',
    Math.abs(scores.total - expectedTotal) <= 0.01,
    JSON.stringify({ observed: scores.total, expected: expectedTotal }, null, 2)
  );
  assert('top candidate score ≥ 0.4', scores.total >= 0.4, JSON.stringify(scores, null, 2));
  assert('top candidate becomes a GapPacket', !!packet, JSON.stringify(packet && { packetId: packet.packetId, total: packet.scores.total }, null, 2));

  return {
    ...ctx,
    enriched,
    sourceScores,
    scored,
    topScored: top,
    packet
  };
}

function runHypothesisGenerationTest(ctx) {
  section('5. HYPOTHESIS GENERATION TEST');

  const hypothesis = buildHypothesis(ctx.topScored.candidate, ctx.topScored.scores);
  const verificationPlan = buildVerificationPlan(ctx.topScored.candidate, ctx.topScored.scores);
  const killTests = buildKillTests(ctx.topScored.candidate, ctx.topScored.scores);

  console.log('Generated hypothesis:', JSON.stringify(hypothesis, null, 2));

  assert(
    'falsifiable statement present',
    typeof hypothesis.statement === 'string' && hypothesis.statement.length > 20 && hypothesis.statement.includes('indicate'),
    JSON.stringify(hypothesis, null, 2)
  );
  assert('verificationPlan has exactly 3 steps', verificationPlan.length === 3, JSON.stringify(verificationPlan, null, 2));
  assert('killConditions has exactly 4 entries', killTests.length === 4, JSON.stringify(killTests, null, 2));
  assert(
    'hypothesis identifies a missing monitoring capability or control surface',
    /monitor|drift|control surface/i.test(JSON.stringify(hypothesis)),
    JSON.stringify(hypothesis, null, 2)
  );

  return {
    ...ctx,
    hypothesis,
    verificationPlan,
    killTests
  };
}

function runHandoffGovernanceTest(ctx) {
  section('6. HANDOFF GOVERNANCE TEST');

  const sanitized = compactHandoff(ctx.packet);
  console.log('Sanitized GapProposalHandoff packet:', JSON.stringify(sanitized, null, 2));

  assert('executionMode === "forbidden"', ctx.packet.gapProposalHandoff.executionMode === 'forbidden', JSON.stringify(ctx.packet.gapProposalHandoff.executionMode, null, 2));
  assert('proposalType === "gap_discovery"', sanitized.proposalType === 'gap_discovery', JSON.stringify(sanitized, null, 2));
  assert(
    'sanitized packet contains gapId, hypothesis, verificationPlan, and scoringTrace',
    !!sanitized.gapId && !!sanitized.hypothesis && Array.isArray(sanitized.verificationPlan) && !!sanitized.scoringTrace,
    JSON.stringify(sanitized, null, 2)
  );
  assert(
    'sanitized handoff contains no runtime directives',
    !containsForbiddenRuntimeDirective(sanitized),
    JSON.stringify(sanitized, null, 2)
  );

  return {
    ...ctx,
    sanitizedHandoff: sanitized
  };
}

function runSignalPrioritizationTest() {
  section('7. SIGNAL PRIORITIZATION TEST');

  const referenceTime = '2026-03-12T00:00:00.000Z';
  const signals = makePrioritizationSignals();
  const engineA = mkEngine('priority-a');
  const engineB = mkEngine('priority-b');

  ingestSignals(engineA, signals, referenceTime);
  ingestSignals(engineB, signals, referenceTime);

  const emergenceA = engineA.summarizeEmergence({ persist: false });
  const emergenceB = engineB.summarizeEmergence({ persist: false });
  const gravityA = computeResearchGravity(engineA.getState(), emergenceA);
  const gravityB = computeResearchGravity(engineB.getState(), emergenceB);
  const candidatesA = detectDiscoveryCandidates({
    gravityCells: gravityA,
    emergenceSummary: emergenceA,
    cubeState: engineA.getState()
  });
  const candidatesB = detectDiscoveryCandidates({
    gravityCells: gravityB,
    emergenceSummary: emergenceB,
    cubeState: engineB.getState()
  });
  const hintsA = emitDiscoveryHints(candidatesA);
  const hintsB = emitDiscoveryHints(candidatesB);

  console.log('Observed top discovery hints:', JSON.stringify(hintsA.map(hint => ({
    candidateId: hint.candidateId,
    candidateScore: hint.candidateScore,
    rank: hint.rank
  })), null, 2));

  const sortedTopFive = candidatesA
    .slice()
    .sort((a, b) => (b.candidateScore - a.candidateScore) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map(candidate => candidate.id);

  assert('event emitter returns maximum 5 discovery hints', hintsA.length <= 5, JSON.stringify({ hintCount: hintsA.length }, null, 2));
  assert(
    'top 5 by score are selected',
    JSON.stringify(hintsA.map(hint => hint.candidateId)) === JSON.stringify(sortedTopFive),
    JSON.stringify({ hints: hintsA.map(h => h.candidateId), expected: sortedTopFive }, null, 2)
  );
  assert(
    'selection is deterministic',
    JSON.stringify(hintsA.map(hint => hint.candidateId)) === JSON.stringify(hintsB.map(hint => hint.candidateId)),
    JSON.stringify({ first: hintsA.map(h => h.candidateId), second: hintsB.map(h => h.candidateId) }, null, 2)
  );
}

function run() {
  const ingestion = runSignalIngestionTest();
  const collision = runCrossDomainCollisionTest(ingestion);
  const detection = runGapDetectionTest(collision);
  const scoring = runGapScoringTest(detection);
  const hypothesis = runHypothesisGenerationTest(scoring);
  runHandoffGovernanceTest(hypothesis);
  runSignalPrioritizationTest();

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('[DONE] Silent model drift use-case test passed.');
}

run();
