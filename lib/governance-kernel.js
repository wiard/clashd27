'use strict';

/**
 * SANDBOX-MODE governance kernel for clashd27.
 *
 * This module provides a local, self-contained proposal lifecycle
 * (submit -> rank -> decide -> execute -> receipt) for standalone
 * development, testing, and single-repo demos.
 *
 * In the full 3-repo system (clashd27 + openclashd-v2 + openclaw),
 * openclashd-v2 is the canonical governance/action kernel.  clashd27
 * submits proposals TO openclashd-v2 via its gateway and never owns
 * the decision or execution path in production.
 *
 * Set GOVERNANCE_MODE=sandbox (or leave unset) to enable these
 * endpoints.  Any other value disables them so that governance
 * traffic is routed to openclashd-v2 instead.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GOVERNANCE_MODE = process.env.GOVERNANCE_MODE || 'sandbox';

function isSandboxMode() {
  return GOVERNANCE_MODE === 'sandbox';
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROPOSALS_FILE = path.join(DATA_DIR, 'governance-proposals.json');
const MAX_PROPOSALS = 500;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadProposals() {
  try {
    const raw = fs.readFileSync(PROPOSALS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProposals(proposals) {
  const bounded = proposals.slice(-MAX_PROPOSALS);
  const tmpPath = PROPOSALS_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(bounded, null, 2), 'utf8');
  fs.renameSync(tmpPath, PROPOSALS_FILE);
}

function generateProposalId() {
  return 'prop-' + crypto.randomBytes(6).toString('hex');
}

// ---------------------------------------------------------------------------
// Priority scoring
// ---------------------------------------------------------------------------

function computePriorityScore(intent) {
  const payload = intent.payload || {};
  const novelty = payload.novelty || 0;
  const evidenceDensity = payload.evidenceDensity || 0;
  const crossDomainScore = payload.crossDomainScore || 0;
  const sourceConfidence = payload.sourceConfidence || 0;

  const score =
    novelty * 0.35 +
    evidenceDensity * 0.25 +
    crossDomainScore * 0.25 +
    sourceConfidence * 0.15;

  return round(Math.max(0, Math.min(1, score)));
}

function computePriorityFactors(intent) {
  const payload = intent.payload || {};
  return {
    novelty: payload.novelty || 0,
    evidenceDensity: payload.evidenceDensity || 0,
    crossDomainScore: payload.crossDomainScore || 0,
    sourceConfidence: payload.sourceConfidence || 0
  };
}

function computePriorityExplanation(factors, score) {
  const parts = [];
  if (factors.novelty >= 0.7) parts.push('high novelty');
  else if (factors.novelty >= 0.4) parts.push('moderate novelty');
  if (factors.evidenceDensity >= 0.6) parts.push('strong evidence');
  if (factors.crossDomainScore >= 0.7) parts.push('cross-domain');
  if (factors.sourceConfidence >= 0.7) parts.push('high confidence');
  if (parts.length === 0) parts.push('baseline priority');
  return `Score ${score}: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Proposal lifecycle
// ---------------------------------------------------------------------------

/**
 * Submit a new proposal.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.title
 * @param {object} input.intent - { kind, key, payload, risk, requiresConsent }
 * @returns {object} The created proposal
 */
function submitProposal(input) {
  const proposals = loadProposals();
  const now = new Date().toISOString();
  const id = generateProposalId();

  const priorityFactors = computePriorityFactors(input.intent || {});
  const priorityScore = computePriorityScore(input.intent || {});
  const priorityExplanation = computePriorityExplanation(priorityFactors, priorityScore);

  const proposal = {
    id,
    agentId: input.agentId || 'unknown',
    title: input.title || 'Untitled proposal',
    intent: input.intent || {},
    status: 'pending',
    createdAtIso: now,
    decidedAtIso: null,
    decision: null,
    priorityScore,
    priorityFactors,
    priorityExplanation,
    actionResult: null
  };

  proposals.push(proposal);
  saveProposals(proposals);
  return proposal;
}

/**
 * Decide on a proposal (approve or deny).
 *
 * @param {string} proposalId
 * @param {string} decision - 'approved' or 'denied'
 * @param {string} [reason]
 * @returns {object|null} Updated proposal, or null if not found
 */
function decideProposal(proposalId, decision, reason) {
  const proposals = loadProposals();
  const proposal = proposals.find(p => p.id === proposalId);
  if (!proposal) return null;
  if (proposal.status !== 'pending') return proposal;

  proposal.status = decision;
  proposal.decision = { decision, reason: reason || '', decidedAtIso: new Date().toISOString() };
  proposal.decidedAtIso = proposal.decision.decidedAtIso;

  saveProposals(proposals);
  return proposal;
}

/**
 * Attach action execution result to a proposal.
 *
 * @param {string} proposalId
 * @param {object} result
 * @param {string} result.resultSummary - Short summary
 * @param {string} [result.resultType] - e.g. 'research_task_created'
 * @param {string[]} [result.outputObjectIds] - IDs of created knowledge objects
 * @param {object} [result.outputCounts] - e.g. { knowledgeObjects: 3 }
 * @param {string} [result.notes]
 * @param {string} [result.createdKnowledgeObjectId]
 * @param {string} [result.initiatedFromProposalId]
 * @param {string} [result.initiatedIntentKey]
 * @returns {object|null}
 */
