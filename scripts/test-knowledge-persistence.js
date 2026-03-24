'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  persistKnowledgeObject,
  persistDiscoveryCandidate,
  persistFinding,
  getRecentKnowledgeObjects,
  getKnowledgeObjectsByKind,
  getKnowledgeObject,
  loadKnowledgeObjects
} = require('../lib/knowledge-persistence');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge-objects.json');

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

// Clean start
try {
  if (fs.existsSync(KNOWLEDGE_FILE)) {
    fs.unlinkSync(KNOWLEDGE_FILE);
  }
} catch {}

console.log('knowledge-persistence tests\n');

test('persistKnowledgeObject creates object with required fields', () => {
  const obj = persistKnowledgeObject({
    kind: 'discovery',
    title: 'Test discovery',
    summary: 'A test knowledge object',
    sourceRefs: [{ sourceType: 'paper', sourceId: 'arxiv-123' }]
  });

  assert.ok(obj.objectId);
  assert.strictEqual(obj.kind, 'discovery');
  assert.strictEqual(obj.title, 'Test discovery');
  assert.ok(obj.createdAtIso);
  assert.strictEqual(obj.sourceRefs.length, 1);
});

test('persistKnowledgeObject with linkable metadata', () => {
  const obj = persistKnowledgeObject({
    kind: 'evidence',
    title: 'Linked evidence',
    summary: 'Evidence with linking metadata',
    parentCandidateId: 'disc-col-test',
    relatedCandidateIds: ['disc-grad-test', 'disc-clust-test'],
    originatingTick: 42,
    originatingClusterId: 'cluster-abc',
    graphHints: {
      nodeType: 'evidence',
      edgeLabels: ['supports'],
      weight: 0.8
    }
  });

  assert.strictEqual(obj.parentCandidateId, 'disc-col-test');
  assert.deepStrictEqual(obj.relatedCandidateIds, ['disc-grad-test', 'disc-clust-test']);
  assert.strictEqual(obj.originatingTick, 42);
  assert.strictEqual(obj.originatingClusterId, 'cluster-abc');
  assert.ok(obj.graphHints);
  assert.strictEqual(obj.graphHints.nodeType, 'evidence');
  assert.deepStrictEqual(obj.graphHints.edgeLabels, ['supports']);
  assert.strictEqual(obj.graphHints.weight, 0.8);
});

test('persistKnowledgeObject omits linkable fields when not provided', () => {
  const obj = persistKnowledgeObject({
    kind: 'discovery',
    title: 'Minimal object',
    summary: 'No linking metadata'
  });

  assert.strictEqual(obj.parentCandidateId, undefined);
  assert.strictEqual(obj.relatedCandidateIds, undefined);
  assert.strictEqual(obj.originatingTick, undefined);
  assert.strictEqual(obj.originatingClusterId, undefined);
  assert.strictEqual(obj.graphHints, undefined);
});

test('persistDiscoveryCandidate persists candidate with new metadata', () => {
  const candidate = {
    id: 'disc-test-1',
    type: 'collision_intersection',
    candidateScore: 0.8,
    crossDomain: true,
    sources: ['openalex', 'arxiv'],
    cells: [5, 14],
    axes: [
      { what: 'trust-model', where: 'internal', time: 'current' },
      { what: 'surface', where: 'external', time: 'current' }
    ],
    explanation: 'Test collision',
    noveltyScore: 0.7,
    novelty: 0.7,
    evidenceDensity: 0.6,
    crossDomainScore: 0.8,
    sourceConfidence: 0.8,
    governanceValue: 0.65,
    supportingSourceCount: 2,
    collisionCount: 1,
    clusterStrength: 0
  };

  const obj = persistDiscoveryCandidate(candidate, { tick: 10, clusterId: 'clust-1' });
  assert.strictEqual(obj.kind, 'discovery');
  assert.ok(obj.title.includes('Test collision'));
  assert.ok(obj.metadata.candidateId);
  assert.strictEqual(obj.metadata.governanceValue, 0.65);
  assert.strictEqual(obj.metadata.supportingSourceCount, 2);
  assert.strictEqual(obj.metadata.collisionCount, 1);
  assert.ok(obj.metadata.domainAxes);
  assert.ok(obj.metadata.domainAxes.what.includes('trust-model'));
  assert.ok(obj.metadata.domainAxes.what.includes('surface'));

  // Linkable metadata
  assert.strictEqual(obj.parentCandidateId, 'disc-test-1');
  assert.strictEqual(obj.originatingTick, 10);
  assert.strictEqual(obj.originatingClusterId, 'clust-1');
  assert.ok(obj.graphHints);
  assert.strictEqual(obj.graphHints.nodeType, 'collision_intersection');
  assert.ok(obj.graphHints.edgeLabels.includes('cross_domain_bridge'));
  assert.strictEqual(obj.graphHints.weight, 0.8);
});

