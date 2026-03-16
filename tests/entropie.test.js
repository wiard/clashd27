'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  berekenShannonEntropie,
  normaliseerEntropie,
  classificeerEntropieFase,
  extractBuurSignalen,
  meetEntropie,
  slaEntropieOp,
  laadEntropieHistory,
  LOG2_6,
  BUUR_INDICES
} = require('../src/bieb/entropie');
const {
  detecteerCollisions,
  verwerkPulse,
  verwerkCel14,
  DIAGONALE_PAREN,
  VLAKKEN
} = require('../src/bieb/cel14');
const {
  ConfiguratieMemorie,
  configuratieFingerprint,
  softmax
} = require('../src/bieb/configuratie-memorie');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'entropie-test-'));
}

// Create a 27-cell array for testing
function makeCells(overrides = {}) {
  const cells = [];
  for (let z = 0; z < 3; z += 1) {
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        const idx = z * 9 + y * 3 + x;
        cells.push({
          label: overrides[idx] ? overrides[idx].label : `concept-${idx}`,
          domain: overrides[idx] ? overrides[idx].domain : `domain-${idx}`,
          score: overrides[idx] ? (overrides[idx].score || 0.5) : 0.5,
          z, row: y, column: x
        });
      }
    }
  }
  return cells;
}

// ─── Test 1: H = 0 bij emergentie ───────────────────────
(function test1() {
  // All 6 neighbors same pattern → H = 0
  const patronen = ['ai-governance', 'ai-governance', 'ai-governance', 'ai-governance', 'ai-governance', 'ai-governance'];
  const H = berekenShannonEntropie(patronen);
  assert('1. H = 0 bij emergentie (alle buren zelfde patroon)', H === 0);
})();

// ─── Test 2: H = log2(6) bij maximale diversiteit ───────
(function test2() {
  const patronen = ['ai-governance', 'ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai', 'finance-ai'];
  const H = berekenShannonEntropie(patronen);
  assertNear('2. H = log2(6) bij maximale diversiteit', H, LOG2_6, 0.01);
})();

// ─── Test 3: Pulse gevuurd bij H_norm > 0.85 ────────────
(function test3() {
  // 6 different domains → H = log2(6), norm = 1.0 > 0.85
  const overrides = {};
  const domains = ['ai-governance', 'ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai', 'finance-ai'];
  BUUR_INDICES.forEach((idx, i) => {
    overrides[idx] = { label: domains[i], domain: domains[i], score: 0.6 };
  });
  const cells = makeCells(overrides);
  const meting = meetEntropie(cells, 'test-run-3');
  assert('3a. Pulse gevuurd bij H_norm > 0.85', meting.pulsGevuurd === true);
  assert('3b. Fase is pulse', meting.fase === 'pulse');
  assert('3c. genormaliseerd > 0.85', meting.genormaliseerd > 0.85);
})();

// ─── Test 4: Geen pulse bij H_norm < 0.85 ───────────────
(function test4() {
  // 4 same + 2 different → lower entropy
  const overrides = {};
  const domains = ['ai-governance', 'ai-governance', 'ai-governance', 'ai-governance', 'ai-safety', 'healthcare-ai'];
  BUUR_INDICES.forEach((idx, i) => {
    overrides[idx] = { label: domains[i], domain: domains[i], score: 0.5 };
  });
  const cells = makeCells(overrides);
  const meting = meetEntropie(cells, 'test-run-4');
  assert('4a. Geen pulse bij lage entropie', meting.pulsGevuurd === false);
  assert('4b. H_norm < 0.85', meting.genormaliseerd < 0.85);
})();

// ─── Test 5: Diagonale resonantie × 1.8 ─────────────────
(function test5() {
  // Set opposing pair to same domain
  const overrides = {};
  const pair = DIAGONALE_PAREN[0]; // 4 ↔ 22
  overrides[pair.a] = { label: 'accountability', domain: 'ai-governance', score: 0.7 };
  overrides[pair.b] = { label: 'accountability', domain: 'ai-governance', score: 0.7 };
  // Other neighbors are different
  const otherBuren = BUUR_INDICES.filter((i) => i !== pair.a && i !== pair.b);
  const domains = ['ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai'];
  otherBuren.forEach((idx, i) => {
    overrides[idx] = { label: domains[i], domain: domains[i], score: 0.5 };
  });
  const cells = makeCells(overrides);
  const result = detecteerCollisions(cells, 'test-run-5');
  const resonantie = result.collisions.find((c) => c.type === 'resonantie');
  assert('5a. Diagonale resonantie gedetecteerd', resonantie != null);
  // Base sterkte = 0.4 + 0.7*0.15 = 0.505, × 1.8 = 0.909
  assert('5b. Sterkte bevat × 1.8 bonus', resonantie && resonantie.sterkte > 0.8);
})();

