'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate an artifact ID from SHA256 of kind + title + createdAt.
 */
function generateArtifactId(kind, title, createdAt) {
  const input = `${kind}:${title}:${createdAt}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Persist a knowledge artifact as a JSON file using atomic writes.
 *
 * @param {object} discovery - The discovery/gap to persist
 * @param {string} discovery.kind - Artifact kind (e.g. 'gap', 'discovery', 'finding')
 * @param {string} discovery.title - Human-readable title
 * @param {string} discovery.summary - Brief summary of the artifact
 * @param {string[]} [discovery.sourceRefs] - References to source material
 * @param {object} [discovery.metadata] - Additional metadata
 * @param {string} dataDir - Base data directory
 * @returns {object} The persisted artifact
 */
function persistKnowledgeArtifact(discovery, dataDir) {
  if (!discovery || !discovery.kind || !discovery.title) {
    throw new Error('Knowledge artifact requires at least kind and title');
  }

  const knowledgeDir = path.join(dataDir, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
  }

  const createdAt = new Date().toISOString();
  const artifactId = generateArtifactId(discovery.kind, discovery.title, createdAt);

  const artifact = {
    artifactId,
    kind: discovery.kind,
    title: discovery.title,
    summary: discovery.summary || '',
    sourceRefs: discovery.sourceRefs || [],
    createdAt,
    metadata: discovery.metadata || {}
  };

  const filePath = path.join(knowledgeDir, `${artifactId}.json`);
  const tmpPath = filePath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(artifact, null, 2));
  fs.renameSync(tmpPath, filePath);

  return artifact;
}

/**
 * Load all knowledge artifacts from the knowledge directory.
 *
 * @param {string} dataDir - Base data directory
 * @returns {object[]} Array of artifact objects, sorted by createdAt descending
 */
function loadKnowledgeArtifacts(dataDir) {
  const knowledgeDir = path.join(dataDir, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) {
    return [];
  }

  const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  const artifacts = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf8');
      artifacts.push(JSON.parse(content));
    } catch (e) {
      // Skip malformed files
    }
  }

  artifacts.sort((a, b) => {
    if (!a.createdAt || !b.createdAt) return 0;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return artifacts;
}

module.exports = {
  persistKnowledgeArtifact,
  loadKnowledgeArtifacts
};
