'use strict';

const path = require('path');
const { Clashd27CubeEngine } = require('../lib/clashd27-cube-engine');
const { computeResearchGravity, selectGravityHotspots, summarizeGravityField } = require('../lib/research-gravity');
const { detectDiscoveryCandidates, emitDiscoveryCandidateEvents } = require('../lib/discovery-candidates');
const { runDiscoveryCycle } = require('../lib/event-emitter');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

console.log('=== Discovery Pipeline Tests ===\n');

// Create engine with temp state file (won't persist)
const engine = new Clashd27CubeEngine({
  stateFile: path.join(__dirname, '..', 'data', 'test-discovery-state.json')
});

// Reset state
engine.state = engine.constructor.length ? engine.state : engine.state;

// Ingest signals to build up cube state
const signals = [
  { id: 'sig-1', source: 'github competitor', keywords: ['consent', 'trust', 'gap'], timestamp: new Date().toISOString() },
  { id: 'sig-2', source: 'github competitor', keywords: ['consent', 'api'], timestamp: new Date().toISOString() },
  { id: 'sig-3', source: 'paper theory', keywords: ['kernel', 'audit', 'gap'], timestamp: new Date().toISOString() },
  { id: 'sig-4', source: 'paper theory', keywords: ['kernel', 'policy'], timestamp: new Date().toISOString() },
  { id: 'sig-5', source: 'internal skill', keywords: ['consent', 'permission'], timestamp: new Date().toISOString() },
  { id: 'sig-6', source: 'openclaw skill', keywords: ['channel', 'mcp', 'api'], timestamp: new Date().toISOString() },
  { id: 'sig-7', source: 'github competitor', keywords: ['kernel', 'architecture', 'gap'], timestamp: new Date().toISOString() },
  { id: 'sig-8', source: 'paper theory', keywords: ['trust', 'consent', 'emerging'], timestamp: new Date().toISOString() },
  { id: 'sig-9', source: 'internal', keywords: ['audit', 'policy', 'trend'], timestamp: new Date().toISOString() },
  { id: 'sig-10', source: 'github competitor', keywords: ['surface', 'channel', 'gap'], timestamp: new Date().toISOString() },
];

for (let i = 0; i < signals.length; i++) {
  engine.ingestSignal(signals[i], { tick: i + 1, persist: false });
}

// Update residue to current tick
engine.updateResidue(signals.length + 1, { persist: false });

console.log('1. Research Gravity');
const emergenceSummary = engine.summarizeEmergence({ persist: false });
const gravityCells = computeResearchGravity(engine.getState(), emergenceSummary);

assert(gravityCells.length === 27, 'Should have 27 gravity cells');
assert(gravityCells[0].gravityScore >= gravityCells[gravityCells.length - 1].gravityScore, 'Should be sorted desc');
assert(typeof gravityCells[0].band === 'string', 'Should have band');
assert(Array.isArray(gravityCells[0].contributors), 'Should have contributors');
assert(gravityCells[0].axes && gravityCells[0].axes.what, 'Should have axes');

const topCell = gravityCells[0];
console.log(`  Top cell: ${topCell.cell} (${topCell.axes.what}/${topCell.axes.where}/${topCell.axes.time}) gravity=${topCell.gravityScore} [${topCell.band}]`);

console.log('\n2. Gravity Hotspots');
const hotspots = selectGravityHotspots(gravityCells, { minScore: 0.1 });
assert(hotspots.length > 0, 'Should have at least one hotspot');
assert(hotspots[0].type === 'gravity_hotspot', 'Should have type gravity_hotspot');
assert(typeof hotspots[0].explanation === 'string', 'Should have explanation');
console.log(`  Found ${hotspots.length} hotspot(s)`);
for (const h of hotspots) {
  console.log(`    Cell ${h.cell} (${h.axes.what}/${h.axes.where}/${h.axes.time}) gravity=${h.gravityScore} [${h.band}]`);
}

console.log('\n3. Gravity Field Summary');
const field = summarizeGravityField(gravityCells);
assert(typeof field.totalMass === 'number', 'Should have totalMass');
assert(field.centerOfMass && typeof field.centerOfMass.what === 'number', 'Should have center of mass');
assert(typeof field.distribution === 'object', 'Should have distribution');
console.log(`  Total mass: ${field.totalMass}, Center: (${field.centerOfMass.what}, ${field.centerOfMass.where}, ${field.centerOfMass.time})`);
console.log(`  Distribution: R=${field.distribution.red} Y=${field.distribution.yellow} G=${field.distribution.green} B=${field.distribution.blue}`);

console.log('\n4. Discovery Candidates');
const candidates = detectDiscoveryCandidates({
  gravityCells,
  emergenceSummary,
  cubeState: engine.getState()
});
assert(Array.isArray(candidates), 'Should return array');
if (candidates.length > 0) {
  assert(typeof candidates[0].candidateScore === 'number', 'Should have score');
  assert(typeof candidates[0].type === 'string', 'Should have type');
  assert(typeof candidates[0].explanation === 'string', 'Should have explanation');
}
console.log(`  Found ${candidates.length} candidate(s)`);
for (const c of candidates.slice(0, 5)) {
  console.log(`    [${c.type}] score=${c.candidateScore} cells=${c.cells.join(',')} — ${c.explanation.slice(0, 80)}...`);
}

console.log('\n5. Discovery Candidate Events');
const candidateEvents = emitDiscoveryCandidateEvents(candidates);
assert(Array.isArray(candidateEvents), 'Should return array');
if (candidateEvents.length > 0) {
  assert(candidateEvents[0].type === 'discovery_candidate', 'Should have type discovery_candidate');
  assert(typeof candidateEvents[0].candidateId === 'string', 'Should have candidateId');
}
console.log(`  Emitted ${candidateEvents.length} events`);

console.log('\n6. Full Discovery Cycle (runDiscoveryCycle)');
const cycle = runDiscoveryCycle(engine, { tick: 12 });
assert(cycle.tick === 12, 'Should have correct tick');
assert(Array.isArray(cycle.events), 'Should have events array');
assert(cycle.gravity && Array.isArray(cycle.gravity.cells), 'Should have gravity cells');
assert(cycle.discovery && Array.isArray(cycle.discovery.candidates), 'Should have candidates');
assert(cycle.emergence && Array.isArray(cycle.emergence.clusters), 'Should have clusters');
console.log(`  Events: ${cycle.events.length}`);
console.log(`  Gravity hotspots: ${cycle.gravity.hotspots.length}`);
console.log(`  Discovery candidates: ${cycle.discovery.candidates.length}`);
console.log(`  Emergence clusters: ${cycle.emergence.clusters.length}`);
console.log(`  Collisions: ${cycle.emergence.collisions.length}`);

// Print all events
console.log('\n  Event stream:');
for (const evt of cycle.events) {
  const score = evt.candidateScore || evt.gravityScore || evt.totalScore || '';
  console.log(`    [${evt.type}] ${score ? `score=${score} ` : ''}${evt.explanation || evt.clusterId || 'summary'}`);
}

// Cleanup test file
try {
  require('fs').unlinkSync(path.join(__dirname, '..', 'data', 'test-discovery-state.json'));
} catch (_) {}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
