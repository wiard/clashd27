'use strict';

const assert = require('assert');
const {
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
} = require('../lib/proposal-metadata');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('proposal-metadata tests\n');

const collisionCandidate = {
  id: 'disc-col-abc',
  type: 'collision_intersection',
  cells: [5, 14],
  axes: [
    { what: 'trust-model', where: 'internal', time: 'current' },
    { what: 'surface', where: 'external', time: 'current' }
  ],
  candidateScore: 0.75,
  emergenceScore: 0.8,
  combinedGravity: 3.5,
  crossDomain: true,
  sources: ['openalex', 'arxiv', 'github'],
  explanation: 'Collision between trust-model/internal and surface/external'
};

const gradientCandidate = {
  id: 'disc-grad-xyz',
  type: 'gradient_ascent',
  cells: [0, 3, 6, 9, 12],
  axes: [
    { what: 'trust-model', where: 'internal', time: 'historical' },
    { what: 'architecture', where: 'engine', time: 'current' }
  ],
  candidateScore: 0.6,
  slope: 0.4,
  pathLength: 5,
  gravityScore: 2.0,
  spansDomains: true,
  explanation: 'Ascending gradient across domains'
};

const clusterCandidate = {
  id: 'disc-clust-qrs',
  type: 'cluster_peak',
  cells: [1, 2, 4, 5],
  axes: [{ what: 'surface', where: 'internal', time: 'current' }],
  candidateScore: 0.55,
  clusterSize: 4,
  gravityScore: 1.8,
  sources: ['openalex', 'pubmed'],
  explanation: 'Cluster peak at surface/internal/current'
};

// --- Novelty ---
test('computeNovelty returns 0-1 for collision candidate', () => {
  const novelty = computeNovelty(collisionCandidate);
  assert.ok(novelty >= 0 && novelty <= 1, `novelty ${novelty} out of range`);
  assert.ok(novelty > 0.5, `cross-domain collision should have high novelty (${novelty})`);
});

test('computeNovelty returns 0-1 for gradient candidate', () => {
  const novelty = computeNovelty(gradientCandidate);
  assert.ok(novelty >= 0 && novelty <= 1);
});

// --- Evidence density ---
test('computeEvidenceDensity returns 0-1', () => {
  const density = computeEvidenceDensity(collisionCandidate);
  assert.ok(density >= 0 && density <= 1, `density ${density} out of range`);
  assert.ok(density > 0.3, `multi-source candidate should have evidence density > 0.3 (${density})`);
});

// --- Cross domain ---
test('computeCrossDomainScore higher for cross-domain candidates', () => {
  const crossScore = computeCrossDomainScore(collisionCandidate);
  const noCross = computeCrossDomainScore({ ...collisionCandidate, crossDomain: false, spansDomains: false });
  assert.ok(crossScore > noCross, `cross (${crossScore}) should > no-cross (${noCross})`);
});

// --- Source confidence ---
test('computeSourceConfidence maps candidateScore', () => {
  const confidence = computeSourceConfidence(collisionCandidate);
  assert.strictEqual(confidence, 0.75);
});

// --- Governance value ---
test('computeGovernanceValue returns 0-1', () => {
  const value = computeGovernanceValue(collisionCandidate);
  assert.ok(value >= 0 && value <= 1, `governanceValue ${value} out of range`);
});

test('computeGovernanceValue higher for cross-domain collision with many sources', () => {
  const crossCollision = computeGovernanceValue(collisionCandidate);
  const singleDomain = computeGovernanceValue({ ...collisionCandidate, crossDomain: false, type: 'gradient_ascent', sources: ['one'] });
  assert.ok(crossCollision > singleDomain, `cross-domain collision (${crossCollision}) should > single-domain gradient (${singleDomain})`);
});

// --- Supporting source count ---
test('computeSupportingSourceCount returns integer', () => {
  const count = computeSupportingSourceCount(collisionCandidate);
  assert.strictEqual(count, 3);
});

