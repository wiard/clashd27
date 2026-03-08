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

  const objects = loadKnowledgeObjects();
  objects.push(object);
  saveKnowledgeObjects(objects);
  return object;
}

/**
 * Persists a discovery candidate as a knowledge artifact.
 */
function persistDiscoveryCandidate(candidate) {
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
      novelty: candidate.novelty,
      evidenceDensity: candidate.evidenceDensity,
      crossDomainScore: candidate.crossDomainScore,
      sourceConfidence: candidate.sourceConfidence
    }
  });
}

/**
 * Persists a finding (investigation result) as a knowledge artifact.
 */
function persistFinding(finding) {
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

module.exports = {
  persistKnowledgeObject,
  persistDiscoveryCandidate,
  persistFinding,
  getRecentKnowledgeObjects,
  getKnowledgeObjectsByKind,
  getKnowledgeObject,
  loadKnowledgeObjects
};
