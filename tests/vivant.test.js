'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  Vivant,
  TRENDS,
  FASEN,
  createNode,
  groei,
  vergeten,
  berekenPrecisie,
  berekenFase,
  classificeerBeweging
} = require('../src/bieb/vivant');

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
    console.error(`[FAIL] ${name} (actual=${actual}, expected=${expected})`);
    failed++;
  } else {
    console.log(`[PASS] ${name}`);
    passed++;
  }
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vivant-test-'));
}

function makeVivant(tmpDir) {
  return new Vivant({
    vivantDir: tmpDir,
    netwerkFile: path.join(tmpDir, 'netwerk.json'),
    bewegingFile: path.join(tmpDir, 'beweging.jsonl'),
    snapshotDir: path.join(tmpDir, 'snapshots')
  });
}

// ─── Test 1: Nieuw node start met gewicht 0.23 ──────────
(function test1() {
  const node = createNode('accountability', ['ai-governance', 'legal-ai']);
  assert('1a. Nieuw node gewicht = 0.23', node.gewicht === 0.23);
  assert('1b. Nieuw node aantalRuns = 1', node.aantalRuns === 1);
  assert('1c. Nieuw node stilteRuns = 0', node.stilteRuns === 0);
  assert('1d. Nieuw node trend = nauwer', node.trend === TRENDS.NAUWER);
  assert('1e. Nieuw node fase = opkomend', node.fase === FASEN.OPKOMEND);
  assert('1f. Nieuw node herlevingenCount = 0', node.herlevingenCount === 0);
  assert('1g. Nieuw node precisie > 0', node.precisie > 0);
  assert('1h. Nieuw node gewichtHistory = [0.23]', node.gewichtHistory.length === 1 && node.gewichtHistory[0] === 0.23);
})();

// ─── Test 2: Na 3 actieve runs: gewicht >= 0.47 ─────────
(function test2() {
  let node = createNode('explainability', ['ai-safety']);
  // node already has aantalRuns=1, apply groei 2 more times
  node = groei(node); // aantalRuns becomes 2
  node = groei(node); // aantalRuns becomes 3
  // basisGewicht = 1 - (1 / (1 + 3 * 0.3)) = 1 - (1/1.9) ≈ 0.474
  assert('2a. Na 3 actieve runs gewicht >= 0.47', node.gewicht >= 0.47);
  assert('2b. aantalRuns = 3', node.aantalRuns === 3);
  assert('2c. fase = actief', node.fase === FASEN.ACTIEF);
})();

// ─── Test 3: Na 5 stille runs: gewicht daalt ────────────
(function test3() {
  let node = createNode('validation', ['healthcare-ai']);
  node = groei(node); // aantalRuns=2, gewicht ~0.375
  node = groei(node); // aantalRuns=3, gewicht ~0.474
  const gewichtVoorStilte = node.gewicht;

  // 5 stille runs
  for (let i = 0; i < 5; i += 1) {
    node = vergeten(node);
  }

  assert('3a. Gewicht daalt na 5 stille runs', node.gewicht < gewichtVoorStilte);
  assert('3b. stilteRuns = 5', node.stilteRuns === 5);
  assert('3c. trend = vervaagt', node.trend === TRENDS.VERVAAGT);
})();

// ─── Test 4: Gewicht nooit onder 0.05 ───────────────────
(function test4() {
  let node = createNode('oversight', ['ai-governance']);
  // Apply many stilte runs
  for (let i = 0; i < 30; i += 1) {
    node = vergeten(node);
  }
  assert('4. Gewicht nooit onder 0.05', node.gewicht >= 0.05);
})();

// ─── Test 5: Herleving na 6 stille runs: skip bonus ─────
(function test5() {
  let node = createNode('consent', ['healthcare-ai']);
  node = groei(node); // aantalRuns=2
  node = groei(node); // aantalRuns=3

  // 6 stille runs
  for (let i = 0; i < 6; i += 1) {
    node = vergeten(node);
  }
  assert('5a. stilteRuns = 6 voor herleving', node.stilteRuns === 6);

  // Now revive
  node = groei(node);
  assert('5b. trend = herleeft na herleving', node.trend === TRENDS.HERLEEFT);
  assert('5c. skipConnectionBonus > 0', node.skipConnectionBonus > 0);
  assert('5d. herlevingenCount = 1', node.herlevingenCount === 1);
  assert('5e. fase = herleefd', node.fase === FASEN.HERLEEFD);
  // skipBonus = min(0.3, 6 * 0.04) = 0.24
  // basisGewicht = 1 - (1 / (1 + 4*0.3)) = 1 - (1/2.2) ≈ 0.545
  // gewicht = 0.545 + 0.24 = 0.785
  assert('5f. gewicht bevat skip bonus', node.gewicht > 0.7);
})();