test('computeSupportingSourceCount handles empty sources', () => {
  assert.strictEqual(computeSupportingSourceCount({}), 0);
});

// --- Collision count ---
test('computeCollisionCount returns integer for collision type', () => {
  const count = computeCollisionCount(collisionCandidate);
  assert.ok(Number.isInteger(count) && count >= 1, `collision count should be >= 1, got ${count}`);
});

test('computeCollisionCount returns 0 for non-collision type', () => {
  const count = computeCollisionCount(gradientCandidate);
  assert.strictEqual(count, 0);
});

// --- Cluster strength ---
test('computeClusterStrength returns 0-1 for cluster peak', () => {
  const strength = computeClusterStrength(clusterCandidate);
  assert.ok(strength >= 0 && strength <= 1, `clusterStrength ${strength} out of range`);
  assert.ok(strength > 0, 'cluster peak should have positive clusterStrength');
});

test('computeClusterStrength returns 0 for non-cluster type', () => {
  assert.strictEqual(computeClusterStrength(collisionCandidate), 0);
});

// --- Enrichment ---
test('enrichCandidateWithRankingMetadata adds all new fields', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  assert.ok('novelty' in enriched);
  assert.ok('noveltyScore' in enriched);
  assert.ok('evidenceDensity' in enriched);
  assert.ok('crossDomainScore' in enriched);
  assert.ok('candidateType' in enriched);
  assert.ok('sourceConfidence' in enriched);
  assert.ok('governanceValue' in enriched);
  assert.ok('supportingSourceCount' in enriched);
  assert.ok('collisionCount' in enriched);
  assert.ok('clusterStrength' in enriched);
  assert.strictEqual(enriched.candidateType, 'collision_intersection');
  // noveltyScore and novelty should be the same
  assert.strictEqual(enriched.noveltyScore, enriched.novelty);
});

test('enrichCandidates enriches array', () => {
  const enriched = enrichCandidates([collisionCandidate, gradientCandidate]);
  assert.strictEqual(enriched.length, 2);
  assert.ok(enriched[0].novelty !== undefined);
  assert.ok(enriched[1].novelty !== undefined);
  assert.ok(enriched[0].governanceValue !== undefined);
  assert.ok(enriched[1].governanceValue !== undefined);
});

test('enrichCandidates handles empty array', () => {
  assert.deepStrictEqual(enrichCandidates([]), []);
  assert.deepStrictEqual(enrichCandidates(null), []);
});

test('all enriched scores are bounded 0-1', () => {
  const candidates = [collisionCandidate, gradientCandidate, clusterCandidate];
  const enriched = enrichCandidates(candidates);
  for (const e of enriched) {
    for (const field of ['noveltyScore', 'novelty', 'evidenceDensity', 'crossDomainScore', 'sourceConfidence', 'governanceValue', 'clusterStrength']) {
      const val = e[field];
      assert.ok(val >= 0 && val <= 1, `${field} = ${val} out of [0,1] for ${e.id}`);
    }
    assert.ok(Number.isInteger(e.supportingSourceCount), `supportingSourceCount should be integer: ${e.supportingSourceCount}`);
    assert.ok(Number.isInteger(e.collisionCount), `collisionCount should be integer: ${e.collisionCount}`);
  }
});

