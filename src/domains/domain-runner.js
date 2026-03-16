'use strict';

const { SignalQueue } = require('../queue/signal-queue');
const { normalizeQueue } = require('../queue/signal-normalizer');
const { TOPICS } = require('../queue/topics');
const { extractPaperSignals } = require('../sources/paper-signal-extractor');
const { fetchPapers } = require('../sources/paper-fetcher');
const { runDiscoveryCycle } = require('../../lib/event-emitter');
const { GapLibrary } = require('../library/gap-library');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function buildSignalQueueRecords(queue, papers, domain) {
  let generatedSignals = 0;
  for (const paper of papers) {
    const signals = extractPaperSignals({
      ...paper,
      domain: domain.id
    }, {
      domain: domain.id,
      sourceName: paper.source || 'paper'
    });

    for (const signal of signals) {
      queue.produce(TOPICS.RAW_SIGNALS, {
        ...signal,
        domain: domain.id,
        domainId: domain.id,
        domainLabel: domain.label,
        sourceWeight: round((Number(signal.sourceWeight) || 1) * (Number(domain.sourceWeight) || 1))
      });
      generatedSignals += 1;
    }
  }
  return generatedSignals;
}

function updatePaperCoverage(paperMap, signal, latestSignal) {
  if (!signal || !signal.paperId || !paperMap.has(signal.paperId) || !latestSignal || !Number.isInteger(latestSignal.cellId)) {
    return;
  }

  const paper = paperMap.get(signal.paperId);
  paper.cells = Array.from(new Set([...(paper.cells || []), `cell-${latestSignal.cellId}`]));
  paper.signalCount = (paper.signalCount || 0) + 1;
  paper.maxSignalScore = Math.max(paper.maxSignalScore || 0, Number(signal.score) || 0);
}

async function runDomainCycle(domain, cubeEngine, options = {}) {
  const runId = options.runId || `${domain.id}-${Date.now()}`;
  const log = options.log || console.log;
  const fetchPapersImpl = options.fetchPapers || fetchPapers;
  const normalizeQueueImpl = options.normalizeQueue || normalizeQueue;
  const runDiscoveryCycleImpl = options.runDiscoveryCycle || runDiscoveryCycle;
  const library = options.library || new GapLibrary(options.libraryOptions);
  const queue = options.queue || new SignalQueue();
  const papersPerQuery = Number.isFinite(options.papersPerQuery) ? options.papersPerQuery : 100;

  log(`[DOMAIN] Starting cycle for: ${domain.label}`);

  const papers = await fetchPapersImpl({
    queries: domain.queries,
    sources: domain.sources,
    limit: papersPerQuery,
    domainId: domain.id
  });

  log(`[DOMAIN] ${domain.label}: fetched ${papers.length} papers`);

  const paperMap = new Map(
    papers.map((paper) => [paper.paperId, {
      ...paper,
      domain: domain.id,
      domainId: domain.id,
      domainLabel: domain.label,
      cells: [],
      signalCount: 0,
      maxSignalScore: 0
    }])
  );

  const generatedSignals = buildSignalQueueRecords(queue, papers, domain);
  const normalization = normalizeQueueImpl(queue, {
    nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
  });
  const signals = queue.consumeAll(TOPICS.NORMALIZED_SIGNALS);
  const activatedCells = new Set();

  for (const signal of signals) {
    cubeEngine.ingestSignal(signal, {
      tick: Number.isFinite(options.tick) ? options.tick : Date.now(),
      persist: false,
      referenceTime: options.referenceTime || new Date().toISOString()
    });

    if (typeof cubeEngine.getState === 'function') {
      const state = cubeEngine.getState();
      const latestSignal = Array.isArray(state.signals) ? state.signals[state.signals.length - 1] : null;
      if (latestSignal && Number.isInteger(latestSignal.cellId)) {
        activatedCells.add(latestSignal.cellId);
      }
      updatePaperCoverage(paperMap, signal, latestSignal);
    }
  }

  log(`[DOMAIN] ${domain.label}: normalized ${signals.length} signals`);

  const cycle = runDiscoveryCycleImpl(cubeEngine, {
    tick: Number.isFinite(options.tick) ? options.tick : Date.now(),
    minGravityScore: domain.minScore || 0.4
  });

  const packets = (cycle && cycle.gapDiscovery && cycle.gapDiscovery.packets) || [];
  const packetUpdates = [];
  // Library persistence belongs to the domain orchestration layer, not the engine.
  for (const packet of packets) {
    packetUpdates.push(await library.addOrUpdate(packet, Array.from(paperMap.values()), runId, domain));
  }

  const promisingIds = new Set(
    packets
      .filter((packet) => Number(packet && packet.scores && packet.scores.total) >= (domain.minScore || 0.4))
      .map((packet) => packet.packetId)
  );
  const handoffs = ((cycle && cycle.gapProposalHandoffs) || []).filter((handoff) => promisingIds.has(handoff.packetId));

  log(`[DOMAIN] ${domain.label}: found ${packets.length} gaps`);

  return {
    domainId: domain.id,
    domainLabel: domain.label,
    papersAnalyzed: papers.length,
    signalsGenerated: generatedSignals,
    normalizedSignals: signals.length,
    droppedSignals: normalization.dropped,
    gapsFound: packets.length,
    cubeCellsActivated: activatedCells.size,
    handoffs,
    packets,
    packetUpdates,
    runId
  };
}

module.exports = {
  runDomainCycle
};
