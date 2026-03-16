'use strict';

const fs = require('fs');
const path = require('path');
const { TickEngine } = require('../lib/tick-engine');
const { Clashd27CubeEngine } = require('../lib/clashd27-cube-engine');

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
  return path.join('/tmp', `clashd27-gap-runtime-${label}-${process.pid}-${Date.now()}.json`);
}

function mkState() {
  return {
    tick: 0,
    agents: new Map(),
    save() {}
  };
}

function mkRuntimeEngine(label) {
  const state = mkState();
  const engine = new TickEngine({ state, tickInterval: 1, useCube: false });
  const stateFile = tmpFile(`${label}-cube`);
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  engine.semanticCube = new Clashd27CubeEngine({ stateFile, emergenceThreshold: 0.5 });
  engine.latestEmergence = engine.semanticCube.summarizeEmergence({ persist: false });
  return engine;
}

function buildSignalBundle() {
  return [
    { id: 'rt-gap-1', source: 'github competitor', timestamp: '2026-03-01T00:00:00.000Z', keywords: ['consent', 'trust', 'gap'], evidenceConfidence: 1.2, citationCount: 8, corroboratedSources: 2 },
    { id: 'rt-gap-2', source: 'paper theory', timestamp: '2026-03-02T00:00:00.000Z', keywords: ['consent', 'benchmark', 'gap'], evidenceConfidence: 1.4, citationCount: 12, corroboratedSources: 3 },
    { id: 'rt-gap-3', source: 'github competitor', timestamp: '2026-03-03T00:00:00.000Z', keywords: ['api', 'channel', 'gap'], evidenceConfidence: 1.1, citationCount: 6 },
    { id: 'rt-gap-4', source: 'internal system', timestamp: '2026-03-04T00:00:00.000Z', keywords: ['api', 'channel', 'trend'] },
    { id: 'rt-gap-5', source: 'paper theory', timestamp: '2026-03-05T00:00:00.000Z', keywords: ['kernel', 'policy', 'gap'], evidenceConfidence: 1.3, citationCount: 18 },
    { id: 'rt-gap-6', source: 'internal skill', timestamp: '2026-03-06T00:00:00.000Z', keywords: ['kernel', 'policy', 'trend'] }
  ];
}

function ingestSignals(engine, signals) {
  const referenceTime = '2026-03-11T00:00:00.000Z';
  for (let i = 0; i < signals.length; i += 1) {
    engine.semanticCube.ingestSignal(signals[i], {
      tick: i + 1,
      persist: false,
      referenceTime
    });
  }
  engine.state.tick = signals.length;
  engine.latestEmergence = engine.semanticCube.summarizeEmergence({ persist: false });
}

function sanitizePacket(packet) {
  return {
    packetId: packet.packetId,
    candidateId: packet.candidate.id,
    scores: packet.scores,
    cube: packet.cube,
    promising: packet.promising,
    recommendedActionClass: packet.recommendedActionClass,
    hypothesis: packet.hypothesis,
    verificationPlan: packet.verificationPlan,
    killTests: packet.killTests,
    handoffKind: packet.gapProposalHandoff.kind,
    destinationSystem: packet.gapProposalHandoff.destinationSystem
  };
}

async function testRuntimeCycleDeterministic() {
  const signals = buildSignalBundle();
  const first = mkRuntimeEngine('first');
  const second = mkRuntimeEngine('second');
  ingestSignals(first, signals);
  ingestSignals(second, signals);

  const cycleA = await first.runGovernedDiscoveryCycle({ tick: signals.length, deliver: false });
  const cycleB = await second.runGovernedDiscoveryCycle({ tick: signals.length, deliver: false });

  assert('runtime discovery cycle returns packets', Array.isArray(cycleA.gapDiscovery.packets) && cycleA.gapDiscovery.packets.length > 0);
  assert('runtime packet count is deterministic', cycleA.gapDiscovery.packets.length === cycleB.gapDiscovery.packets.length);
  assert(
    'runtime packet contents are deterministic',
    JSON.stringify(cycleA.gapDiscovery.packets.map(sanitizePacket)) === JSON.stringify(cycleB.gapDiscovery.packets.map(sanitizePacket))
  );
}

async function testGapHandoffDelivery() {
  const engine = mkRuntimeEngine('delivery');
  const signals = buildSignalBundle();
  ingestSignals(engine, signals);

  const calls = [];
  const logFile = tmpFile('handoff-log');
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => ''
    };
  };

  const cycle = await engine.runGovernedDiscoveryCycle({
    tick: signals.length,
    gatewayUrl: 'https://openclashd-v2.test',
    token: 'test-token',
    fetchImpl,
    storeFile: logFile
  });

  assert('runtime delivery publishes handoffs', cycle.delivery.published === cycle.gapProposalHandoffs.length);
  assert('runtime delivery calls openclashd-v2 proposal endpoint', calls.length === cycle.gapProposalHandoffs.length && calls[0].url === 'https://openclashd-v2.test/api/agents/propose?token=test-token');
  assert(
    'runtime delivery sends canonical proposal payload',
    JSON.parse(calls[0].init.body).intent.key === cycle.gapProposalHandoffs[0].proposal.intent.key
  );
}

async function testLegacyResearchDisabledByDefault() {
  const engine = mkRuntimeEngine('legacy-off');
  let governedEvent = null;
  let legacyResearchEventCount = 0;

  engine.on('governedDiscovery', payload => {
    governedEvent = payload;
  });
  engine.on('discovery', () => {
    legacyResearchEventCount += 1;
  });

  ingestSignals(engine, buildSignalBundle());
  await engine.runGovernedDiscoveryCycle({ tick: engine.state.tick, deliver: false });

  assert('legacy research is disabled by default', engine.legacyResearchEnabled === false);
  assert('legacy queues are inactive in default runtime', engine.deepDiveQueue.length === 0 && engine.verificationQueue.length === 0 && engine.validationQueue.length === 0);
  assert('governed discovery event fires in default runtime', governedEvent && Array.isArray(governedEvent.discovery.gapProposalHandoffs));
  assert('legacy discovery event does not fire during governed runtime cycle', legacyResearchEventCount === 0);
}

async function testObservatoryOutputsRemainAvailable() {
  const engine = mkRuntimeEngine('observatory');
  ingestSignals(engine, buildSignalBundle());

  const cycle = await engine.runGovernedDiscoveryCycle({ tick: engine.state.tick, deliver: false });
  assert('event-emitter output retains governed gap candidate events', cycle.events.some(evt => evt.type === 'governed_gap_candidate'));
  assert('runtime exposes GapPackets for observatory consumers', Array.isArray(cycle.discovery.gapPackets) && cycle.discovery.gapPackets.length > 0);
  assert('runtime exposes gap proposal handoffs for observatory consumers', Array.isArray(cycle.discovery.gapProposalHandoffs) && cycle.discovery.gapProposalHandoffs.length > 0);
}

async function run() {
  await testRuntimeCycleDeterministic();
  await testGapHandoffDelivery();
  await testLegacyResearchDisabledByDefault();
  await testObservatoryOutputsRemainAvailable();

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('[DONE] Governed runtime discovery tests passed.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
