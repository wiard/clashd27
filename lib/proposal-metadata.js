'use strict';

/**
 * Enriches discovery candidates with ranking-relevant metadata
 * for consumption by openclashd-v2's proposal ranking system.
 *
 * Ranking fields:
 *   - noveltyScore
 *   - evidenceDensity
 *   - crossDomainScore
 *   - sourceConfidence
 *   - governanceValue
 *   - supportingSourceCount
 *   - collisionCount
 *   - clusterStrength
 *   - candidateType
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
 * Computes governance value — how useful this candidate is for governance decisions.
 * Higher for cross-domain collisions and cluster peaks with diverse sources.
 *
 * @param {object} candidate
 * @returns {number} 0.0–1.0
 */
function computeGovernanceValue(candidate) {
  let value = 0.3;

  if (candidate.crossDomain || candidate.spansDomains) {
    value += 0.2;
  }

  if (candidate.type === 'collision_intersection') {
    value += 0.15;
  } else if (candidate.type === 'cluster_peak') {
    value += 0.1;
  }

  const sourceCount = (candidate.sources || []).length;
  if (sourceCount >= 3) value += 0.15;
  else if (sourceCount >= 2) value += 0.1;

  if (candidate.emergenceScore && candidate.emergenceScore >= 0.7) {
    value += 0.1;
  }

  const gravity = candidate.combinedGravity || candidate.gravityScore || 0;
  if (gravity >= 2) value += 0.1;

  return Math.max(0, Math.min(1, round(value)));
}

/**
 * Counts supporting sources from a candidate.
 *
 * @param {object} candidate
 * @returns {number} Integer count
 */
function computeSupportingSourceCount(candidate) {
  return (candidate.sources || []).length;
}

/**
 * Derives collision count from the candidate's emergence data.
 *
 * @param {object} candidate
 * @returns {number} Integer count
 */
function computeCollisionCount(candidate) {
  if (candidate.type === 'collision_intersection') {
    return 1 + Math.floor((candidate.emergenceScore || 0) * 3);
  }
  if (candidate.rankingMetadata && typeof candidate.rankingMetadata.collisionCount === 'number') {
    return candidate.rankingMetadata.collisionCount;
  }
  return 0;
}

/**
 * Derives cluster strength from the candidate's cluster data.
 *
 * @param {object} candidate
 * @returns {number} 0.0–1.0
 */
