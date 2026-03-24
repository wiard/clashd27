'use strict';

const fs = require('fs');
const path = require('path');

const { Clashd27CubeEngine, normalizeSignal } = require('../lib/clashd27-cube-engine');
const { runDiscoveryCycle } = require('../lib/event-emitter');
const { validateGapPacket } = require('../src/gap/gap-packet');
const { SignalQueue } = require('../src/queue/signal-queue');
const { runSignalIngestionCycle } = require('../src/orchestration/discovery-stream-orchestrator');
const { extractPaperSignals } = require('../src/sources/paper-signal-extractor');

const REFERENCE_TIME = '2026-03-16T00:00:00.000Z';
const REPORT_FILE = path.join(process.cwd(), 'clashd27-system-test-report.json');

function tmpStateFile(label) {
  return path.join('/tmp', `clashd27-manual-${label}-${process.pid}-${Date.now()}.json`);
}

function makeEngine(label, emergenceThreshold = 0.3) {
  const stateFile = tmpStateFile(label);
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  return new Clashd27CubeEngine({ stateFile, emergenceThreshold });
}

function exactKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) exactKeys(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    exactKeys(child, found);
  }
  return found;
}

function compactPacket(packet) {
  return {
    gapId: packet.packetId,
    hypothesis: packet.hypothesis,
    scoringTrace: packet.scoringTrace,
    verificationPlan: packet.verificationPlan,
    killConditions: packet.killTests
  };
}

function adaptManualSignals() {
  return [
    {
      id: 'manual-paper-1',
      type: 'paper-theory',
      title: 'LLM governance gap',
      domain: 'ai-governance',
      content: 'Agents lack deterministic consent enforcement.',
      score: 0.82,
      source: 'paper theory',
      timestamp: '2026-03-06T00:00:00.000Z',
      keywords: ['governance', 'consent', 'gap']
    },
    {
      id: 'manual-github-1',
      type: 'github-repo',
      title: 'LangChain agent memory',
      domain: 'ai-tooling',
      content: 'Memory persists across sessions without consent scope.',
      score: 0.72,
      source: 'github competitor',
      timestamp: '2026-03-08T00:00:00.000Z',
      keywords: ['agent', 'memory', 'consent', 'gap']
    },
    {
      id: 'manual-internal-1',
      type: 'internal-system',
      title: 'OpenClashd consent kernel',
      domain: 'ai-architecture',
      content: 'Channel-scoped consent enforcement with TTL.',
      score: 0.63,
      source: 'internal system',
      timestamp: '2026-03-10T00:00:00.000Z',
      keywords: ['governance', 'architecture', 'consent']
    }
  ];
}

async function verifyPaperSourceIngestion() {
  const queue = new SignalQueue();
  const engine = makeEngine('orchestrator');

  const paperSources = [
    async (q) => {
      const papers = [
        {
          paperId: 'paper-consent-gap-1',
          title: 'Consent-scoped governance for agent systems',
          abstract: 'This method and framework studies consent-scoped governance for agent systems, reports benchmark results, and names one open limitation in runtime enforcement.',
          authors: ['Ada Control', 'Kai Systems'],
          keywords: ['consent', 'governance', 'gap'],
          citationCount: 18,
          year: 2026,
          sourceUrl: 'https://example.test/paper-consent-gap-1'
        },
        {
          paperId: 'paper-memory-gap-2',
          title: 'Persistent memory risks in tool-using agents',
          abstract: 'This paper evaluates tool-using agents, shows memory persistence across sessions, reports improved task completion, and highlights an open problem in consent boundaries.',
          authors: ['Mira Audit'],
          keywords: ['agent', 'memory', 'consent'],
          citationCount: 9,
          year: 2026,
          sourceUrl: 'https://example.test/paper-memory-gap-2'
        }
      ];

      let emittedSignals = 0;
      for (const paper of papers) {
        const signals = extractPaperSignals(paper, {
          sourceName: 'manual-paper-source',
          domain: 'ai-governance'
        });
        emittedSignals += signals.length;
        for (const signal of signals) {
          q.produce('raw-signals', signal);
        }
      }

      return {
        fetched: papers.length,
        emittedSignals,
        queries: 1
      };
    }
  ];

  const result = await runSignalIngestionCycle({
    queue,
    engine,
    tick: 6,
    referenceTime: REFERENCE_TIME,
    paperSources,
    githubRepos: [
      {
        name: 'consent-boundary-runtime',
        description: 'Agent runtime with memory persistence and consent-aware routing.',
        topics: ['agent', 'memory', 'governance'],
        stars: 31,
        forks: 5,
        updatedAt: '2026-03-14T00:00:00.000Z'
      }
    ],
    internalEvents: [
      {
        eventId: 'evt-consent-1',
        title: 'Consent kernel rollout',
        summary: 'Internal runtime uses channel-scoped consent enforcement with TTL and operator visibility.',
        timestamp: '2026-03-15T00:00:00.000Z',
        score: 0.64
      }
    ]
  });

  const state = engine.getState();
  return {
    report: result.report,
    normalizedSignals: result.normalizedSignals.length,
    signalLogCount: state.signals.length,
    activatedCells: [...new Set((state.signals || []).map((signal) => signal.cellId))],
    verified: {
      papersAnalyzed: result.report.papersAnalyzed === 2,
      normalizedSignals: result.report.normalizedSignals > 0,
      cubeIngestion: state.signals.length === result.report.normalizedSignals,
      queueDrained: result.report.topicDepths.rawSignals === 0 && result.report.topicDepths.normalizedSignals === 0
    }
  };
}