// ─── Test 6: trend = "herleeft" bij herleving ───────────
(function test6() {
  let node = createNode('interpretability', ['ai-safety']);
  for (let i = 0; i < 8; i += 1) {
    node = vergeten(node);
  }
  node = groei(node);
  assert('6. trend = herleeft bij herleving na stilte > 5', node.trend === TRENDS.HERLEEFT);
})();

// ─── Test 7: fase = "slapend" bij gewicht < 0.2 + stilteRuns > 7 ──
(function test7() {
  let node = createNode('fairness', ['ai-governance']);
  // Many stilte runs to force weight below 0.2
  for (let i = 0; i < 15; i += 1) {
    node = vergeten(node);
  }
  assert('7a. fase = slapend na langdurige stilte', node.fase === FASEN.SLAPEND);
  assert('7b. gewicht < 0.2', node.gewicht < 0.2);
  assert('7c. stilteRuns > 7', node.stilteRuns > 7);
})();

// ─── Test 8: fase = "gevestigd" bij aantalRuns > 10 ─────
(function test8() {
  let node = createNode('transparency', ['ai-governance']);
  // Need to get to > 10 runs total
  for (let i = 0; i < 10; i += 1) {
    node = groei(node);
  }
  // node was created with aantalRuns=1, groei adds 1 each time = 11
  assert('8a. fase = gevestigd bij aantalRuns > 10', node.fase === FASEN.GEVESTIGD);
  assert('8b. aantalRuns = 11', node.aantalRuns === 11);
})();

// ─── Test 9: precisie stijgt monotoon bij actieve runs ──
(function test9() {
  let node = createNode('robustness', ['ai-safety']);
  const precisies = [node.precisie];

  for (let i = 0; i < 8; i += 1) {
    node = groei(node);
    precisies.push(node.precisie);
  }

  let monotoon = true;
  for (let i = 1; i < precisies.length; i += 1) {
    if (precisies[i] < precisies[i - 1] - 0.001) {
      monotoon = false;
      break;
    }
  }
  assert('9. precisie stijgt monotoon bij actieve runs', monotoon);
})();

// ─── Test 10: precisie daalt bij stilte ─────────────────
(function test10() {
  let node = createNode('auditability', ['legal-ai']);
  node = groei(node);
  node = groei(node);
  const precisiePeak = node.precisie;

  for (let i = 0; i < 6; i += 1) {
    node = vergeten(node);
  }
  assert('10. precisie daalt bij stilte', node.precisie < precisiePeak);
})();

// ─── Test 11: herlevingenCount verhoogt bij herleving ───
(function test11() {
  let node = createNode('privacy', ['healthcare-ai']);
  node = groei(node);

  // First revival
  for (let i = 0; i < 7; i += 1) node = vergeten(node);
  node = groei(node);
  assert('11a. herlevingenCount = 1 na eerste herleving', node.herlevingenCount === 1);

  // Second revival
  for (let i = 0; i < 7; i += 1) node = vergeten(node);
  node = groei(node);
  assert('11b. herlevingenCount = 2 na tweede herleving', node.herlevingenCount === 2);
})();