// ─── Test 6: Vlaktransformatie × 2.0 ────────────────────
(function test6() {
  // Put same domain in cells across 2+ planes
  const overrides = {};
  // XY plane cells (excl 13): 3,4,5,12,14,21,22,23
  // XZ plane cells (excl 13): 1,4,7,10,16,19,22,25
  // Overlap: 4, 22 (both in XY and XZ)
  overrides[3] = { label: 'test', domain: 'ai-safety', score: 0.6 };
  overrides[4] = { label: 'test', domain: 'ai-safety', score: 0.6 };
  overrides[1] = { label: 'test', domain: 'ai-safety', score: 0.6 };
  overrides[7] = { label: 'test', domain: 'ai-safety', score: 0.6 };
  const cells = makeCells(overrides);
  const result = detecteerCollisions(cells, 'test-run-6');
  const vlak = result.collisions.find((c) => c.type === 'vlak');
  assert('6a. Vlaktransformatie gedetecteerd', vlak != null);
  assert('6b. Sterkte bevat × 2.0 bonus', vlak && vlak.sterkte >= 1.0);
})();

// ─── Test 7: Emergentie precisie 0.85 ───────────────────
(function test7() {
  const overrides = {};
  BUUR_INDICES.forEach((idx) => {
    overrides[idx] = { label: 'accountability', domain: 'ai-governance', score: 0.8 };
  });
  const cells = makeCells(overrides);
  const result = detecteerCollisions(cells, 'test-run-7');
  const emergentie = result.collisions.find((c) => c.type === 'emergentie');
  assert('7a. Emergentie gedetecteerd', emergentie != null);
  assert('7b. Emergentie sterkte = 0.85', emergentie && emergentie.sterkte === 0.85);
})();

