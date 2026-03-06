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
  assert('ScoreDelta is 0.3 base', r1.scoreDelta === 0.3);

  const r2 = engine.ingestSignal({
    id: 'r2',
    source: 'ai agent skills',
    timestamp: '2026-03-01T00:00:00.000Z',
    keywords: ['audit'],
    trustLevel: 'high',
    surfaceType: 'skill',
    architectureAspect: 'policy'
  }, { tick: 11, persist: false, referenceTime: ref });
  // Tick 11 triggers decay + gravity + spillover before applying the +0.5 delta.
  // Score should be > 0.7 (base decay 0.2985 + delta 0.5 = 0.7985 + gravity/spillover adjustments)
  assert('Score includes source-diff and far-apart bonuses', r2.cell.score > 0.79);
  assertNear('ScoreDelta includes source+far-apart bonuses', r2.scoreDelta, 0.5, 1e-9);

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

  engine.updateResidue(100, { persist: false });
  const decayedCell = engine.getState().cells[String(r3.signal.cellId)];
  // After many ticks of decay, gravity can't sustain the cell at 1.0 because
  // neighbors also decay. Score should drop meaningfully.
  assert('Decay reduces score below 1.0', decayedCell.score < 1.0);
  assert('Decay keeps some residual score', decayedCell.score > 0);
  assert('Momentum tracked after decay', decayedCell.momentumHistory.length > 0);
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

