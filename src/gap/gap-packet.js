'use strict';

const GAP_PACKET_VERSION = 'clashd27.gap.v1';
const GAP_PACKET_KIND = 'gap_packet';
const GAP_HANDOFF_KIND = 'gap_proposal_handoff';
const GAP_PROMISING_THRESHOLD = 0.62;

function round(num, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function hash32(input) {
  const str = String(input || '');
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function packetIdFromCandidate(candidate, tick) {
  const seed = [
    candidate.id || 'unknown',
    String(tick || 0),
    (candidate.cells || []).join(','),
    candidate.type || 'candidate'
  ].join('|');
  return `gap-${hash32(seed).toString(16).padStart(8, '0')}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function makeProposalTitle(candidate, hypothesis) {
  const base = hypothesis && hypothesis.statement
    ? hypothesis.statement
    : (candidate.explanation || 'Governed gap candidate');
  return `Gap proposal: ${String(base).slice(0, 96)}`;
}

function mapPacketRisk(packet) {
  if ((packet.scores && packet.scores.total >= 0.85) || packet.priority === 'high') {
    return 'orange';
  }
  return 'green';
}

function createCanonicalPacketEnvelope(packet, title, rendering) {
  return {
    source: 'clashd27',
    sourcePacketId: packet.packetId,
    detectedAtIso: packet.createdAt,
    createdAtIso: packet.createdAt,
    title,
    summary: rendering.summary || packet.candidate.explanation || title,
    gapType: packet.candidate.type || 'governed_gap',
    risk: mapPacketRisk(packet),
    requiresConsent: true,
    evidence: toArray(packet.evidenceRefs).map(ref => ({
      sourceType: ref.sourceType || 'unknown',
      sourceId: ref.sourceId || '',
      ...(ref.label ? { label: ref.label } : {}),
      ...(ref.url ? { url: ref.url } : {}),
      ...(ref.summary ? { summary: ref.summary } : {})
    })),
    actions: [],
    metadata: {
      hypothesis: packet.hypothesis || null,
      verificationPlan: packet.verificationPlan || [],
      killTests: packet.killTests || [],
      recommendedAction: packet.recommendedAction || null,
      lifecycleState: packet.lifecycle || null,
      cube: packet.cube || null,
      normalization: packet.normalization || null,
      scoringTrace: packet.scoringTrace || null,
      scores: packet.scores || null,
      rendering: rendering || null,
      trust: packet.trust || null
    }
  };
}

function createGovernedHandoff(packet, opts = {}) {
  const title = makeProposalTitle(packet.candidate, packet.hypothesis);
  const score = packet.scores || {};
  const rendering = packet.rendering || {};
  const canonicalPacket = createCanonicalPacketEnvelope(packet, title, rendering);
  return {
    type: GAP_HANDOFF_KIND,
    kind: GAP_HANDOFF_KIND,
    version: 1,
    sourceSystem: 'clashd27',
    source: 'clashd27',
    destinationSystem: 'openclashd-v2',
    generatedAt: opts.generatedAt || packet.createdAt,
    handedOffAtIso: opts.generatedAt || packet.createdAt,
    packetId: packet.packetId,
    packet: canonicalPacket,
    summary: canonicalPacket.summary,
    actions: canonicalPacket.actions,
    metadata: canonicalPacket.metadata,
    trustBoundary: 'discovery_only',
    executionMode: 'forbidden',
    requiresHumanApproval: true,
    directExecutionAllowed: false,
    lifecycleState: packet.lifecycle || null,
    recommendedAction: packet.recommendedAction || null,
    proposalIntakeKind: 'proposal_intake',
    permittedFlow: [
      'proposal_intake',
      'human_approval',
      'bounded_execution_by_openclashd_v2_only'
    ],
    forbiddenFlow: [
      'direct_external_action',
      'state_mutation_outside_discovery',
      'ungoverned_execution'
    ],
    proposal: {
      agentId: 'clashd27',
      title,
      intent: {
        kind: 'gap_candidate',
        key: `gap_candidate:${packet.packetId}`,
        requiresConsent: true,
        risk: {
          level: packet.priority === 'high' ? 'medium' : 'low',
          reason: 'Discovery candidate only. No execution permitted from CLASHD27.'
        },
        payload: {
          packetId: packet.packetId,
          candidateId: packet.candidate.id,
          topic: rendering.title || packet.candidate.topic || packet.candidate.explanation || '',
          summary: rendering.summary || packet.candidate.explanation || '',
          novelty: score.novelty || 0,
          entropy: score.entropy || 0,
          serendipity: score.serendipity || 0,
          evidenceDensity: score.evidence || 0,
          crossDomainScore: score.collision || 0,
          sourceConfidence: score.evidence || 0,
          gravity: score.gravity || 0,
          residue: score.residue || 0,
          totalScore: score.total || 0,
          hypothesis: packet.hypothesis,
          verificationPlan: packet.verificationPlan,
          killTests: packet.killTests,
          recommendedAction: packet.recommendedAction,
          lifecycleState: packet.lifecycle,
          cube: packet.cube,
          normalization: packet.normalization,
          evidenceRefs: packet.evidenceRefs,
          scoringTrace: packet.scoringTrace
        }
      }
    }
  };
}

function createGapPacket(input) {
  const candidate = input.candidate || {};
  const packetId = input.packetId || packetIdFromCandidate(candidate, input.tick);
  const scores = {
    novelty: round(clamp(input.scores.novelty || 0, 0, 1)),
    collision: round(clamp(input.scores.collision || 0, 0, 1)),
    residue: round(clamp(input.scores.residue || 0, 0, 1)),
    gravity: round(clamp(input.scores.gravity || 0, 0, 1)),
    evidence: round(clamp(input.scores.evidence || 0, 0, 1)),
    entropy: round(clamp(input.scores.entropy || 0, 0, 1)),
    serendipity: round(clamp(input.scores.serendipity || 0, 0, 1)),
    total: round(clamp(input.scores.total || 0, 0, 1))
  };
  const promising = scores.total >= GAP_PROMISING_THRESHOLD;

  const packet = {
    kind: GAP_PACKET_KIND,
    version: GAP_PACKET_VERSION,
    packetId,
    createdAt: input.createdAt || new Date().toISOString(),
    pipeline: {
      name: 'governed-gap-discovery',
      stage: promising ? 'proposal_candidate' : 'observe_only',
      deterministic: true,
      executionEnabled: false
    },
    candidate: {
      id: candidate.id || packetId,
      type: candidate.type || 'unknown',
      cells: toArray(candidate.cells).map(Number),
      axes: toArray(candidate.axes),
      topic: input.topic || candidate.topic || '',
      explanation: candidate.explanation || '',
      score: round(candidate.candidateScore || 0),
      rank: candidate.rank || null
    },
    cube: {
      cells: toArray(input.cube.cells).map(Number),
      primaryCell: Number.isFinite(input.cube.primaryCell) ? input.cube.primaryCell : null,
      domainDistance: round(input.cube.domainDistance || 0),
      axesSignature: input.cube.axesSignature || ''
    },
    normalization: input.normalization || null,
    evidenceRefs: toArray(input.evidenceRefs),
    scores,
    priority: scores.total >= 0.75 ? 'high' : (scores.total >= GAP_PROMISING_THRESHOLD ? 'medium' : 'low'),
    promising,
    hypothesis: input.hypothesis,
    verificationPlan: toArray(input.verificationPlan),
    killTests: toArray(input.killTests),
    recommendedActionClass: input.recommendedActionClass || null,
    recommendedAction: input.recommendedAction || null,
    lifecycle: input.lifecycle || null,
    rendering: input.rendering,
    scoringTrace: input.scoringTrace,
    trust: {
      boundary: 'discovery_only',
      governanceRequired: true,
      directExecutionAllowed: false,
      safeClashInspectable: true
    }
  };

  packet.gapProposalHandoff = createGovernedHandoff(packet, {
    generatedAt: input.createdAt || packet.createdAt
  });
  packet.governedHandoff = packet.gapProposalHandoff;
  return packet;
}

function validateGapPacket(packet) {
  const errors = [];
  if (!packet || typeof packet !== 'object') errors.push('packet must be an object');
  if (packet.kind !== GAP_PACKET_KIND) errors.push('packet.kind must be gap_packet');
  if (packet.version !== GAP_PACKET_VERSION) errors.push('packet.version mismatch');
  if (!packet.packetId) errors.push('packetId is required');
  if (!packet.scores || typeof packet.scores.total !== 'number') errors.push('scores.total is required');
  if (!packet.gapProposalHandoff || packet.gapProposalHandoff.executionMode !== 'forbidden') {
    errors.push('governed handoff must forbid execution');
  }
  if (packet.gapProposalHandoff && packet.gapProposalHandoff.destinationSystem !== 'openclashd-v2') {
    errors.push('handoff destination must be openclashd-v2');
  }
  if (!packet.recommendedAction || packet.recommendedAction.type !== 'submit_gap_proposal') {
    errors.push('recommendedAction must stop at proposal submission');
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

module.exports = {
  GAP_PACKET_KIND,
  GAP_PACKET_VERSION,
  GAP_PROMISING_THRESHOLD,
  createGapPacket,
  createGovernedHandoff,
  packetIdFromCandidate,
  validateGapPacket
};