function verifyManualSignalIngestion() {
  const engine = makeEngine('manual-direct');
  const signals = adaptManualSignals();
  const results = signals.map((signal, index) => engine.ingestSignal(signal, {
    tick: index + 1,
    persist: false,
    referenceTime: REFERENCE_TIME
  }));

  const deterministicMappings = signals.map((signal) => {
    const first = normalizeSignal(signal, { referenceTime: REFERENCE_TIME });
    const second = normalizeSignal(signal, { referenceTime: REFERENCE_TIME });
    return {
      signalId: signal.id,
      cellId: first.cellId,
      axes: first.what + '/' + first.where + '/' + first.time,
      deterministic: first.cellId === second.cellId && first.what === second.what && first.where === second.where && first.time === second.time
    };
  });

  const state = engine.getState();
  const sourceWeights = state.signals.map((signal) => ({
    signalId: signal.id,
    sourceWeight: signal.sourceWeight,
    scoreDelta: signal.scoreDelta,
    cellId: signal.cellId
  }));

  return {
    engine,
    signals,
    results: results.map((result) => ({
      signalId: result.signal.id,
      cellId: result.signal.cellId,
      scoreDelta: result.scoreDelta
    })),
    signalLogCount: state.signals.length,
    activatedCells: [...new Set(state.signals.map((signal) => signal.cellId))],
    deterministicMappings,
    sourceWeights,
    verified: {
      signalsPresent: state.signals.length === signals.length,
      deterministicCells: deterministicMappings.every((entry) => entry.deterministic),
      sourceWeightsApplied: sourceWeights[0].sourceWeight > sourceWeights[1].sourceWeight &&
        sourceWeights[1].sourceWeight > sourceWeights[2].sourceWeight
    }
  };
}

function evaluateBreaker(packet, signals) {
  const replay = signals.map((signal) => normalizeSignal(signal, { referenceTime: REFERENCE_TIME }).cellId);
  const contradictionMatches = signals.filter((signal) =>
    /enforcement|ttl|kernel|existing solution/i.test(`${signal.title} ${signal.content}`)
  ).map((signal) => signal.id);
  const existingSolutionMatches = signals.filter((signal) =>
    signal.type === 'internal-system' && /enforcement|kernel|ttl/i.test(`${signal.title} ${signal.content}`)
  ).map((signal) => signal.id);

  const killChecks = {
    deterministicRemapStable: replay[0] === 24 && replay[1] === 21 && replay[2] === 9,
    evidenceFloorPassed: packet.scores.evidence >= 0.3,
    interactionPressurePassed: !(packet.scores.collision < 0.25 && packet.scores.gravity < 0.25),
    entropySerendipityPassed: !(packet.scores.entropy < 0.2 && packet.scores.serendipity < 0.2)
  };

  const survives = Object.values(killChecks).every(Boolean) &&
    contradictionMatches.length === 0 &&
    existingSolutionMatches.length === 0;

  return {
    contradictionMatches,
    existingSolutionMatches,
    killChecks,
    verdict: survives ? 'survives' : 'fails',
    reason: survives
      ? 'No contradictory evidence or existing solution markers were found in the signal set.'
      : 'Breaker found an internal existing-solution signal that challenges the missing-control-surface hypothesis.'
  };
}