function attachActionResult(proposalId, result) {
  const proposals = loadProposals();
  const proposal = proposals.find(p => p.id === proposalId);
  if (!proposal) return null;

  proposal.actionResult = {
    executedAtIso: new Date().toISOString(),
    resultSummary: result.resultSummary || '',
    resultType: result.resultType || null,
    outputObjectIds: result.outputObjectIds || [],
    outputCounts: result.outputCounts || {},
    notes: result.notes || null,
    createdKnowledgeObjectId: result.createdKnowledgeObjectId || null,
    initiatedFromProposalId: result.initiatedFromProposalId || proposalId,
    initiatedIntentKey: result.initiatedIntentKey || (proposal.intent && proposal.intent.key) || null
  };

  saveProposals(proposals);
  return proposal;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Get all proposals (full history), most recent first.
 */
function getProposals(limit = 50) {
  const proposals = loadProposals();
  return proposals
    .sort((a, b) => (b.createdAtIso || '').localeCompare(a.createdAtIso || ''))
    .slice(0, limit);
}

/**
 * Get ranked pending proposals.
 * Only includes status === 'pending', ranked by priorityScore desc.
 */
function getRankedProposals() {
  const proposals = loadProposals();
  const pending = proposals.filter(p => p.status === 'pending');

  pending.sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

  return pending.map((p, index) => ({
    ...p,
    rank: index + 1
  }));
}

/**
 * Get recently decided proposals (approved/denied), sorted by decidedAtIso desc.
 */
function getDecidedProposals(limit = 20) {
  const proposals = loadProposals();
  return proposals
    .filter(p => p.status === 'approved' || p.status === 'denied')
    .sort((a, b) => (b.decidedAtIso || '').localeCompare(a.decidedAtIso || ''))
    .slice(0, limit);
}

/**
 * Get a single proposal by ID.
 */
function getProposal(proposalId) {
  const proposals = loadProposals();
  return proposals.find(p => p.id === proposalId) || null;
}

// ---------------------------------------------------------------------------
// Action execution (start_research_task)
// ---------------------------------------------------------------------------

/**
 * Execute the action associated with an approved proposal.
 * For start_research_task intents, creates knowledge objects and links them.
 *
 * @param {object} proposal - An approved proposal
 * @param {object} deps - { persistKnowledgeObject, linkKnowledgeObjects }
 * @returns {object} The action result
 */
function executeProposalAction(proposal, deps) {
  const { persistKnowledgeObject, linkKnowledgeObjects } = deps;
  const intentKey = (proposal.intent && proposal.intent.key) || '';

  if (intentKey.startsWith('intent.discovery.')) {
    return executeResearchTask(proposal, { persistKnowledgeObject, linkKnowledgeObjects });
  }

  // Default: no-op action with minimal receipt
  const result = {
    resultSummary: `No handler for intent: ${intentKey}`,
    resultType: 'no_op',
    outputObjectIds: [],
    outputCounts: {}
  };
  attachActionResult(proposal.id, result);
  return result;
}

function executeResearchTask(proposal, deps) {
  const { persistKnowledgeObject, linkKnowledgeObjects } = deps;
  const payload = (proposal.intent && proposal.intent.payload) || {};

  // 1. Create decision knowledge object
  const decisionObj = persistKnowledgeObject({
    kind: 'decision',
    title: `Decision: ${proposal.title}`,
    summary: `Approved proposal ${proposal.id} for research investigation`,
    sourceRefs: [
      { sourceType: 'proposal', sourceId: proposal.id, label: proposal.title }
    ],
    metadata: {
      proposalId: proposal.id,
      decision: 'approved',
      intentKey: proposal.intent.key,
      decidedAtIso: proposal.decidedAtIso
    }
  });

  // 2. Create investigation_outcome knowledge object
  const investigationObj = persistKnowledgeObject({
    kind: 'investigation_outcome',
    title: `Investigation: ${proposal.title}`,
    summary: `Research task initiated from proposal ${proposal.id}`,
    sourceRefs: [
      { sourceType: 'proposal', sourceId: proposal.id, label: proposal.title },
      { sourceType: 'candidate', sourceId: payload.candidateId || '', label: payload.candidateType || '' }
    ],
    metadata: {
      proposalId: proposal.id,
      candidateId: payload.candidateId,
      candidateType: payload.candidateType,
      novelty: payload.novelty,
      evidenceDensity: payload.evidenceDensity,
      crossDomainScore: payload.crossDomainScore
    }
  });

  // 3. Create action_receipt knowledge object
  const receiptObj = persistKnowledgeObject({
    kind: 'action_receipt',
    title: `Receipt: ${proposal.title}`,
    summary: `Action receipt for research task from proposal ${proposal.id}`,
    sourceRefs: [
      { sourceType: 'proposal', sourceId: proposal.id, label: proposal.title }
    ],
    metadata: {
      proposalId: proposal.id,
      actionType: 'start_research_task',
      executedAtIso: new Date().toISOString()
    }
  });

  // 4. Link the chain: decision -> investigation_outcome -> action_receipt
  linkKnowledgeObjects(decisionObj.objectId, [investigationObj.objectId]);
  linkKnowledgeObjects(investigationObj.objectId, [receiptObj.objectId]);
  // Also link all to the originating proposal reference
  linkKnowledgeObjects(decisionObj.objectId, [investigationObj.objectId, receiptObj.objectId]);

  const outputObjectIds = [decisionObj.objectId, investigationObj.objectId, receiptObj.objectId];

  const result = {
    resultSummary: `Research task created with 3 linked knowledge objects`,
    resultType: 'research_task_created',
    outputObjectIds,
    outputCounts: { knowledgeObjects: 3 },
    notes: `Chain: decision(${decisionObj.objectId}) -> investigation(${investigationObj.objectId}) -> receipt(${receiptObj.objectId})`,
    createdKnowledgeObjectId: investigationObj.objectId,
    initiatedFromProposalId: proposal.id,
    initiatedIntentKey: proposal.intent.key
  };

  attachActionResult(proposal.id, result);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(num, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

module.exports = {
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
  computePriorityScore,
  computePriorityFactors,
  loadProposals,
  saveProposals
};
