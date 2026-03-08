'use strict';

const assert = require('assert');
const {
  computeNovelty,
  computeEvidenceDensity,
  computeCrossDomainScore,
  computeSourceConfidence,
  enrichCandidateWithRankingMetadata,
  enrichCandidates,
  candidateToProposalPayload
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

test('computeNovelty returns 0-1 for collision candidate', () => {
  const novelty = computeNovelty(collisionCandidate);
  assert.ok(novelty >= 0 && novelty <= 1, `novelty ${novelty} out of range`);
  assert.ok(novelty > 0.5, `cross-domain collision should have high novelty (${novelty})`);
});

test('computeNovelty returns 0-1 for gradient candidate', () => {
  const novelty = computeNovelty(gradientCandidate);
  assert.ok(novelty >= 0 && novelty <= 1);
});

test('computeEvidenceDensity returns 0-1', () => {
  const density = computeEvidenceDensity(collisionCandidate);
  assert.ok(density >= 0 && density <= 1, `density ${density} out of range`);
  assert.ok(density > 0.3, `multi-source candidate should have evidence density > 0.3 (${density})`);
});

test('computeCrossDomainScore higher for cross-domain candidates', () => {
  const crossScore = computeCrossDomainScore(collisionCandidate);
  const noCross = computeCrossDomainScore({ ...collisionCandidate, crossDomain: false, spansDomains: false });
  assert.ok(crossScore > noCross, `cross (${crossScore}) should > no-cross (${noCross})`);
});

test('computeSourceConfidence maps candidateScore', () => {
  const confidence = computeSourceConfidence(collisionCandidate);
  assert.strictEqual(confidence, 0.75);
});

test('enrichCandidateWithRankingMetadata adds all fields', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  assert.ok('novelty' in enriched);
  assert.ok('evidenceDensity' in enriched);
  assert.ok('crossDomainScore' in enriched);
  assert.ok('candidateType' in enriched);
  assert.ok('sourceConfidence' in enriched);
  assert.strictEqual(enriched.candidateType, 'collision_intersection');
});

test('enrichCandidates enriches array', () => {
  const enriched = enrichCandidates([collisionCandidate, gradientCandidate]);
  assert.strictEqual(enriched.length, 2);
  assert.ok(enriched[0].novelty !== undefined);
  assert.ok(enriched[1].novelty !== undefined);
});

test('enrichCandidates handles empty array', () => {
  assert.deepStrictEqual(enrichCandidates([]), []);
  assert.deepStrictEqual(enrichCandidates(null), []);
});

test('candidateToProposalPayload produces valid shape', () => {
  const enriched = enrichCandidateWithRankingMetadata(collisionCandidate);
  const payload = candidateToProposalPayload(enriched, 'clashd27');

  assert.strictEqual(payload.agentId, 'clashd27');
  assert.ok(payload.title.length > 0);
  assert.strictEqual(payload.intent.kind, 'intent');
  assert.ok(payload.intent.key.startsWith('intent.discovery.'));
  assert.strictEqual(payload.intent.risk, 'green');
  assert.ok(payload.intent.payload.novelty !== undefined);
  assert.ok(payload.intent.payload.evidenceDensity !== undefined);
  assert.ok(payload.intent.payload.crossDomainScore !== undefined);
});

console.log(`\n${passed} tests passed`);
