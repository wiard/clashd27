'use strict';

/**
 * Enriches discovery candidates with ranking-relevant metadata
 * for consumption by openclashd-v2's proposal ranking system.
 *
 * These fields map directly to the ranking factors:
 *   - novelty
 *   - evidenceDensity
 *   - crossDomainScore
 *   - candidateType
 *   - sourceConfidence
 */

/**
 * Computes novelty score from a discovery candidate.
 * Novelty is higher when:
 *   - Few sources cover this intersection
 *   - The collision is cross-domain
 *   - Gradient paths are long (indicating emerging flow)
 *
 * @param {object} candidate - Discovery candidate from detectDiscoveryCandidates
 * @returns {number} Novelty score 0.0–1.0
 */
function computeNovelty(candidate) {
  let novelty = 0.5;

  if (candidate.crossDomain || candidate.spansDomains) {
    novelty += 0.2;
  }

  if (candidate.type === 'gradient_ascent') {
    novelty += Math.min(0.15, (candidate.pathLength || 0) / 20);
  }

  if (candidate.type === 'collision_intersection') {
    novelty += 0.1;
  }

  const sourceCount = (candidate.sources || []).length;
  if (sourceCount === 1) novelty += 0.1;
  else if (sourceCount >= 4) novelty -= 0.05;

  return Math.max(0, Math.min(1, round(novelty)));
}

/**
 * Computes evidence density from a discovery candidate.
 * Evidence is denser when:
 *   - Multiple sources converge
 *   - Gravity is high
 *   - Emergence score is high
 *
 * @param {object} candidate
 * @returns {number} Evidence density 0.0–1.0
 */
function computeEvidenceDensity(candidate) {
  let density = 0.3;

  const sourceCount = (candidate.sources || []).length;
  density += Math.min(0.3, sourceCount / 5);

  if (candidate.combinedGravity) {
    density += Math.min(0.2, candidate.combinedGravity / 10);
  } else if (candidate.gravityScore) {
    density += Math.min(0.2, candidate.gravityScore / 5);
  }

  if (candidate.emergenceScore) {
    density += Math.min(0.2, candidate.emergenceScore * 0.2);
  }

  return Math.max(0, Math.min(1, round(density)));
}

/**
 * Computes cross-domain relevance score.
 *
 * @param {object} candidate
 * @returns {number} 0.0–1.0
 */
function computeCrossDomainScore(candidate) {
  if (candidate.crossDomain || candidate.spansDomains) {
    const axes = candidate.axes || [];
    if (axes.length >= 2) {
      const distinctWhat = new Set(axes.map(a => a.what)).size;
      const distinctWhere = new Set(axes.map(a => a.where)).size;
      return round(Math.min(1, (distinctWhat + distinctWhere) / 4));
    }
    return 0.7;
  }
  return 0.2;
}

/**
 * Computes source confidence from a candidate.
 *
 * @param {object} candidate
 * @returns {number} 0.0–1.0
 */
function computeSourceConfidence(candidate) {
  const score = candidate.candidateScore || 0;
  return Math.max(0, Math.min(1, round(score)));
}

/**
 * Enriches a discovery candidate with ranking metadata fields.
 * These fields are consumed by openclashd-v2's proposal-ranking system.
 *
 * @param {object} candidate - Discovery candidate
 * @returns {object} Enriched candidate with metadata fields added
 */
function enrichCandidateWithRankingMetadata(candidate) {
  return {
    ...candidate,
    novelty: computeNovelty(candidate),
    evidenceDensity: computeEvidenceDensity(candidate),
    crossDomainScore: computeCrossDomainScore(candidate),
    candidateType: candidate.type || 'unknown',
    sourceConfidence: computeSourceConfidence(candidate)
  };
}

/**
 * Enriches all discovery candidates from a batch.
 *
 * @param {object[]} candidates
 * @returns {object[]} Enriched candidates
 */
function enrichCandidates(candidates) {
  return (candidates || []).map(enrichCandidateWithRankingMetadata);
}

/**
 * Converts an enriched candidate to a proposal-shaped payload
 * suitable for submission to openclashd-v2's /api/agents/propose endpoint.
 *
 * @param {object} enriched - Enriched candidate
 * @param {string} agentId - Agent identity
 * @returns {object} Proposal-shaped object
 */
function candidateToProposalPayload(enriched, agentId = 'clashd27') {
  return {
    agentId,
    title: enriched.explanation || `Discovery candidate: ${enriched.id}`,
    intent: {
      kind: 'intent',
      key: `intent.discovery.${enriched.candidateType || 'investigate'}`,
      payload: {
        candidateId: enriched.id,
        candidateType: enriched.candidateType,
        candidateScore: enriched.candidateScore,
        novelty: enriched.novelty,
        evidenceDensity: enriched.evidenceDensity,
        crossDomainScore: enriched.crossDomainScore,
        sourceConfidence: enriched.sourceConfidence,
        crossDomain: enriched.crossDomain || enriched.spansDomains || false,
        cells: enriched.cells,
        axes: enriched.axes,
        sources: enriched.sources
      },
      risk: 'green',
      requiresConsent: false
    }
  };
}

function round(num, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

module.exports = {
  computeNovelty,
  computeEvidenceDensity,
  computeCrossDomainScore,
  computeSourceConfidence,
  enrichCandidateWithRankingMetadata,
  enrichCandidates,
  candidateToProposalPayload
};