function testGravityAndSpillover() {
  const engine = mkEngine('gravity');
  const ref = '2026-03-20T00:00:00.000Z';

  // Ingest a strong signal into cell 13 (center of cube — has 26 neighbors by Manhattan,
  // but only 6 face-adjacent). Spillover should affect face neighbors.
  engine.ingestSignal({
    id: 'grav-1',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 1, persist: false, referenceTime: ref });

  const primaryCellId = normalizeSignal({
    id: 'grav-1', source: 'internal system', timestamp: '2026-03-19T00:00:00.000Z', keywords: ['audit']
  }).cellId;

  // Check spillover: face neighbors should have > 0 score
  const { manhattanDistance: md } = require('../lib/clashd27-cube-engine');
  let spilloverFound = false;
  for (let i = 0; i < 27; i += 1) {
    if (i === primaryCellId) continue;
    if (md(primaryCellId, i) === 1) {
      const neighbor = engine.getState().cells[String(i)];
      if (neighbor.score > 0) {
        spilloverFound = true;
        break;
      }
    }
  }
  assert('Spillover reaches face neighbors', spilloverFound);

  // Now advance time to trigger gravity
  engine.ingestSignal({
    id: 'grav-2',
    source: 'ai agent skills',
    timestamp: '2026-03-01T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 2, persist: false, referenceTime: ref });

  engine.updateResidue(5, { persist: false });

  // After gravity: primary cell should have non-zero gravityMass
  const primaryCell = engine.getState().cells[String(primaryCellId)];
  assert('Gravity mass computed', primaryCell.gravityMass > 0);

  // After updateResidue, momentum should be tracked
  assert('Momentum tracked after update', primaryCell.momentumHistory.length > 0);
  assert('Momentum is non-zero after decay+gravity', primaryCell.momentum !== 0);
}

function testMomentumSnapshot() {
  const engine = mkEngine('momentum');
  const ref = '2026-03-20T00:00:00.000Z';

  engine.ingestSignal({
    id: 'mom-1',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });

  engine.updateResidue(3, { persist: false });

  const momentumSnap = engine.computeMomentumSnapshot();
  assert('Momentum snapshot returns array', Array.isArray(momentumSnap));
  assert('Momentum snapshot has entries', momentumSnap.length > 0);
  const entry = momentumSnap[0];
  assert('Momentum entry has trend', entry.trend === 'heating' || entry.trend === 'cooling');
  assert('Momentum entry has sustained value', Number.isFinite(entry.sustained));
}

function testGravityField() {
  const engine = mkEngine('gravfield');
  const ref = '2026-03-20T00:00:00.000Z';

  // Build a hot cell
  engine.ingestSignal({
    id: 'gf-1',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'gf-2',
    source: 'ai agent skills',
    timestamp: '2026-03-01T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 2, persist: false, referenceTime: ref });

  engine.updateResidue(3, { persist: false });

  const wells = engine.computeGravityField();
  assert('Gravity field returns array', Array.isArray(wells));
  assert('Gravity field has wells', wells.length > 0);
  const topWell = wells[0];
  assert('Top well has cellId', Number.isFinite(topWell.cellId));
  assert('Top well has pullStrength', Number.isFinite(topWell.pullStrength));
  assert('Top well has avgNeighborScore', Number.isFinite(topWell.avgNeighborScore));
}

function testOptimalRoutes() {
  const engine = mkEngine('routes');
  const ref = '2026-03-20T00:00:00.000Z';

  // Create a gradient: cells 9, 10, 11 with increasing scores
  engine.ingestSignal({
    id: 'rt-9',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });

  engine.ingestSignal({
    id: 'rt-10a',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['api']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'rt-10b',
    source: 'internal system',
    timestamp: '2026-03-20T00:00:00.000Z',
    keywords: ['api']
  }, { tick: 2, persist: false, referenceTime: ref });

  engine.ingestSignal({
    id: 'rt-11a',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'rt-11b',
    source: 'internal system',
    timestamp: '2026-03-20T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 2, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'rt-11c',
    source: 'internal system',
    timestamp: '2026-03-21T00:00:00.000Z',
    keywords: ['audit']
  }, { tick: 3, persist: false, referenceTime: ref });

  const routes = engine.computeOptimalRoutes(9, { maxDepth: 4, topK: 3 });
  assert('Routes returns array', Array.isArray(routes));
  assert('At least one route found', routes.length >= 1);
  const best = routes[0];
  assert('Best route starts at cell 9', best.path[0] === 9);
  assert('Best route has totalScore', best.totalScore > 0);
  assert('Best route has avgScore', best.avgScore > 0);
  assert('Best route has id', best.id.startsWith('route-'));
}

function testTopology() {
  const engine = mkEngine('topology');
  const ref = '2026-03-20T00:00:00.000Z';

  // Empty field should be dormant
  const emptyTopo = engine.computeTopology();
  assert('Empty field is dormant', emptyTopo.phase === 'dormant');
  assertNear('Empty field has zero total score', emptyTopo.totalScore, 0, 1e-9);
  assert('Empty field has zero active cells', emptyTopo.activeCells === 0);

  // Add signals to create a focused field
  engine.ingestSignal({
    id: 'topo-1',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'topo-2',
    source: 'ai agent skills',
    timestamp: '2026-03-01T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 2, persist: false, referenceTime: ref });
  engine.ingestSignal({
    id: 'topo-3',
    source: 'internal system',
    timestamp: '2026-03-18T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 3, persist: false, referenceTime: ref });

  const topo = engine.computeTopology();
  assert('Active field has positive total score', topo.totalScore > 0);
  assert('Active field has active cells', topo.activeCells > 0);
  assert('Phase is not dormant', topo.phase !== 'dormant');
  assert('Dominant WHAT axis is trust-model', topo.dominantAxes.what.axis === 'trust-model');
  assert('Layer energy has three layers', Number.isFinite(topo.layerEnergy.floor));
  assert('Concentration is between 0 and 1', topo.concentration >= 0 && topo.concentration <= 1);
  assert('Entropy is between 0 and 1', topo.normalizedEntropy >= 0 && topo.normalizedEntropy <= 1);
  assert('Variance is non-negative', topo.variance >= 0);

  // Phase history should be recorded after updateResidue
  engine.updateResidue(5, { persist: false });
  const history = engine.getPhaseHistory();
  assert('Phase history recorded', history.length > 0);
  const latest = history[history.length - 1];
  assert('Phase history entry has tick', Number.isFinite(latest.tick));
  assert('Phase history entry has phase', typeof latest.phase === 'string');
  assert('Phase history entry has concentration', Number.isFinite(latest.concentration));
}

function testEmergenceIncludesGravityAndMomentum() {
  const engine = mkEngine('full-emergence');
  const ref = '2026-03-20T00:00:00.000Z';

  engine.ingestSignal({
    id: 'fe-1',
    source: 'internal system',
    timestamp: '2026-03-19T00:00:00.000Z',
    keywords: ['trust']
  }, { tick: 1, persist: false, referenceTime: ref });
  engine.updateResidue(3, { persist: false });

  const snapshot = engine.summarizeEmergence({ persist: false });
  assert('Emergence includes gravityWells', Array.isArray(snapshot.gravityWells));
  assert('Emergence includes momentum', Array.isArray(snapshot.momentum));
  assert('Emergence includes optimalRoutes', Array.isArray(snapshot.optimalRoutes));
  assert('Emergence includes topology', snapshot.topology && typeof snapshot.topology.phase === 'string');

  const ascii = engine.renderAscii(snapshot);
  assert('ASCII includes gravity legend', ascii.includes('G gravity'));
  assert('ASCII includes heating legend', ascii.includes('^ heating'));
  assert('ASCII includes phase info', ascii.includes('Phase:'));
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
  testGravityAndSpillover();
  testMomentumSnapshot();
  testGravityField();
  testOptimalRoutes();
  testTopology();
  testEmergenceIncludesGravityAndMomentum();
  testExposedFunctions();
  console.log('[DONE] CLASHD27 cube engine tests passed.');
}

run();
