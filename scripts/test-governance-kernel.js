'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isSandboxMode,
  GOVERNANCE_MODE,
  submitProposal,
  decideProposal,
  attachActionResult,
  getProposals,
  getRankedProposals,
  getDecidedProposals,
  getProposal,
  executeProposalAction,
  loadProposals,
  saveProposals
} = require('../lib/governance-kernel');

const {
  persistKnowledgeObject,
  getKnowledgeObject,
  getKnowledgeGraph,
  linkKnowledgeObjects,
  loadKnowledgeObjects,
  persistDecisionChain
} = require('../lib/knowledge-persistence');

const PROPOSALS_FILE = path.join(__dirname, '..', 'data', 'governance-proposals.json');
const KNOWLEDGE_FILE = path.join(__dirname, '..', 'data', 'knowledge-objects.json');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    console.error(`  \u2717 ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Clean start
function cleanup() {
  try { if (fs.existsSync(PROPOSALS_FILE)) fs.unlinkSync(PROPOSALS_FILE); } catch {}
  try { if (fs.existsSync(KNOWLEDGE_FILE)) fs.unlinkSync(KNOWLEDGE_FILE); } catch {}
}

cleanup();

console.log('governance-kernel tests\n');

// ---- Proposal lifecycle ----

console.log('  -- Proposal lifecycle --');

const sampleIntent = {
  kind: 'intent',
  key: 'intent.discovery.collision_intersection',
  payload: {
    candidateId: 'disc-col-abc',
    candidateType: 'collision_intersection',
    candidateScore: 0.75,
    novelty: 0.8,
    evidenceDensity: 0.6,
    crossDomainScore: 0.9,
    sourceConfidence: 0.7,
    crossDomain: true,
    cells: [5, 14],
    axes: [
      { what: 'trust-model', where: 'internal', time: 'current' },
      { what: 'surface', where: 'external', time: 'current' }
    ],
    sources: ['openalex', 'arxiv']
  },
  risk: 'green',
  requiresConsent: false
};

let proposalA, proposalB, proposalC;

test('submitProposal creates pending proposal with priority fields', () => {
  proposalA = submitProposal({
    agentId: 'clashd27',
    title: 'High-priority cross-domain collision',
    intent: sampleIntent
  });

  assert.ok(proposalA.id.startsWith('prop-'));
  assert.strictEqual(proposalA.status, 'pending');
  assert.ok(typeof proposalA.priorityScore === 'number');
  assert.ok(proposalA.priorityScore > 0);
  assert.ok(proposalA.priorityFactors);
  assert.ok(typeof proposalA.priorityExplanation === 'string');
  assert.strictEqual(proposalA.decidedAtIso, null);
  assert.strictEqual(proposalA.actionResult, null);
});

test('submitProposal creates second proposal with lower priority', () => {
  proposalB = submitProposal({
    agentId: 'clashd27',
    title: 'Low-priority single-domain gradient',
    intent: {
      kind: 'intent',
      key: 'intent.discovery.gradient_ascent',
      payload: {
        candidateId: 'disc-grad-xyz',
        candidateType: 'gradient_ascent',
        novelty: 0.3,
        evidenceDensity: 0.2,
        crossDomainScore: 0.1,
        sourceConfidence: 0.4
      },
      risk: 'green',
      requiresConsent: false
    }
  });

  assert.ok(proposalB.priorityScore < proposalA.priorityScore,
    `B priority (${proposalB.priorityScore}) should < A priority (${proposalA.priorityScore})`);
});

test('submitProposal creates third proposal', () => {
  proposalC = submitProposal({
    agentId: 'clashd27',
    title: 'Medium-priority investigation',
    intent: {
      kind: 'intent',
      key: 'intent.discovery.collision_intersection',
      payload: {
        candidateId: 'disc-col-med',
        novelty: 0.5,
        evidenceDensity: 0.5,
        crossDomainScore: 0.5,
        sourceConfidence: 0.5
      },
      risk: 'green',
      requiresConsent: false
    }
  });

  assert.ok(proposalC.id);
});

// ---- Ranked endpoint excludes decided ----

console.log('\n  -- Ranked queue (pending only) --');

test('getRankedProposals returns all 3 pending proposals', () => {
  const ranked = getRankedProposals();
  assert.strictEqual(ranked.length, 3);
  assert.ok(ranked.every(p => p.status === 'pending'));
  // Check ranked by priority desc
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].priorityScore >= ranked[i].priorityScore,
      `rank ${i} priority should be <= rank ${i - 1} priority`);
  }
  // Check rank field
  assert.strictEqual(ranked[0].rank, 1);
  assert.strictEqual(ranked[1].rank, 2);
  assert.strictEqual(ranked[2].rank, 3);
});

test('getRankedProposals preserves priority fields', () => {
  const ranked = getRankedProposals();
  const top = ranked[0];
  assert.ok(typeof top.priorityScore === 'number');
  assert.ok(typeof top.priorityFactors === 'object');
  assert.ok(typeof top.priorityExplanation === 'string');
  assert.ok(typeof top.rank === 'number');
});

test('decideProposal approves proposal A', () => {
  const decided = decideProposal(proposalA.id, 'approved', 'Strong cross-domain signal');
  assert.strictEqual(decided.status, 'approved');
  assert.ok(decided.decidedAtIso);
  assert.strictEqual(decided.decision.decision, 'approved');
  assert.strictEqual(decided.decision.reason, 'Strong cross-domain signal');
});

test('getRankedProposals excludes approved proposal', () => {
  const ranked = getRankedProposals();
  assert.strictEqual(ranked.length, 2);
  assert.ok(ranked.every(p => p.status === 'pending'));
  assert.ok(!ranked.find(p => p.id === proposalA.id), 'Approved proposal should not be in ranked');
  // Re-ranked: rank 1 and 2 only
  assert.strictEqual(ranked[0].rank, 1);
  assert.strictEqual(ranked[1].rank, 2);
});

test('decideProposal denies proposal B', () => {
  const decided = decideProposal(proposalB.id, 'denied', 'Insufficient evidence');
  assert.strictEqual(decided.status, 'denied');
});

test('getRankedProposals excludes denied proposal', () => {
  const ranked = getRankedProposals();
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].id, proposalC.id);
  assert.strictEqual(ranked[0].rank, 1);
});

// ---- Decided endpoint ----

console.log('\n  -- Decided endpoint --');

test('getDecidedProposals returns approved and denied', () => {
  const decided = getDecidedProposals();
  assert.strictEqual(decided.length, 2);
  assert.ok(decided.every(p => p.status === 'approved' || p.status === 'denied'));
  // Sorted by decidedAtIso desc
  assert.ok(decided[0].decidedAtIso >= decided[1].decidedAtIso);
});

test('getDecidedProposals respects limit', () => {
  const decided = getDecidedProposals(1);
  assert.strictEqual(decided.length, 1);
});

test('getProposals returns all proposals (full history)', () => {
  const all = getProposals();
  assert.strictEqual(all.length, 3);
});

// ---- Richer action results ----

console.log('\n  -- Action result model --');

test('attachActionResult adds structured metadata', () => {
  const result = attachActionResult(proposalA.id, {
    resultSummary: 'Research task created',
    resultType: 'research_task_created',
    outputObjectIds: ['obj-1', 'obj-2', 'obj-3'],
    outputCounts: { knowledgeObjects: 3 },
    notes: 'Created chain of 3 linked objects',
    createdKnowledgeObjectId: 'obj-2',
    initiatedFromProposalId: proposalA.id,
    initiatedIntentKey: 'intent.discovery.collision_intersection'
  });

  assert.ok(result);
  assert.ok(result.actionResult);
  assert.strictEqual(result.actionResult.resultSummary, 'Research task created');
  assert.strictEqual(result.actionResult.resultType, 'research_task_created');
  assert.strictEqual(result.actionResult.outputObjectIds.length, 3);
  assert.strictEqual(result.actionResult.outputCounts.knowledgeObjects, 3);
  assert.strictEqual(result.actionResult.createdKnowledgeObjectId, 'obj-2');
  assert.strictEqual(result.actionResult.initiatedFromProposalId, proposalA.id);
  assert.strictEqual(result.actionResult.initiatedIntentKey, 'intent.discovery.collision_intersection');
  assert.ok(result.actionResult.executedAtIso);
});

test('action result is backward-compatible (resultSummary always present)', () => {
  const proposal = getProposal(proposalA.id);
  assert.ok(typeof proposal.actionResult.resultSummary === 'string');
  assert.ok(proposal.actionResult.resultSummary.length > 0);
});

// ---- Knowledge linking ----

console.log('\n  -- Knowledge linking --');

test('linkKnowledgeObjects connects objects', () => {
  const objA = persistKnowledgeObject({
    kind: 'decision',
    title: 'Link test decision',
    summary: 'Test linking',
    sourceRefs: []
  });

  const objB = persistKnowledgeObject({
    kind: 'investigation_outcome',
    title: 'Link test investigation',
    summary: 'Test linking target',
    sourceRefs: []
  });

  const updated = linkKnowledgeObjects(objA.objectId, [objB.objectId]);
  assert.ok(updated);
  assert.ok(updated.linkedObjectIds.includes(objB.objectId));
});

test('linkKnowledgeObjects deduplicates', () => {
  const objects = loadKnowledgeObjects();
  const obj = objects[objects.length - 2]; // decision from previous test
  const target = objects[objects.length - 1];

  linkKnowledgeObjects(obj.objectId, [target.objectId]); // link again
  const refreshed = getKnowledgeObject(obj.objectId);
  const count = refreshed.linkedObjectIds.filter(id => id === target.objectId).length;
  assert.strictEqual(count, 1, 'Should not duplicate links');
});

test('persistDecisionChain creates 3 linked knowledge objects', () => {
  const chain = persistDecisionChain({
    proposalId: 'prop-chain-test',
    proposalTitle: 'Chain test proposal',
    intent: sampleIntent,
    decidedAtIso: new Date().toISOString()
  });

  assert.ok(chain.decision);
  assert.ok(chain.investigation);
  assert.ok(chain.receipt);
  assert.strictEqual(chain.objectIds.length, 3);

  assert.strictEqual(chain.decision.kind, 'decision');
  assert.strictEqual(chain.investigation.kind, 'investigation_outcome');
  assert.strictEqual(chain.receipt.kind, 'action_receipt');

  // All reference the proposal
  assert.ok(chain.decision.sourceRefs.some(r => r.sourceId === 'prop-chain-test'));
  assert.ok(chain.investigation.sourceRefs.some(r => r.sourceId === 'prop-chain-test'));
  assert.ok(chain.receipt.sourceRefs.some(r => r.sourceId === 'prop-chain-test'));
});

test('decision chain objects are linked correctly', () => {
  const objects = loadKnowledgeObjects();
  const decision = objects.find(o => o.kind === 'decision' && o.metadata.proposalId === 'prop-chain-test');
  const investigation = objects.find(o => o.kind === 'investigation_outcome' && o.metadata.proposalId === 'prop-chain-test');
  const receipt = objects.find(o => o.kind === 'action_receipt' && o.metadata.proposalId === 'prop-chain-test');

  assert.ok(decision, 'decision object should exist');
  assert.ok(investigation, 'investigation object should exist');
  assert.ok(receipt, 'receipt object should exist');

  // decision links to investigation and receipt
  assert.ok(decision.linkedObjectIds.includes(investigation.objectId),
    'decision should link to investigation');
  assert.ok(decision.linkedObjectIds.includes(receipt.objectId),
    'decision should link to receipt');

  // investigation links to receipt
  assert.ok(investigation.linkedObjectIds.includes(receipt.objectId),
    'investigation should link to receipt');
});

test('sourceRefs and linkedObjectIds are deterministic', () => {
  const objects = loadKnowledgeObjects();
  const decision = objects.find(o => o.kind === 'decision' && o.metadata.proposalId === 'prop-chain-test');

  // sourceRefs always contain the proposal reference
  assert.strictEqual(decision.sourceRefs[0].sourceType, 'proposal');
  assert.strictEqual(decision.sourceRefs[0].sourceId, 'prop-chain-test');

  // linkedObjectIds are arrays of strings
  assert.ok(Array.isArray(decision.linkedObjectIds));
  assert.ok(decision.linkedObjectIds.every(id => typeof id === 'string'));
});

// ---- Knowledge graph endpoint ----

console.log('\n  -- Knowledge graph --');

test('getKnowledgeGraph returns root and linked objects', () => {
  const objects = loadKnowledgeObjects();
  const decision = objects.find(o => o.kind === 'decision' && o.metadata.proposalId === 'prop-chain-test');

  const graph = getKnowledgeGraph(decision.objectId);
  assert.ok(graph.root);
  assert.strictEqual(graph.root.objectId, decision.objectId);
  assert.ok(graph.linked.length >= 2, `Should have at least 2 linked objects, got ${graph.linked.length}`);
});

test('getKnowledgeGraph includes reverse-linked objects', () => {
  const objects = loadKnowledgeObjects();
  const receipt = objects.find(o => o.kind === 'action_receipt' && o.metadata.proposalId === 'prop-chain-test');

  // Receipt is linked TO by decision and investigation, but may not link to anything itself
  const graph = getKnowledgeGraph(receipt.objectId);
  assert.ok(graph.root);
  // Should find objects that link to it (reverse links)
  assert.ok(graph.linked.length >= 1, `Receipt should have reverse links, got ${graph.linked.length}`);
});

test('getKnowledgeGraph returns empty linked for unknown ID', () => {
  const graph = getKnowledgeGraph('nonexistent-id');
  assert.strictEqual(graph.root, null);
  assert.strictEqual(graph.linked.length, 0);
});

// ---- executeProposalAction integration ----

console.log('\n  -- Action execution integration --');

test('executeProposalAction creates linked knowledge objects for approved proposal', () => {
  // Clean knowledge file for this test
  const beforeCount = loadKnowledgeObjects().length;

  const proposal = submitProposal({
    agentId: 'clashd27',
    title: 'Execute test proposal',
    intent: sampleIntent
  });
  decideProposal(proposal.id, 'approved', 'Execute test');

  const refreshed = getProposal(proposal.id);
  const result = executeProposalAction(refreshed, {
    persistKnowledgeObject,
    linkKnowledgeObjects
  });

  assert.strictEqual(result.resultType, 'research_task_created');
  assert.strictEqual(result.outputObjectIds.length, 3);
  assert.strictEqual(result.outputCounts.knowledgeObjects, 3);
  assert.ok(result.createdKnowledgeObjectId);
  assert.strictEqual(result.initiatedFromProposalId, proposal.id);
  assert.strictEqual(result.initiatedIntentKey, 'intent.discovery.collision_intersection');

  // Verify knowledge objects were actually created
  const afterCount = loadKnowledgeObjects().length;
  assert.ok(afterCount >= beforeCount + 3, 'Should have created 3 new knowledge objects');

  // Verify the created objects are linked
  const createdObj = getKnowledgeObject(result.outputObjectIds[0]);
  assert.ok(createdObj);
  assert.ok(createdObj.linkedObjectIds.length > 0, 'Created objects should be linked');
});

test('proposal has actionResult attached after execution', () => {
  const proposals = loadProposals();
  const executed = proposals.find(p => p.title === 'Execute test proposal');
  assert.ok(executed.actionResult);
  assert.strictEqual(executed.actionResult.resultType, 'research_task_created');
});

// ---- Mode guard ----

console.log('\n  -- Mode guard --');

test('isSandboxMode returns true when GOVERNANCE_MODE is sandbox', () => {
  assert.strictEqual(isSandboxMode(), true, 'Default mode should be sandbox');
  assert.strictEqual(GOVERNANCE_MODE, 'sandbox');
});

// Cleanup
cleanup();

console.log(`\n${passed} tests passed`);
