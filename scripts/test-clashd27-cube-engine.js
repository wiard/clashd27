const fs = require('fs');
const path = require('path');
const {
  Clashd27CubeEngine,
  normalizeSignal,
  coordsToCell,
  ingestSignal: ingestSignalFn,
  updateResidue: updateResidueFn,
  detectCollisions: detectCollisionsFn,
  summarizeEmergence: summarizeEmergenceFn
} = require('../lib/clashd27-cube-engine');

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    process.exit(1);
  }
  console.log(`[PASS] ${name}`);
}

function assertNear(name, actual, expected, eps = 1e-6) {
  const ok = Math.abs(actual - expected) <= eps;
  assert(`${name} (actual=${actual}, expected=${expected})`, ok);
}

function tmpFile(label) {
  return path.join('/tmp', `clashd27-cube-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const f = tmpFile(label);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return new Clashd27CubeEngine({ stateFile: f, emergenceThreshold: 0.6 });
}

function testMapping() {
  const oldPublishedTs = '2025-12-01T00:00:00.000Z';
  const curPublishedTs = '2026-02-20T00:00:00.000Z';
  const detectedTs = '2026-03-04T00:00:00.000Z';

  const s1 = normalizeSignal({
    id: 'm1',
    source: 'github competitor',
    timestamp: detectedTs,
    publishedAtIso: oldPublishedTs,
    keywords: ['trust', 'consent']
  });
  assert('Mapping WHAT trust-model', s1.what === 'trust-model');
  assert('Mapping WHERE external', s1.where === 'external');
  assert('Mapping TIME historical', s1.time === 'historical');
  assert('Mapping cell id for trust/external/historical', s1.cellId === coordsToCell(0, 1, 0));

  const s2 = normalizeSignal({
    id: 'm2',
    source: 'paper/theory',
    timestamp: detectedTs,
    publishedAtIso: curPublishedTs,
    keywords: ['api', 'channel']
  });
  assert('Mapping WHAT surface', s2.what === 'surface');
  assert('Mapping WHERE engine', s2.where === 'engine');
  assert('Mapping TIME current', s2.time === 'current');
  assert('Mapping cell id for surface/engine/current', s2.cellId === coordsToCell(1, 2, 1));

  const s3 = normalizeSignal({
    id: 'm3',
    source: 'internal system',
    timestamp: detectedTs,
    keywords: ['audit', 'gap']
  });
  assert('Gap/trend/anomaly maps to emerging', s3.time === 'emerging');
  assert('Mapping WHAT architecture', s3.what === 'architecture');
}

function testResidueAndDecay() {
  const engine = mkEngine('residue');
  const ref = '2026-03-20T00:00:00.000Z';
  engine.updateResidue(10, { persist: false });

  const baseSignal = {
    source: 'internal system',
    keywords: ['audit'],
    trustLevel: 'high',
    surfaceType: 'daemon',
    architectureAspect: 'policy'
  };

  const r1 = engine.ingestSignal({
    id: 'r1',
    timestamp: '2026-03-19T00:00:00.000Z',
    ...baseSignal
  }, { tick: 10, persist: false, referenceTime: ref });
  assertNear('Score +0.3 on first interaction', r1.cell.score, 0.3, 1e-9);

  const r2 = engine.ingestSignal({
    id: 'r2',
    source: 'ai agent skills',
    timestamp: '2026-03-01T00:00:00.000Z',
    keywords: ['audit'],
    trustLevel: 'high',
    surfaceType: 'skill',
    architectureAspect: 'policy'
  }, { tick: 11, persist: false, referenceTime: ref });
  // Tick 11 decays tick-10 score once before applying delta.
  assertNear('Score adds source-diff and far-apart bonuses', r2.cell.score, 0.7985, 1e-9);

  const r3 = engine.ingestSignal({
    id: 'r3',
    source: 'internal system',
    timestamp: '2026-03-02T00:00:00.000Z',
    keywords: ['audit'],
    trustLevel: 'high',
    surfaceType: 'daemon',
    architectureAspect: 'policy'
  }, { tick: 12, persist: false, referenceTime: ref });
  assertNear('Score capped at 1.0', r3.cell.score, 1.0, 1e-9);
  assert('Interaction count tracked', r3.cell.interactionCount === 3);
  assert('Peer diversity tracked', r3.cell.peerDiversity === 2);
  assert('Time spread tracked across ticks', r3.cell.timeSpread === 3);
  assert('Formula residue positive', r3.cell.formulaResidue > 0);

  const gapSignal = engine.ingestSignal({
    id: 'r4-gap',
    source: 'internal system',
    timestamp: '2026-03-03T00:00:00.000Z',
    keywords: ['audit', 'gap'],
    trustLevel: 'high',
    surfaceType: 'daemon',
    architectureAspect: 'policy'
  }, { tick: 12, persist: false, referenceTime: ref });
  assertNear('Gap-flagged signal adds +0.2 bonus', gapSignal.scoreDelta, 0.5, 1e-9);

  engine.updateResidue(20, { persist: false });
  const decayedCell = engine.getState().cells[String(r3.signal.cellId)];
  const expected = Math.round((1.0 * Math.pow(0.995, 8)) * 1e6) / 1e6;
  assertNear('Decay 0.995 per tick', decayedCell.score, expected, 1e-6);
}

function testCollisionDetection() {
  const engine = mkEngine('collision');
  const ref = '2026-03-20T00:00:00.000Z';

  // Cell 9: trust-model/internal/current
  engine.ingestSignal({
    id: 'c9-1',
    source: 'internal system',
    timestamp: '2026-03-10T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'c9-2',
    source: 'internal system',
    timestamp: '2026-03-11T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 2, persist: false, referenceTime: ref });

  // Cell 10: surface/internal/current (adjacent to 9)
  engine.ingestSignal({
    id: 'c10-1',
    source: 'ai agent skills',
    timestamp: '2026-03-11T00:00:00.000Z',
    keywords: ['api']
  }, { tick: 2, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'c10-2',
    source: 'ai agent skills',
    timestamp: '2026-03-12T00:00:00.000Z',
    keywords: ['api']
  }, { tick: 3, persist: false, referenceTime: ref });

  const collisions = engine.detectCollisions({ tick: 3, persist: false });
  assert('At least one meaningful collision detected', collisions.length >= 1);
  const target = collisions.find(c =>
    (c.cells[0] === 9 && c.cells[1] === 10) || (c.cells[0] === 10 && c.cells[1] === 9)
  );
  assert('Collision between adjacent cells 9 and 10', !!target);
  assert('Collision score threshold passed', target.combinedScore > 0.7);
  assert('Collision has >=2 sources', target.sources.length >= 2);
  assert('Collision spans >=3 ticks', target.ticks.length >= 3);
}

function testClustersAndGradients() {
  const engine = mkEngine('emergence');
  const ref = '2026-03-25T00:00:00.000Z';

  // Build increasing chain: 9 -> 10 -> 11
  engine.ingestSignal({
    id: 'g9-1',
    source: 'internal system',
    timestamp: '2026-03-20T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref }); // 0.3

  engine.ingestSignal({
    id: 'g10-1',
    source: 'internal system',
    timestamp: '2026-03-20T00:00:00.000Z',
    keywords: ['api']
  }, { tick: 1, persist: false, referenceTime: ref }); // 0.3
  engine.ingestSignal({
    id: 'g10-2',
    source: 'internal system',
    timestamp: '2026-03-21T00:00:00.000Z',
    keywords: ['api']
  }, { tick: 2, persist: false, referenceTime: ref }); // 0.6

  engine.ingestSignal({
    id: 'g11-1',
    source: 'internal system',
    timestamp: '2026-03-20T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 1, persist: false, referenceTime: ref }); // 0.3
  engine.ingestSignal({
    id: 'g11-2',
    source: 'internal system',
    timestamp: '2026-03-21T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 2, persist: false, referenceTime: ref }); // 0.6
  engine.ingestSignal({
    id: 'g11-3',
    source: 'internal system',
    timestamp: '2026-03-22T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 3, persist: false, referenceTime: ref }); // 0.9

  const snapshot = engine.summarizeEmergence({ persist: false });
  assert('Cluster detected', snapshot.clusters.length >= 1);
  assert('Gradient detected', snapshot.gradients.length >= 1);
  const gradientContainsChain = snapshot.gradients.some(g =>
    g.path.includes(9) && g.path.includes(10) && g.path.includes(11)
  );
  assert('Gradient includes 9->10->11 chain', gradientContainsChain);
  const ascii = engine.renderAscii(snapshot);
  assert('ASCII renderer includes z layers', ascii.includes('z=0') && ascii.includes('z=1') && ascii.includes('z=2'));
}

function testExposedFunctions() {
  const engine = mkEngine('exports');
  updateResidueFn(engine, 5, { persist: false });
  ingestSignalFn(engine, {
    id: 'x1',
    source: 'internal system',
    timestamp: '2026-03-20T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 5, persist: false, referenceTime: '2026-03-25T00:00:00.000Z' });
  const collisions = detectCollisionsFn(engine, { tick: 5, persist: false });
  const summary = summarizeEmergenceFn(engine, { tick: 5, persist: false });
  assert('Exported detectCollisions returns array', Array.isArray(collisions));
  assert('Exported summarizeEmergence returns heatmap', Array.isArray(summary.heatmap));
}

function run() {
  testMapping();
  testResidueAndDecay();
  testCollisionDetection();
  testClustersAndGradients();
  testExposedFunctions();
  console.log('[DONE] CLASHD27 cube engine tests passed.');
}

run();