// ─── Test 8: Configuratiememorie update bij pulse: +0.30 ─
(function test8() {
  const tmpDir = makeTmpDir();
  const memorie = new ConfiguratieMemorie({ vivantDir: tmpDir, memorieFile: path.join(tmpDir, 'conf.json') });
  const patronen = ['a', 'b', 'c', 'd', 'e', 'f'];
  memorie.registreer(patronen, 'run-1');
  const voor = memorie.getConfiguratie(patronen);
  assert('8a. Initieel gewicht = 0', voor.gewicht === 0);

  memorie.updatePulse(patronen);
  const na = memorie.getConfiguratie(patronen);
  assertNear('8b. Na pulse gewicht +0.30', na.gewicht, 0.30, 0.01);
  assert('8c. pulsesCount = 1', na.pulsesCount === 1);
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 9: Configuratiememorie bevestiging: +0.15 ──────
(function test9() {
  const tmpDir = makeTmpDir();
  const memorie = new ConfiguratieMemorie({ vivantDir: tmpDir, memorieFile: path.join(tmpDir, 'conf.json') });
  const patronen = ['x', 'y', 'z', 'a', 'b', 'c'];
  memorie.registreer(patronen, 'run-1');
  memorie.updateBevestiging(patronen);
  const na = memorie.getConfiguratie(patronen);
  assertNear('9. Na bevestiging gewicht +0.15', na.gewicht, 0.15, 0.01);
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 10: Configuratiememorie stilte: -0.05 ──────────
(function test10() {
  const tmpDir = makeTmpDir();
  const memorie = new ConfiguratieMemorie({ vivantDir: tmpDir, memorieFile: path.join(tmpDir, 'conf.json') });
  const patronen = ['p', 'q', 'r', 's', 't', 'u'];
  memorie.registreer(patronen, 'run-1');
  memorie.updatePulse(patronen); // +0.30
  memorie.updateStilte(patronen); // -0.05
  const na = memorie.getConfiguratie(patronen);
  assertNear('10. Na stilte gewicht -0.05', na.gewicht, 0.25, 0.01);
  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 11: Shuffle 70% gewogen + 30% random ──────────
(function test11() {
  const tmpDir = makeTmpDir();
  const memorie = new ConfiguratieMemorie({ vivantDir: tmpDir, memorieFile: path.join(tmpDir, 'conf.json') });
  memorie.registreer(['a', 'b', 'c', 'd', 'e', 'f'], 'run-1');
  memorie.updatePulse(['a', 'b', 'c', 'd', 'e', 'f']); // gewicht 0.30
  memorie.registreer(['x', 'y', 'z', 'a', 'b', 'c'], 'run-1');
  // gewicht 0 for second

  const shuffle = memorie.shuffleGewichten();
  assert('11a. Shuffle retourneert entries', shuffle.length === 2);
  assert('11b. Effectieve kans is mix van gewogen + random', shuffle.every((s) => s.effectieveKans > 0));

  // The stronger config should have higher effective kans
  const sterkerIdx = shuffle.findIndex((s) => s.gewogenKans > 0.5);
  const zwakkerIdx = 1 - sterkerIdx;
  assert('11c. Sterkere config heeft hogere kans', shuffle[sterkerIdx].effectieveKans > shuffle[zwakkerIdx].effectieveKans);

  // 30% random component ensures weak entry still has chance
  assert('11d. Zwakkere config heeft ook kans (serendipiteit)', shuffle[zwakkerIdx].effectieveKans > 0.1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 12: VIVANT ontvangt PulseSignal bij pulse ──────
(function test12() {
  // Set all neighbors to different domains → max entropy → pulse
  const overrides = {};
  const domains = ['ai-governance', 'ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai', 'finance-ai'];
  BUUR_INDICES.forEach((idx, i) => {
    overrides[idx] = { label: domains[i], domain: domains[i], score: 0.6 };
  });
  const cells = makeCells(overrides);
  const result = verwerkCel14(cells, 'test-run-12');
  assert('12a. Pulse gevuurd', result.pulsGevuurd === true);
  assert('12b. PulseSignal aanwezig', result.pulse != null);
  assert('12c. PulseSignal type = pulse', result.pulse && result.pulse.type === 'pulse');
  assert('12d. PulseSignal expansie = true', result.pulse && result.pulse.expansie === true);
  assert('12e. PulseSignal heeft sterkte', result.pulse && result.pulse.sterkte > 0);
})();

// ─── Test 13: Expansie object bij pulse ──────────────────
(function test13() {
  const overrides = {};
  const domains = ['ai-governance', 'ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai', 'finance-ai'];
  BUUR_INDICES.forEach((idx, i) => {
    overrides[idx] = { label: domains[i], domain: domains[i], score: 0.6 };
  });
  const cells = makeCells(overrides);
  const result = verwerkCel14(cells, 'test-run-13');
  assert('13a. Expansie object aanwezig', result.expansie != null);
  assert('13b. Expansie heeft entropieVoorPulse', result.expansie && Number.isFinite(result.expansie.entropieVoorPulse));
  assert('13c. Expansie heeft entropieNaPulse', result.expansie && Number.isFinite(result.expansie.entropieNaPulse));
  assert('13d. Expansie heeft nieuwVerbindingen', result.expansie && Array.isArray(result.expansie.nieuwVerbindingen));
  assert('13e. Expansie kubusFase = expanderend', result.expansie && result.expansie.kubusFase === 'expanderend');
})();

// ─── Test 14: Entropie daalt na pulse (nieuwe orde) ──────
(function test14() {
  const overrides = {};
  const domains = ['ai-governance', 'ai-safety', 'healthcare-ai', 'legal-ai', 'climate-ai', 'finance-ai'];
  BUUR_INDICES.forEach((idx, i) => {
    overrides[idx] = { label: domains[i], domain: domains[i], score: 0.6 };
  });
  const cells = makeCells(overrides);
  const result = verwerkCel14(cells, 'test-run-14');
  assert('14a. entropieNaPulse < entropieVoorPulse', result.expansie && result.expansie.entropieNaPulse < result.expansie.entropieVoorPulse);

  // Fase classificatie met vorigePulse = true → "nieuwe orde"
  const fase = classificeerEntropieFase(0.3, true);
  assert('14b. Fase na pulse = nieuwe orde', fase === 'nieuwe orde');
})();

// ─── Test 15: Persistentie ──────────────────────────────
(function test15() {
  const tmpDir = makeTmpDir();
  const cells = makeCells({});
  const meting = meetEntropie(cells, 'test-persist');
  slaEntropieOp(meting, tmpDir);
  const history = laadEntropieHistory(tmpDir);
  assert('15a. History bevat 1 entry', history.length === 1);
  assert('15b. Entry heeft runId', history[0].runId === 'test-persist');
  assert('15c. Entry heeft H', Number.isFinite(history[0].H));

  // Add another
  slaEntropieOp(meetEntropie(cells, 'test-persist-2'), tmpDir);
  const history2 = laadEntropieHistory(tmpDir);
  assert('15d. History bevat 2 entries na tweede opslag', history2.length === 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
})();

// ─── Test 16: Softmax ───────────────────────────────────
(function test16() {
  const kansen = softmax([0.30, 0]);
  assert('16a. Softmax retourneert array', kansen.length === 2);
  assert('16b. Softmax sommeert tot ~1', Math.abs(kansen.reduce((s, k) => s + k, 0) - 1) < 0.01);
  assert('16c. Hogere gewicht → hogere kans', kansen[0] > kansen[1]);
})();

// ─── Summary ──
console.log('\n' + '\u2500'.repeat(50));
console.log(`Entropie tests: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