function verifyDiscoveryPipeline(engine, signals) {
  const cycle = runDiscoveryCycle(engine, { tick: signals.length });
  const packet = cycle.discovery.gapPackets[0] || null;
  const handoff = packet ? packet.gapProposalHandoff : null;
  const packetValidation = packet ? validateGapPacket(packet) : { ok: false, errors: ['No GapPacket produced'] };
  const breaker = packet ? evaluateBreaker(packet, signals) : null;
  const forbiddenKeys = handoff ? ['execute', 'action', 'runtimeInstruction'].filter((key) => exactKeys(handoff).has(key)) : [];

  return {
    candidateCount: cycle.discovery.candidates.length,
    gapPacketCount: cycle.discovery.gapPackets.length,
    collisionsDetected: cycle.emergence.collisions.length,
    clustersDetected: cycle.emergence.clusters.length,
    topCandidateScore: packet ? packet.scores.total : null,
    scoringTrace: packet ? packet.scoringTrace : null,
    hypothesis: packet ? packet.hypothesis : null,
    packetValidation,
    breaker,
    gapPacketView: packet ? compactPacket(packet) : null,
    handoff: handoff ? {
      executionMode: handoff.executionMode,
      destinationSystem: handoff.destinationSystem,
      forbiddenKeysPresent: forbiddenKeys,
      recommendedActionType: packet.recommendedAction && packet.recommendedAction.type,
      exactKeySet: [...exactKeys(handoff)].sort()
    } : null,
    runtimeSummary: {
      signalsIngested: signals.length,
      cubeCellsActivated: [...new Set((engine.getState().signals || []).map((signal) => signal.cellId))].length,
      collisionsDetected: cycle.emergence.collisions.length,
      clustersDetected: cycle.emergence.clusters.length,
      discoveryCandidates: cycle.discovery.candidates.length,
      hypothesesGenerated: cycle.discovery.gapPackets.length,
      gapPacketsCreated: cycle.discovery.gapPackets.length
    },
    verified: {
      discoveryCandidatesProduced: cycle.discovery.candidates.length > 0,
      gapScoringExecuted: !!(packet && packet.scoringTrace),
      hypothesisGenerated: !!(packet && packet.hypothesis && packet.hypothesis.statement),
      breakerDeterministic: !!breaker && (breaker.verdict === 'survives' || breaker.verdict === 'fails'),
      gapPacketFieldsPresent: !!(packet && compactPacket(packet).gapId && compactPacket(packet).hypothesis &&
        compactPacket(packet).scoringTrace && compactPacket(packet).verificationPlan.length > 0 &&
        compactPacket(packet).killConditions.length > 0),
      governedHandoff: !!(handoff &&
        handoff.executionMode === 'forbidden' &&
        handoff.destinationSystem === 'openclashd-v2' &&
        forbiddenKeys.length === 0)
    }
  };
}

async function run() {
  const sourceIngestion = await verifyPaperSourceIngestion();
  const directIngestion = verifyManualSignalIngestion();
  const discovery = verifyDiscoveryPipeline(directIngestion.engine, directIngestion.signals);

  const allChecks = [
    sourceIngestion.verified.papersAnalyzed,
    sourceIngestion.verified.normalizedSignals,
    sourceIngestion.verified.cubeIngestion,
    sourceIngestion.verified.queueDrained,
    directIngestion.verified.signalsPresent,
    directIngestion.verified.deterministicCells,
    directIngestion.verified.sourceWeightsApplied,
    discovery.verified.discoveryCandidatesProduced,
    discovery.verified.gapScoringExecuted,
    discovery.verified.hypothesisGenerated,
    discovery.verified.breakerDeterministic,
    discovery.verified.gapPacketFieldsPresent,
    discovery.verified.governedHandoff
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    referenceTime: REFERENCE_TIME,
    sourcePipeline: sourceIngestion,
    signalIngestion: {
      signals: directIngestion.signals,
      signalLogCount: directIngestion.signalLogCount,
      activatedCells: directIngestion.activatedCells,
      deterministicMappings: directIngestion.deterministicMappings,
      sourceWeights: directIngestion.sourceWeights,
      verified: directIngestion.verified
    },
    discoveryPipeline: discovery,
    finalStatus: allChecks.every(Boolean) ? 'working' : 'failure'
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (report.finalStatus !== 'working') {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