// ─── Test 12: netwerk snapshot bevat alle vereiste velden ──
(function test12() {
  const tmpDir = makeTmpDir();
  const vivant = makeVivant(tmpDir);

  const snapshot = vivant.updateNetwerk([
    { patroon: 'explainability', domeinen: ['ai-safety', 'ai-governance'] },
    { patroon: 'consent', domeinen: ['healthcare-ai'] }
  ], 'test-run-1');

  assert('12a. snapshot heeft runId', snapshot.runId === 'test-run-1');
  assert('12b. snapshot heeft timestamp', typeof snapshot.timestamp === 'string');
  assert('12c. snapshot heeft actieveNodes', Number.isFinite(snapshot.actieveNodes));
  assert('12d. snapshot heeft slapendeNodes', Number.isFinite(snapshot.slapendeNodes));
  assert('12e. snapshot heeft herleefdeNodes', Number.isFinite(snapshot.herleefdeNodes));
  assert('12f. snapshot heeft gemiddeldGewicht', Number.isFinite(snapshot.gemiddeldGewicht));
  assert('12g. snapshot heeft gemiddeldePrecisie', Number.isFinite(snapshot.gemiddeldePrecisie));
  assert('12h. snapshot heeft sterksteNode', snapshot.sterksteNode != null);
  assert('12i. sterksteNode heeft patroon', typeof snapshot.sterksteNode.patroon === 'string');
  assert('12j. sterksteNode heeft precisie', Number.isFinite(snapshot.sterksteNode.precisie));
  assert('12k. snapshot heeft beweging', ['groeiend', 'stabiel', 'kalibrerend'].includes(snapshot.beweging));
  assert('12l. actieveNodes = 2', snapshot.actieveNodes === 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 13: bewegingslog wordt correct aangevuld per run ──
(function test13() {
  const tmpDir = makeTmpDir();
  const vivant = makeVivant(tmpDir);

  vivant.updateNetwerk([{ patroon: 'accountability', domeinen: ['legal-ai'] }], 'run-1');
  vivant.updateNetwerk([{ patroon: 'accountability', domeinen: ['legal-ai'] }, { patroon: 'fairness', domeinen: ['ai-governance'] }], 'run-2');

  const history = vivant.bewegingHistory(10);
  assert('13a. bewegingslog bevat 2 entries', history.length === 2);
  assert('13b. eerste entry runId = run-1', history[0].runId === 'run-1');
  assert('13c. tweede entry runId = run-2', history[1].runId === 'run-2');
  assert('13d. nodeUpdates zijn arrays', Array.isArray(history[0].nodeUpdates));
  assert('13e. tweede run heeft nieuweNodes', (history[1].nieuweNodes || []).includes('fairness'));
  assert('13f. snapshot is meegeleverd', history[0].snapshot != null);

  // Verify snapshots directory
  const snapshotFiles = fs.readdirSync(path.join(tmpDir, 'snapshots'));
  assert('13g. snapshot bestanden aangemaakt', snapshotFiles.length === 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 14: updateNetwerk() verwerkt zowel groei als vergeten ──
(function test14() {
  const tmpDir = makeTmpDir();
  const vivant = makeVivant(tmpDir);

  // Run 1: two active patterns
  vivant.updateNetwerk([
    { patroon: 'explainability', domeinen: ['ai-safety'] },
    { patroon: 'consent', domeinen: ['healthcare-ai'] }
  ], 'run-1');

  // Run 2: only explainability active, consent should decay
  const snapshot2 = vivant.updateNetwerk([
    { patroon: 'explainability', domeinen: ['ai-safety'] }
  ], 'run-2');

  const explainNode = vivant.getNode('explainability');
  const consentNode = vivant.getNode('consent');

  assert('14a. explainability aantalRuns = 2', explainNode.aantalRuns === 2);
  assert('14b. explainability stilteRuns = 0', explainNode.stilteRuns === 0);
  assert('14c. consent stilteRuns = 1', consentNode.stilteRuns === 1);
  assert('14d. consent gewicht nog stabiel (stilte < 4)', consentNode.gewicht === 0.23);

  // Run 3-7: only explainability, consent decays further
  for (let i = 3; i <= 7; i += 1) {
    vivant.updateNetwerk([{ patroon: 'explainability', domeinen: ['ai-safety'] }], `run-${i}`);
  }

  const consentAfter = vivant.getNode('consent');
  assert('14e. consent gewicht gedaald na meerdere stille runs', consentAfter.gewicht < 0.23);
  assert('14f. consent trend = vervaagt', consentAfter.trend === TRENDS.VERVAAGT);

  // Run 8: consent comes back!
  const snapshot8 = vivant.updateNetwerk([
    { patroon: 'explainability', domeinen: ['ai-safety'] },
    { patroon: 'consent', domeinen: ['healthcare-ai'] }
  ], 'run-8');

  const consentRevived = vivant.getNode('consent');
  assert('14g. consent herleefd na stilte', consentRevived.trend === TRENDS.HERLEEFT);
  assert('14h. consent herlevingenCount = 1', consentRevived.herlevingenCount === 1);
  assert('14i. consent skipConnectionBonus > 0', consentRevived.skipConnectionBonus > 0);

  // Verify persistence: new instance should load same data
  const vivant2 = makeVivant(tmpDir);
  const reloaded = vivant2.getNode('consent');
  assert('14j. data persisted and reloaded', reloaded != null && reloaded.herlevingenCount === 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Summary ──
console.log('\n' + '\u2500'.repeat(50));
console.log(`VIVANT tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
