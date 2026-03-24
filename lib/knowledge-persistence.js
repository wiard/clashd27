'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge-objects.json');
const MAX_OBJECTS = 500;

/**
 * Persistent knowledge store for clashd27 discovery outcomes.
 * Append-safe JSON file with bounded size.
 */

function loadKnowledgeObjects() {
  try {
    const raw = fs.readFileSync(KNOWLEDGE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveKnowledgeObjects(objects) {
  const bounded = objects.slice(-MAX_OBJECTS);
  const tmpPath = KNOWLEDGE_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(bounded, null, 2), 'utf8');
  fs.renameSync(tmpPath, KNOWLEDGE_FILE);
}

function computeObjectId(kind, title, createdAtIso) {
  const seed = `${kind}|${title}|${createdAtIso}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Persists a discovery outcome as a knowledge object.
 *
 * @param {object} input
 * @param {string} input.kind - discovery | investigation_outcome | evidence
 * @param {string} input.title
 * @param {string} input.summary
 * @param {object[]} [input.sourceRefs] - Array of { sourceType, sourceId, url?, label? }
 * @param {object} [input.metadata] - Additional metadata
 * @param {string} [input.parentCandidateId] - ID of the parent candidate that produced this object
 * @param {string[]} [input.relatedCandidateIds] - IDs of related candidates
 * @param {number} [input.originatingTick] - Tick number when this object was generated
 * @param {string} [input.originatingClusterId] - Cluster ID from emergence detection
 * @param {object} [input.graphHints] - Hints for downstream knowledge graph construction
 * @returns {object} The persisted knowledge object
 */
function persistKnowledgeObject(input) {
  const createdAtIso = new Date().toISOString();
  const objectId = computeObjectId(input.kind, input.title, createdAtIso);

  const object = {
    objectId,
    kind: input.kind,
    createdAtIso,
    title: input.title,
    summary: input.summary,
    sourceRefs: input.sourceRefs || [],
    linkedObjectIds: input.linkedObjectIds || [],
    metadata: input.metadata || {}
  };

  // Linkable identifiers for downstream graph systems
  if (input.parentCandidateId) {
    object.parentCandidateId = input.parentCandidateId;
  }
  if (Array.isArray(input.relatedCandidateIds) && input.relatedCandidateIds.length > 0) {
    object.relatedCandidateIds = input.relatedCandidateIds;
  }
  if (typeof input.originatingTick === 'number') {
    object.originatingTick = input.originatingTick;
  }
  if (input.originatingClusterId) {
    object.originatingClusterId = input.originatingClusterId;
  }
  if (input.graphHints && typeof input.graphHints === 'object') {
    object.graphHints = input.graphHints;
  }

  const objects = loadKnowledgeObjects();
  objects.push(object);
  saveKnowledgeObjects(objects);
  return object;
}

/**
 * Persists a discovery candidate as a knowledge artifact.
 */
function persistDiscoveryCandidate(candidate, opts = {}) {
  const axes = candidate.axes || [];
  const domainAxes = {
    what: [...new Set(axes.map(a => a && a.what).filter(Boolean))],
    where: [...new Set(axes.map(a => a && a.where).filter(Boolean))],
    time: [...new Set(axes.map(a => a && a.time).filter(Boolean))]
  };

  return persistKnowledgeObject({
    kind: 'discovery',
    title: candidate.explanation || `Discovery: ${candidate.id}`,
    summary: `Score: ${candidate.candidateScore}, Type: ${candidate.type}, ` +
      `Cross-domain: ${candidate.crossDomain || candidate.spansDomains || false}`,
    sourceRefs: (candidate.sources || []).map(src => ({
      sourceType: typeof src === 'string' ? src : src.sourceType || 'unknown',
      sourceId: typeof src === 'string' ? src : src.sourceId || ''
    })),
    metadata: {
      candidateId: candidate.id,
      candidateType: candidate.type,
      candidateScore: candidate.candidateScore,
      cells: candidate.cells,
      axes: candidate.axes,
      novelty: candidate.noveltyScore || candidate.novelty,
      evidenceDensity: candidate.evidenceDensity,
      crossDomainScore: candidate.crossDomainScore,
      sourceConfidence: candidate.sourceConfidence,
      governanceValue: candidate.governanceValue,
      supportingSourceCount: candidate.supportingSourceCount,
      collisionCount: candidate.collisionCount,
      clusterStrength: candidate.clusterStrength,
      domainAxes
    },
    parentCandidateId: candidate.id,
    relatedCandidateIds: opts.relatedCandidateIds || [],
    originatingTick: opts.tick,
    originatingClusterId: opts.clusterId || null,
    graphHints: {
      nodeType: candidate.type || 'discovery',
      edgeLabels: (candidate.crossDomain || candidate.spansDomains)
        ? ['cross_domain_bridge'] : ['single_domain'],
      domainAxes,
      weight: candidate.candidateScore || 0
    }
  });
}

/**
 * Persists a finding (investigation result) as a knowledge artifact.
 */
function persistFinding(finding, opts = {}) {
  return persistKnowledgeObject({
    kind: 'investigation_outcome',
    title: finding.discovery || finding.title || 'Investigation finding',
    summary: finding.hypothesis || finding.summary || '',
    sourceRefs: (finding.abc_chain || []).map(claim => ({
      sourceType: 'abc_chain',
      sourceId: claim.source || '',
      label: claim.claim
    })),
    metadata: {
      findingId: finding.id,
      tick: finding.tick,
      cell: finding.cell,
      scores: finding.scores,
      abc_verified: finding.abc_verified,
      kill_test: finding.kill_test
    },
    parentCandidateId: opts.parentCandidateId || finding.candidateId || null,
    relatedCandidateIds: opts.relatedCandidateIds || [],
    originatingTick: finding.tick || opts.tick,
    originatingClusterId: opts.clusterId || null,
    graphHints: {
      nodeType: 'investigation_outcome',
      edgeLabels: finding.abc_verified ? ['verified_chain'] : ['unverified'],
      weight: finding.scores ? (finding.scores.total || 0) / 100 : 0
    }
  });
}

/**
 * Retrieves recent knowledge objects.
 */
function getRecentKnowledgeObjects(limit = 20) {
  const objects = loadKnowledgeObjects();
  return objects
    .sort((a, b) => (b.createdAtIso || '').localeCompare(a.createdAtIso || ''))
    .slice(0, limit);
}

/**
 * Retrieves knowledge objects by kind.
 */
function getKnowledgeObjectsByKind(kind, limit = 20) {
  const objects = loadKnowledgeObjects();
  return objects
    .filter(o => o.kind === kind)
    .sort((a, b) => (b.createdAtIso || '').localeCompare(a.createdAtIso || ''))
    .slice(0, limit);
}

/**
 * Retrieves a single knowledge object by ID.
 */
function getKnowledgeObject(objectId) {
  const objects = loadKnowledgeObjects();
  return objects.find(o => o.objectId === objectId) || null;
}

// ---------------------------------------------------------------------------
// Knowledge linking utilities
// ---------------------------------------------------------------------------

/**
 * Link one knowledge object to one or more target objects.
 * Updates linkedObjectIds on the source object, deduplicating entries.
 *
 * @param {string} sourceObjectId - The object to add links to
 * @param {string[]} targetObjectIds - IDs to link
 * @returns {object|null} Updated source object, or null if not found
 */
function linkKnowledgeObjects(sourceObjectId, targetObjectIds) {
  const objects = loadKnowledgeObjects();
  const source = objects.find(o => o.objectId === sourceObjectId);
  if (!source) return null;

  const existing = new Set(source.linkedObjectIds || []);
  for (const id of targetObjectIds) {
    existing.add(id);
  }
  source.linkedObjectIds = [...existing];

  saveKnowledgeObjects(objects);
  return source;
}

/**
 * Get a knowledge object and all directly connected objects (its graph neighborhood).
 *
 * @param {string} objectId - Root object ID
 * @returns {{ root: object|null, linked: object[] }}
 */
function getKnowledgeGraph(objectId) {
  const objects = loadKnowledgeObjects();
  const root = objects.find(o => o.objectId === objectId) || null;
  if (!root) return { root: null, linked: [] };

  const linkedIds = new Set(root.linkedObjectIds || []);

  // Also find objects that link TO this root (reverse links)
  for (const obj of objects) {
    if (obj.objectId !== objectId && (obj.linkedObjectIds || []).includes(objectId)) {
      linkedIds.add(obj.objectId);
    }
  }

  const linked = objects.filter(o => linkedIds.has(o.objectId));
  return { root, linked };
}

/**
 * Persist a full decision chain (decision -> investigation_outcome -> action_receipt)
 * all linked together and referencing the originating proposal.
 *
 * @param {object} opts
 * @param {string} opts.proposalId
 * @param {string} opts.proposalTitle
 * @param {object} opts.intent
 * @param {string} opts.decidedAtIso
 * @returns {{ decision: object, investigation: object, receipt: object, objectIds: string[] }}
 */
function persistDecisionChain(opts) {
  const { proposalId, proposalTitle, intent, decidedAtIso } = opts;
  const payload = (intent && intent.payload) || {};

  const proposalRef = { sourceType: 'proposal', sourceId: proposalId, label: proposalTitle };

  const decision = persistKnowledgeObject({
    kind: 'decision',
    title: `Decision: ${proposalTitle}`,
    summary: `Approved proposal ${proposalId} for research investigation`,
    sourceRefs: [proposalRef],
    metadata: {
      proposalId,
      decision: 'approved',
      intentKey: intent && intent.key,
      decidedAtIso
    }
  });

  const investigation = persistKnowledgeObject({
    kind: 'investigation_outcome',
    title: `Investigation: ${proposalTitle}`,
    summary: `Research task initiated from proposal ${proposalId}`,
    sourceRefs: [
      proposalRef,
      { sourceType: 'candidate', sourceId: payload.candidateId || '', label: payload.candidateType || '' }
    ],
    metadata: {
      proposalId,
      candidateId: payload.candidateId,
      candidateType: payload.candidateType,
      novelty: payload.novelty,
      evidenceDensity: payload.evidenceDensity,
      crossDomainScore: payload.crossDomainScore
    }
  });

  const receipt = persistKnowledgeObject({
    kind: 'action_receipt',
    title: `Receipt: ${proposalTitle}`,
    summary: `Action receipt for research task from proposal ${proposalId}`,
    sourceRefs: [proposalRef],
    metadata: {
      proposalId,
      actionType: 'start_research_task',
      executedAtIso: new Date().toISOString()
    }
  });

  // Link chain: decision -> investigation -> receipt
  linkKnowledgeObjects(decision.objectId, [investigation.objectId, receipt.objectId]);
  linkKnowledgeObjects(investigation.objectId, [receipt.objectId]);

  return {
    decision,
    investigation,
    receipt,
    objectIds: [decision.objectId, investigation.objectId, receipt.objectId]
  };
}

module.exports = {
  persistKnowledgeObject,
  persistDiscoveryCandidate,
  persistFinding,
  getRecentKnowledgeObjects,
  getKnowledgeObjectsByKind,
  getKnowledgeObject,
  loadKnowledgeObjects,
  linkKnowledgeObjects,
  getKnowledgeGraph,
  persistDecisionChain
};