// --- Proposal payload ---
test('candidateToProposalPayload produces valid shape with new fields', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const payload = candidateToProposalPayload(enriched, 'clashd27');

  assert.strictEqual(payload.agentId, 'clashd27');
  assert.ok(payload.title.length > 0);
  assert.ok(typeof payload.candidateSummary === 'string');
  assert.ok(payload.candidateSummary.length > 0);
  assert.ok(typeof payload.reasoningTraceShort === 'string');
  assert.ok(payload.reasoningTraceShort.length > 0);
  assert.ok(typeof payload.recommendedActionKind === 'string');
  assert.strictEqual(payload.intent.kind, 'intent');
  assert.ok(payload.intent.key.startsWith('intent.discovery.'));
  assert.strictEqual(payload.intent.risk, 'green');

  // New payload fields
  const p = payload.intent.payload;
  assert.ok(p.noveltyScore !== undefined, 'should have noveltyScore');
  assert.ok(p.novelty !== undefined, 'should have novelty (backward compat)');
  assert.ok(p.evidenceDensity !== undefined);
  assert.ok(p.crossDomainScore !== undefined);
  assert.ok(p.governanceValue !== undefined);
  assert.ok(p.supportingSourceCount !== undefined);
  assert.ok(p.collisionCount !== undefined);
  assert.ok(p.clusterStrength !== undefined);
  assert.ok(Array.isArray(p.evidenceRefs));
  assert.ok(Array.isArray(p.primaryCells));
  assert.ok(typeof p.domainAxes === 'object');
  assert.ok(Array.isArray(p.domainAxes.what));
  assert.ok(Array.isArray(p.domainAxes.where));
  assert.ok(Array.isArray(p.domainAxes.time));
});

test('candidateToProposalPayload evidenceRefs match sources', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const payload = candidateToProposalPayload(enriched);
  const refs = payload.intent.payload.evidenceRefs;
  assert.strictEqual(refs.length, 3);
  assert.ok(refs.every(r => r.sourceType && typeof r.sourceId === 'string'));
});

test('candidateToProposalPayload primaryCells match cells', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const payload = candidateToProposalPayload(enriched);
  const cells = payload.intent.payload.primaryCells;
  assert.strictEqual(cells.length, 2);
  assert.strictEqual(cells[0].cellId, 5);
  assert.ok(cells[0].axes !== null);
});

test('candidateToProposalPayload domainAxes are non-empty for cross-domain', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const payload = candidateToProposalPayload(enriched);
  const axes = payload.intent.payload.domainAxes;
  assert.ok(axes.what.length >= 2, 'cross-domain should have >= 2 what axes');
  assert.ok(axes.where.length >= 1);
});

// --- Action kind derivation ---
test('deriveRecommendedActionKind returns valid kinds', () => {
  const validKinds = ['governance_review', 'deep_investigation', 'evidence_synthesis', 'cross_domain_bridge', 'standard_review'];
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const kind = deriveRecommendedActionKind(enriched);
  assert.ok(validKinds.includes(kind), `unexpected kind: ${kind}`);
});

// --- Summary and reasoning ---
test('buildCandidateSummary includes key info', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const summary = buildCandidateSummary(enriched);
  assert.ok(summary.includes('collision intersection'));
  assert.ok(summary.includes('sources'));
});

test('buildReasoningTraceShort non-empty for enriched candidate', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const trace = buildReasoningTraceShort(enriched);
  assert.ok(trace.length > 0);
});

// --- Evidence and cell extraction ---
test('extractEvidenceRefs handles string and object sources', () => {
  const refs = extractEvidenceRefs({ sources: ['arxiv', { sourceType: 'openalex', sourceId: 'oa-123' }] });
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0].sourceType, 'arxiv');
  assert.strictEqual(refs[1].sourceType, 'openalex');
  assert.strictEqual(refs[1].sourceId, 'oa-123');
});

test('extractPrimaryCells maps cells to axes', () => {
  const cells = extractPrimaryCells(collisionCandidate);
  assert.strictEqual(cells.length, 2);
  assert.strictEqual(cells[0].cellId, 5);
  assert.ok(cells[0].axes.what === 'trust-model');
});

test('extractDomainAxes returns unique axis values', () => {
  const axes = extractDomainAxes(collisionCandidate);
  assert.ok(axes.what.includes('trust-model'));
  assert.ok(axes.what.includes('surface'));
  assert.ok(axes.where.includes('internal'));
  assert.ok(axes.where.includes('external'));
});

console.log(`\n${passed} tests passed`);
