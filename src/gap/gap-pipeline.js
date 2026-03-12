'use strict';

const os = require('os');
const path = require('path');
const { Clashd27CubeEngine } = require('../../lib/clashd27-cube-engine');
const { detectDiscoveryCandidates } = require('../../lib/discovery-candidates');
const { enrichCandidates, candidateToProposalPayload, deriveRecommendedActionKind } = require('../../lib/proposal-metadata');
const { computeResearchGravity } = require('../../lib/research-gravity');
const { scoreSignalSources } = require('../../lib/source-scorer');
const { buildAxesSignature, mapSignalsToCube, summarizeNormalization } = require('./cube-mapper');
const { createGapPacket } = require('./gap-packet');
const { scoreGapCandidates } = require('./gap-scorer');
const { buildHypothesis, buildKillTests, buildRecommendedAction, buildVerificationPlan } = require('./hypothesis-generator');

function round(num, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function makeTempStateFile() {
  return path.join(os.tmpdir(), `clashd27-gap-pipeline-${process.pid}-${Date.now()}.json`);
}

function buildRendering(packet) {
  const axesLabel = packet.cube.axesSignature || 'cross-domain signal';
  return {
    title: axesLabel,
    summary: packet.candidate.explanation || packet.hypothesis.statement,
    whyNow: `Total score ${packet.scores.total} with gravity ${packet.scores.gravity}, residue ${packet.scores.residue}, entropy ${packet.scores.entropy}, and serendipity ${packet.scores.serendipity}.`,
    badges: [
      `novelty:${packet.scores.novelty}`,
      `collision:${packet.scores.collision}`,
      `gravity:${packet.scores.gravity}`,
      `evidence:${packet.scores.evidence}`,
      `entropy:${packet.scores.entropy}`,
      `serendipity:${packet.scores.serendipity}`
    ]
  };
}

function buildPacketFromScored(scored, context) {
  const candidate = scored.candidate;
  const hypothesis = buildHypothesis(candidate, scored.scores);
  const verificationPlan = buildVerificationPlan(candidate, scored.scores);
  const killTests = buildKillTests(candidate, scored.scores);
  const recommendedActionClass = deriveRecommendedActionKind(candidate);
  const recommendedAction = {
    ...buildRecommendedAction(candidate, scored.scores),
    class: recommendedActionClass
  };
  const proposal = candidateToProposalPayload(candidate, 'clashd27');

  const cells = (candidate.cells || []).map(Number);
  const axesSignature = buildAxesSignature((candidate.axes || []).map(axes => ({ axes })));
  const packet = createGapPacket({
    createdAt: context.timestamp,
    tick: context.tick,
    candidate,
    scores: scored.scores,
    hypothesis,
    verificationPlan,
    killTests,
    recommendedActionClass,
    recommendedAction,
    lifecycle: {
      current: scored.promising ? 'handoff_ready' : 'observe_only',
      authorityBoundary: 'clashd27_stops_at_proposal',
      completedStages: [
        'signal_normalized',
        'cube_mapped',
        'candidate_scored',
        'hypothesis_generated',
        'verification_plan_built',
        'kill_tests_defined'
      ],
      nextStage: 'openclashd-v2_proposal_intake'
    },
    evidenceRefs: (candidate.sources || []).map(source => ({
      sourceType: typeof source === 'string' ? source : (source.sourceType || 'unknown'),
      sourceId: typeof source === 'string' ? source : (source.sourceId || source.source || '')
    })),
    cube: {
      cells,
      primaryCell: cells[0],
      domainDistance: candidate.domainDistance || 0,
      axesSignature
    },
    rendering: null,
    normalization: context.normalization || null,
    scoringTrace: scored.scoringTrace
  });

  packet.rendering = buildRendering(packet);
  packet.gapProposalHandoff.proposal = {
    ...proposal,
    title: `Gap proposal: ${packet.rendering.title}`,
    candidateSummary: packet.rendering.summary,
    reasoningTraceShort: packet.scoringTrace.formulas.total,
    recommendedActionKind: recommendedActionClass,
    intent: {
      ...proposal.intent,
      payload: {
        ...proposal.intent.payload,
        summary: packet.rendering.summary,
        topic: packet.rendering.title,
        totalScore: packet.scores.total,
        entropy: packet.scores.entropy,
        serendipity: packet.scores.serendipity,
        hypothesis: packet.hypothesis,
        verificationPlan: packet.verificationPlan,
        killTests: packet.killTests,
        recommendedActionClass,
        recommendedAction: packet.recommendedAction,
        lifecycleState: packet.lifecycle,
        normalization: packet.normalization,
        scoringTrace: packet.scoringTrace
      }
    }
  };
  packet.governedHandoff = packet.gapProposalHandoff;

  return packet;
}

function buildGapEvents(packets) {
  const now = new Date().toISOString();
  return (packets || []).map((packet, index) => ({
    type: 'governed_gap_candidate',
    timestamp: now,
    rank: index + 1,
    packetId: packet.packetId,
    candidateId: packet.candidate.id,
    title: packet.rendering.title,
    totalScore: packet.scores.total,
    novelty: packet.scores.novelty,
    collision: packet.scores.collision,
    residue: packet.scores.residue,
    gravity: packet.scores.gravity,
    evidence: packet.scores.evidence,
    entropy: packet.scores.entropy,
    serendipity: packet.scores.serendipity,
    promising: packet.promising,
    executionMode: 'forbidden',
    handoffType: packet.gapProposalHandoff.type,
    explanation: packet.rendering.summary
  }));
}

function runGapPipeline(input) {
  const cubeState = input.cubeState || { cells: {} };
  const emergenceSummary = input.emergenceSummary || { collisions: [], clusters: [], gradients: [], corridors: [] };
  const gravityCells = input.gravityCells || computeResearchGravity(cubeState, emergenceSummary);
  const rawCandidates = input.candidates || detectDiscoveryCandidates({
    gravityCells,
    emergenceSummary,
    cubeState
  });
  const candidates = enrichCandidates(rawCandidates);
  const sourceScores = input.sourceScores || scoreSignalSources(
    cubeState,
    emergenceSummary.collisions || cubeState.collisions || [],
    cubeState.emergenceEvents || []
  );
  const scored = scoreGapCandidates({
    candidates,
    cubeState,
    emergenceSummary,
    gravityCells,
    sourceScores
  });
  const timestamp = input.timestamp || new Date().toISOString();
  const tick = Number.isFinite(input.tick) ? input.tick : (cubeState.clock || 0);
  const packets = scored
    .filter(item => item.scores.total >= 0.4)
    .map(item => buildPacketFromScored(item, { timestamp, tick, normalization: input.normalization || null }))
    .sort((a, b) => (b.scores.total - a.scores.total) || a.packetId.localeCompare(b.packetId));

  return {
    timestamp,
    tick,
    packets,
    handoffs: packets.map(packet => packet.gapProposalHandoff),
    proposalHandoffs: packets.map(packet => packet.gapProposalHandoff),
    events: buildGapEvents(packets),
    summary: {
      totalCandidates: candidates.length,
      packetCount: packets.length,
      promisingCount: packets.filter(packet => packet.promising).length,
      topScore: packets.length > 0 ? round(packets[0].scores.total) : 0,
      scoredSources: sourceScores.length
    }
  };
}

function runGapDiscoveryFromSignals(signals, opts = {}) {
  const engine = opts.engine || new Clashd27CubeEngine({
    stateFile: opts.stateFile || makeTempStateFile(),
    emergenceThreshold: Number.isFinite(opts.emergenceThreshold) ? opts.emergenceThreshold : 0.5
  });
  const referenceTime = opts.referenceTime || new Date().toISOString();
  const normalizedSignals = mapSignalsToCube(signals || [], { referenceTime });
  const normalization = summarizeNormalization(normalizedSignals);

  (signals || []).forEach((signal, index) => {
    engine.ingestSignal(signal, {
      tick: index + 1,
      persist: false,
      referenceTime
    });
  });

  const tick = Number.isFinite(opts.tick) ? opts.tick : (signals || []).length;
  const emergenceSummary = engine.summarizeEmergence({ persist: false });
  const cubeState = engine.getState();
  const gravityCells = computeResearchGravity(cubeState, emergenceSummary);

  return runGapPipeline({
    tick,
    timestamp: referenceTime,
    cubeState,
    emergenceSummary,
    gravityCells,
    normalization: {
      ...normalization,
      mappedSignals: normalizedSignals
    }
  });
}

module.exports = {
  buildGapEvents,
  runGapDiscoveryFromSignals,
  runGapPipeline
};
