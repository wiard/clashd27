'use strict';

const fs = require('fs');
const path = require('path');
const {
  Clashd27CubeEngine
} = require('../lib/clashd27-cube-engine');
const { runDiscoveryCycle } = require('../lib/event-emitter');
const { mapSignalToCubeCell } = require('../src/gap/cube-mapper');
const { validateGapPacket } = require('../src/gap/gap-packet');
const { runGapDiscoveryFromSignals } = require('../src/gap/gap-pipeline');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    failed += 1;
    return;
  }
  console.log(`[PASS] ${name}`);
  passed += 1;
}

function tmpFile(label) {
  return path.join('/tmp', `clashd27-gap-${label}-${process.pid}-${Date.now()}.json`);
}

function mkEngine(label) {
  const file = tmpFile(label);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return new Clashd27CubeEngine({ stateFile: file, emergenceThreshold: 0.5 });
}

function testDeterministicCubeMapping() {
  const signal = {
    id: 'map-1',
    source: 'github competitor',
    timestamp: '2026-03-10T00:00:00.000Z',
    keywords: ['consent', 'benchmark', 'gap']
  };

  const first = mapSignalToCubeCell(signal, { referenceTime: '2026-03-11T00:00:00.000Z' });
  const second = mapSignalToCubeCell(signal, { referenceTime: '2026-03-11T00:00:00.000Z' });

  assert('cube mapping is deterministic', first.cellId === second.cellId);
  assert('cube mapping remains parity consistent', first.parityConsistent === true);
  assert('mapped axis is trust-model', first.axes.what === 'trust-model');
}

function buildSignalBundle() {
  return [
    { id: 'gap-1', source: 'github competitor', timestamp: '2026-03-01T00:00:00.000Z', keywords: ['consent', 'trust', 'gap'], evidenceConfidence: 1.2, citationCount: 8, corroboratedSources: 2 },
    { id: 'gap-2', source: 'paper theory', timestamp: '2026-03-02T00:00:00.000Z', keywords: ['consent', 'benchmark', 'gap'], evidenceConfidence: 1.4, citationCount: 12, corroboratedSources: 3 },
    { id: 'gap-3', source: 'github competitor', timestamp: '2026-03-03T00:00:00.000Z', keywords: ['api', 'channel', 'gap'], evidenceConfidence: 1.1, citationCount: 6 },
    { id: 'gap-4', source: 'internal system', timestamp: '2026-03-04T00:00:00.000Z', keywords: ['api', 'channel', 'trend'] },
    { id: 'gap-5', source: 'paper theory', timestamp: '2026-03-05T00:00:00.000Z', keywords: ['kernel', 'policy', 'gap'], evidenceConfidence: 1.3, citationCount: 18 },
    { id: 'gap-6', source: 'internal skill', timestamp: '2026-03-06T00:00:00.000Z', keywords: ['kernel', 'policy', 'trend'] }
  ];
}

function testGapPipelinePacketGeneration() {
  const result = runGapDiscoveryFromSignals(buildSignalBundle(), {
    referenceTime: '2026-03-11T00:00:00.000Z',
    tick: 6
  });

  assert('gap pipeline returns packets', Array.isArray(result.packets) && result.packets.length > 0);

  const packet = result.packets[0];
  const validation = validateGapPacket(packet);

  assert('gap packet validates', validation.ok === true);
  assert('gap packet has novelty score', typeof packet.scores.novelty === 'number');
  assert('gap packet has collision score', typeof packet.scores.collision === 'number');
  assert('gap packet has residue score', typeof packet.scores.residue === 'number');
  assert('gap packet has gravity score', typeof packet.scores.gravity === 'number');
  assert('gap packet has evidence score', typeof packet.scores.evidence === 'number');
  assert('gap packet has entropy score', typeof packet.scores.entropy === 'number');
  assert('gap packet has serendipity score', typeof packet.scores.serendipity === 'number');
  assert('gap packet has hypothesis', typeof packet.hypothesis.statement === 'string' && packet.hypothesis.statement.length > 0);
  assert('gap packet has verification plan', Array.isArray(packet.verificationPlan) && packet.verificationPlan.length >= 3);
  assert('gap packet has kill tests', Array.isArray(packet.killTests) && packet.killTests.length >= 3);
  assert('gap packet has bounded recommended action', packet.recommendedAction && packet.recommendedAction.type === 'submit_gap_proposal');
  assert('gap packet exposes lifecycle boundary', packet.lifecycle && packet.lifecycle.authorityBoundary === 'clashd27_stops_at_proposal');
  assert('gap proposal handoff forbids direct execution', packet.gapProposalHandoff.executionMode === 'forbidden');
  assert('gap proposal handoff exposes canonical kind', packet.gapProposalHandoff.kind === 'gap_proposal_handoff');
  assert('handoff targets openclashd-v2', packet.gapProposalHandoff.destinationSystem === 'openclashd-v2');
  assert('handoff carries canonical packet envelope', packet.gapProposalHandoff.packet && packet.gapProposalHandoff.packet.sourcePacketId === packet.packetId);
  assert('handoff packet preserves metadata hypothesis', packet.gapProposalHandoff.packet.metadata && typeof packet.gapProposalHandoff.packet.metadata.hypothesis === 'object');
  assert('normalization summary is attached', packet.normalization && packet.normalization.parityConsistent === true);
}

function testDiscoveryCycleIntegration() {
  const engine = mkEngine('integration');
  const signals = buildSignalBundle();
  for (let i = 0; i < signals.length; i += 1) {
    engine.ingestSignal(signals[i], {
      tick: i + 1,
      persist: false,
      referenceTime: '2026-03-11T00:00:00.000Z'
    });
  }

  const cycle = runDiscoveryCycle(engine, { tick: signals.length });
  assert('discovery cycle exposes gap discovery object', cycle.gapDiscovery && Array.isArray(cycle.gapDiscovery.packets));
  assert('discovery cycle exposes governed handoffs', Array.isArray(cycle.governedHandoffs));
  assert('discovery payload includes gap packets', Array.isArray(cycle.discovery.gapPackets));
  assert('discovery payload includes gap proposal handoffs', Array.isArray(cycle.discovery.gapProposalHandoffs));
  assert('event stream includes governed gap candidate event', cycle.events.some(evt => evt.type === 'governed_gap_candidate'));
}

function run() {
  testDeterministicCubeMapping();
  testGapPipelinePacketGeneration();
  testDiscoveryCycleIntegration();

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('[DONE] Governed gap discovery tests passed.');
}

run();
