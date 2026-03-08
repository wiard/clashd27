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

test('persistDiscoveryCandidate persists candidate', () => {
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
    novelty: 0.7,
    evidenceDensity: 0.6,
    crossDomainScore: 0.8,
    sourceConfidence: 0.8
  };

  const obj = persistDiscoveryCandidate(candidate);
  assert.strictEqual(obj.kind, 'discovery');
  assert.ok(obj.title.includes('Test collision'));
  assert.ok(obj.metadata.candidateId);
});

test('persistFinding persists investigation finding', () => {
  const finding = {
    id: 'finding-test-1',
    discovery: 'Important cross-domain gap',
    hypothesis: 'Could lead to new insights',
    abc_chain: [
      { claim: 'Claim A', source: 'arxiv-1', confidence: 0.9 }
    ],
    scores: { novelty: 85, feasibility: 70, impact: 80 },
    abc_verified: true,
    kill_test: 'Find existing review paper'
  };

  const obj = persistFinding(finding);
  assert.strictEqual(obj.kind, 'investigation_outcome');
  assert.ok(obj.title.includes('cross-domain gap'));
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

test('file on disk contains persisted objects', () => {
  const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 3);
});

// Cleanup
try {
  if (fs.existsSync(KNOWLEDGE_FILE)) {
    fs.unlinkSync(KNOWLEDGE_FILE);
  }
} catch {}

console.log(`\n${passed} tests passed`);
