'use strict';

const crypto = require('crypto');

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHypothesis(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeHypothesis(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function uniqueSorted(values) {
  return Array.from(new Set((values || []).map((value) => normalizeText(value)).filter(Boolean))).sort();
}

function extractHypothesis(value) {
  if (!value || typeof value !== 'object') return '';
  return normalizeText(
    value.hypothesis && value.hypothesis.statement
      ? value.hypothesis.statement
      : value.hypothesis
        ? value.hypothesis
        : value.gapProposalHandoff && value.gapProposalHandoff.packet
          && value.gapProposalHandoff.packet.metadata && value.gapProposalHandoff.packet.metadata.hypothesis
          && value.gapProposalHandoff.packet.metadata.hypothesis.statement
          ? value.gapProposalHandoff.packet.metadata.hypothesis.statement
          : value.candidate && value.candidate.explanation
            ? value.candidate.explanation
            : ''
  );
}

function normalizeCell(cell) {
  if (cell == null) return '';
  if (typeof cell === 'number') return `cell-${cell}`;
  if (typeof cell === 'string') return normalizeText(cell);
  if (typeof cell === 'object') {
    return normalizeText(`${cell.what || 'unknown'}/${cell.where || 'unknown'}/${cell.time || 'unknown'}`);
  }
  return '';
}

function extractCells(value) {
  if (!value || typeof value !== 'object') return [];

  if (Array.isArray(value.cells) && value.cells.length > 0) {
    return uniqueSorted(value.cells.map(normalizeCell));
  }

  if (Array.isArray(value.candidate && value.candidate.axes) && value.candidate.axes.length > 0) {
    return uniqueSorted(value.candidate.axes.map(normalizeCell));
  }

  if (Array.isArray(value.candidate && value.candidate.cells) && value.candidate.cells.length > 0) {
    return uniqueSorted(value.candidate.cells.map(normalizeCell));
  }

  if (Array.isArray(value.cube && value.cube.cells) && value.cube.cells.length > 0) {
    return uniqueSorted(value.cube.cells.map(normalizeCell));
  }

  const axesSignature = normalizeText(value.cube && value.cube.axesSignature);
  if (axesSignature && axesSignature.includes('/')) {
    return uniqueSorted(
      axesSignature
        .split(/\s*x\s*|,\s*/)
        .map((part) => normalizeText(part))
        .filter((part) => part.includes('/'))
    );
  }

  return [];
}

function extractAxis(cells) {
  const primary = Array.isArray(cells) ? cells[0] || '' : '';
  if (!primary) return 'unknown';
  if (primary.startsWith('cell-')) return 'cell';
  return normalizeText(primary.split('/')[0]) || 'unknown';
}

function extractCore(value) {
  return normalizeHypothesis(extractHypothesis(value)).slice(0, 80);
}

function normalizeCollisionType(value) {
  const raw = normalizeText(
    value && value.candidate && value.candidate.type
      ? value.candidate.type
      : value && value.collisionType
        ? value.collisionType
        : value && value.candidateType
          ? value.candidateType
          : value && value.gapType
            ? value.gapType
            : 'unknown'
  ).toLowerCase();

  if (raw.includes('collision')) return 'collision';
  if (raw.includes('cluster')) return 'cluster';
  if (raw.includes('gradient')) return 'gradient';
  return raw || 'unknown';
}

function buildCanonicalString(value) {
  const cells = extractCells(value);
  const axis = extractAxis(cells);
  const hypothesisCore = extractCore(value);
  const collisionType = normalizeCollisionType(value);
  return [
    cells.join(','),
    axis,
    hypothesisCore,
    collisionType
  ].join('|');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function fingerprintGap(gapPacket) {
  return sha256(buildCanonicalString(gapPacket)).slice(0, 16);
}

function fingerprintFromLibraryEntry(entry) {
  return sha256(buildCanonicalString(entry)).slice(0, 16);
}

function cellOverlap(left, right) {
  const a = new Set(extractCells(left));
  const b = new Set(extractCells(right));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const cell of a) {
    if (b.has(cell)) intersection += 1;
  }
  return intersection / Math.max(a.size, b.size);
}

function wordOverlap(left, right) {
  const a = new Set(tokenize(extractHypothesis(left)));
  const b = new Set(tokenize(extractHypothesis(right)));
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function similarityScore(packetA, packetB) {
  const cells = cellOverlap(packetA, packetB);
  const words = wordOverlap(packetA, packetB);
  return Math.max(0, Math.min(1, (cells * 0.6) + (words * 0.4)));
}

function areSameGap(packetA, packetB) {
  return fingerprintGap(packetA) === fingerprintGap(packetB);
}

module.exports = {
  areSameGap,
  buildCanonicalString,
  extractAxis,
  extractCells,
  extractCore,
  extractHypothesis,
  fingerprintFromLibraryEntry,
  fingerprintGap,
  normalizeCollisionType,
  similarityScore
};