function computeClusterStrength(candidate) {
  if (candidate.type === 'cluster_peak') {
    const sizeContrib = Math.min(0.5, (candidate.clusterSize || 0) / 10);
    const gravityContrib = Math.min(0.5, (candidate.gravityScore || 0) / 6);
    return round(Math.min(1, sizeContrib + gravityContrib));
  }
  if (candidate.rankingMetadata && typeof candidate.rankingMetadata.clusterStrength === 'number') {
    return candidate.rankingMetadata.clusterStrength;
  }
  return 0;
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
    noveltyScore: computeNovelty(candidate),
    // Keep backward-compat alias
    novelty: computeNovelty(candidate),
    evidenceDensity: computeEvidenceDensity(candidate),
    crossDomainScore: computeCrossDomainScore(candidate),
    candidateType: candidate.type || 'unknown',
    sourceConfidence: computeSourceConfidence(candidate),
    governanceValue: computeGovernanceValue(candidate),
    supportingSourceCount: computeSupportingSourceCount(candidate),
    collisionCount: computeCollisionCount(candidate),
    clusterStrength: computeClusterStrength(candidate)
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
 * Derives the recommended action kind based on candidate characteristics.
 *
 * @param {object} enriched
 * @returns {string}
 */
function deriveRecommendedActionKind(enriched) {
  if (enriched.governanceValue >= 0.7) return 'governance_review';
  if (enriched.noveltyScore >= 0.8 || enriched.novelty >= 0.8) return 'deep_investigation';
  if (enriched.evidenceDensity >= 0.7) return 'evidence_synthesis';
  if (enriched.crossDomainScore >= 0.7) return 'cross_domain_bridge';
  return 'standard_review';
}

/**
 * Builds a compact candidate summary for action layer consumption.
 *
 * @param {object} enriched
 * @returns {string}
 */
function buildCandidateSummary(enriched) {
  const type = (enriched.candidateType || 'unknown').replace(/_/g, ' ');
  const cells = (enriched.cells || []).join(',');
  const score = enriched.candidateScore || 0;
  const novelty = enriched.noveltyScore || enriched.novelty || 0;
  return `${type} across cells [${cells}] — score ${score}, novelty ${novelty}, ` +
    `${enriched.supportingSourceCount || 0} sources`;
}

/**
 * Builds a short reasoning trace from enriched candidate data.
 *
 * @param {object} enriched
 * @returns {string}
 */
function buildReasoningTraceShort(enriched) {
  const parts = [];
  if (enriched.crossDomain || enriched.spansDomains) {
    parts.push('cross-domain signal detected');
  }
  if ((enriched.noveltyScore || enriched.novelty || 0) >= 0.7) {
    parts.push('high novelty');
  }
  if (enriched.evidenceDensity >= 0.6) {
    parts.push('strong evidence convergence');
  }
  if (enriched.collisionCount > 0) {
    parts.push(`${enriched.collisionCount} collision(s)`);
  }
  if (enriched.clusterStrength > 0.3) {
    parts.push('active cluster');
  }
  if (parts.length === 0) {
    parts.push('candidate identified via cube emergence');
  }
  return parts.join(' → ');
}

/**
 * Extracts evidence references from the enriched candidate.
 *
 * @param {object} enriched
 * @returns {object[]}
 */
function extractEvidenceRefs(enriched) {
  return (enriched.sources || []).map(src => {
    if (typeof src === 'string') {
      return { sourceType: src, sourceId: src };
    }
    return {
      sourceType: src.sourceType || 'unknown',
      sourceId: src.sourceId || src.source || ''
    };
  });
}

/**
 * Extracts primary cell descriptors from the enriched candidate.
 *
 * @param {object} enriched
 * @returns {object[]}
 */
function extractPrimaryCells(enriched) {
  const cells = enriched.cells || [];
  const axes = enriched.axes || [];
  return cells.map((cellId, i) => ({
    cellId,
    axes: axes[i] || null
  }));
}

/**
 * Extracts domain axis labels from the enriched candidate.
 *
 * @param {object} enriched
 * @returns {object}
 */
function extractDomainAxes(enriched) {
  const axes = enriched.axes || [];
  return {
    what: [...new Set(axes.map(a => a && a.what).filter(Boolean))],
    where: [...new Set(axes.map(a => a && a.where).filter(Boolean))],
    time: [...new Set(axes.map(a => a && a.time).filter(Boolean))]
  };
}

/**
 * Converts an enriched candidate to a proposal-shaped payload
 * suitable for submission to openclashd-v2's /api/agents/propose endpoint.
 * Includes richer fields for action layer and governance consumption.
 *
 * @param {object} enriched - Enriched candidate
 * @param {string} agentId - Agent identity
 * @returns {object} Proposal-shaped object
 */
function candidateToProposalPayload(enriched, agentId = 'clashd27') {
  return {
    agentId,
    title: enriched.explanation || `Discovery candidate: ${enriched.id}`,
    candidateSummary: buildCandidateSummary(enriched),
    reasoningTraceShort: buildReasoningTraceShort(enriched),
    recommendedActionKind: deriveRecommendedActionKind(enriched),
    intent: {
      kind: 'intent',
      key: `intent.discovery.${enriched.candidateType || 'investigate'}`,
      payload: {
        candidateId: enriched.id,
        candidateType: enriched.candidateType,
        candidateScore: enriched.candidateScore,
        noveltyScore: enriched.noveltyScore,
        novelty: enriched.novelty,
        evidenceDensity: enriched.evidenceDensity,
        crossDomainScore: enriched.crossDomainScore,
        sourceConfidence: enriched.sourceConfidence,
        governanceValue: enriched.governanceValue,
        supportingSourceCount: enriched.supportingSourceCount,
        collisionCount: enriched.collisionCount,
        clusterStrength: enriched.clusterStrength,
        crossDomain: enriched.crossDomain || enriched.spansDomains || false,
        cells: enriched.cells,
        axes: enriched.axes,
        sources: enriched.sources,
        evidenceRefs: extractEvidenceRefs(enriched),
        primaryCells: extractPrimaryCells(enriched),
        domainAxes: extractDomainAxes(enriched)
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
  computeGovernanceValue,
  computeSupportingSourceCount,
  computeCollisionCount,
  computeClusterStrength,
  enrichCandidateWithRankingMetadata,
  enrichCandidates,
  candidateToProposalPayload,
  deriveRecommendedActionKind,
  buildCandidateSummary,
  buildReasoningTraceShort,
  extractEvidenceRefs,
  extractPrimaryCells,
  extractDomainAxes
};