test('persistFinding persists investigation finding with linking', () => {
  const finding = {
    id: 'finding-test-1',
    discovery: 'Important cross-domain gap',
    hypothesis: 'Could lead to new insights',
    tick: 15,
    candidateId: 'disc-col-parent',
    abc_chain: [
      { claim: 'Claim A', source: 'arxiv-1', confidence: 0.9 }
    ],
    scores: { novelty: 85, feasibility: 70, impact: 80, total: 78 },
    abc_verified: true,
    kill_test: 'Find existing review paper'
  };

  const obj = persistFinding(finding, { clusterId: 'clust-2' });
  assert.strictEqual(obj.kind, 'investigation_outcome');
  assert.ok(obj.title.includes('cross-domain gap'));

  // Linkable metadata
  assert.strictEqual(obj.parentCandidateId, 'disc-col-parent');
  assert.strictEqual(obj.originatingTick, 15);
  assert.strictEqual(obj.originatingClusterId, 'clust-2');
  assert.ok(obj.graphHints);
  assert.strictEqual(obj.graphHints.nodeType, 'investigation_outcome');
  assert.ok(obj.graphHints.edgeLabels.includes('verified_chain'));
  assert.strictEqual(obj.graphHints.weight, 0.78);
});

test('getRecentKnowledgeObjects returns recent items', () => {
  const recent = getRecentKnowledgeObjects(10);
  assert.ok(Array.isArray(recent));
  assert.ok(recent.length >= 3);
  // Verify sorted descending by createdAtIso
  for (let i = 1; i < recent.length; i++) {
    assert.ok(recent[i - 1].createdAtIso >= recent[i].createdAtIso);
  }
});

test('getKnowledgeObjectsByKind filters correctly', () => {
  const discoveries = getKnowledgeObjectsByKind('discovery');
  assert.ok(discoveries.length >= 2);
  assert.ok(discoveries.every(o => o.kind === 'discovery'));
});

test('getKnowledgeObject retrieves by ID', () => {
  const all = loadKnowledgeObjects();
  assert.ok(all.length > 0);
  const first = all[0];
  const retrieved = getKnowledgeObject(first.objectId);
  assert.ok(retrieved);
  assert.strictEqual(retrieved.objectId, first.objectId);
});

test('getKnowledgeObject returns null for missing ID', () => {
  const result = getKnowledgeObject('nonexistent-id');
  assert.strictEqual(result, null);
});

test('file on disk contains persisted objects with linkable metadata', () => {
  const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 3);

  // Find the object with linking metadata
  const linked = parsed.find(o => o.parentCandidateId === 'disc-col-test');
  assert.ok(linked, 'should find object with parentCandidateId');
  assert.ok(linked.graphHints, 'should have graphHints');
  assert.strictEqual(linked.originatingTick, 42);
});

test('persisted candidate graphHints are stable and serializable', () => {
  const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const withHints = parsed.filter(o => o.graphHints);
  assert.ok(withHints.length > 0);
  for (const obj of withHints) {
    assert.ok(typeof obj.graphHints.nodeType === 'string');
    assert.ok(Array.isArray(obj.graphHints.edgeLabels));
    assert.ok(typeof obj.graphHints.weight === 'number');
    // Verify re-serialization stability
    const reserialized = JSON.parse(JSON.stringify(obj.graphHints));
    assert.deepStrictEqual(reserialized, obj.graphHints);
  }
});

// Cleanup
try {
  if (fs.existsSync(KNOWLEDGE_FILE)) {
    fs.unlinkSync(KNOWLEDGE_FILE);
  }
} catch {}

console.log(`\n${passed} tests passed`);
