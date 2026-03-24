'use strict';

const { mapToCubeCell } = require('../../lib/mapping-parity');
const { AXIS_WHAT, AXIS_WHERE, AXIS_TIME, normalizeSignal } = require('../../lib/clashd27-cube-engine');

const CUBE_MAPPING_VERSION = 'clashd27.cube-map.v1';

function normalizeSourceForParity(source) {
  const value = String(source || '').toLowerCase();
  if (value.includes('github') || value.includes('competitor')) return 'competitors';
  if (value.includes('openclaw')) return 'openclaw';
  if (value.includes('paper') || value.includes('theory') || value.includes('scientific')) return 'knowledge_openalex';
  if (value.includes('skill')) return 'internal';
  if (value.includes('lobby')) return 'lobby-proposals';
  return 'internal';
}

function mapSignalToCubeCell(rawSignal, opts = {}) {
  const normalized = normalizeSignal(rawSignal, opts);
  const parity = mapToCubeCell({
    text: (normalized.keywords || []).join(' '),
    category: rawSignal && (rawSignal.category || rawSignal.key || ''),
    source: normalizeSourceForParity(normalized.source),
    timestampIso: normalized.timestamp,
    publishedAtIso: rawSignal && rawSignal.publishedAtIso ? rawSignal.publishedAtIso : null
  });

  return {
    version: CUBE_MAPPING_VERSION,
    signalId: normalized.id,
    cellId: parity.cellIndex,
    axes: {
      what: parity.cubeCell[0],
      where: parity.cubeCell[1],
      time: parity.cubeCell[2]
    },
    keywords: normalized.keywords || [],
    normalizedSignal: normalized,
    parityConsistent: parity.cellIndex === normalized.cellId
  };
}

function mapSignalsToCube(signals, opts = {}) {
  return (signals || []).map(signal => mapSignalToCubeCell(signal, opts));
}

function summarizeNormalization(mappings) {
  const mapped = mappings || [];
  return {
    version: CUBE_MAPPING_VERSION,
    signalCount: mapped.length,
    parityConsistent: mapped.every(item => item.parityConsistent === true),
    cells: mapped.map(item => item.cellId)
  };
}

function buildAxesSignature(cells) {
  const seen = new Set();
  for (const cell of cells || []) {
    if (!cell || !cell.axes) continue;
    seen.add(`${cell.axes.what}/${cell.axes.where}/${cell.axes.time}`);
  }
  return [...seen].sort().join(' | ');
}

module.exports = {
  AXIS_WHAT,
  AXIS_WHERE,
  AXIS_TIME,
  CUBE_MAPPING_VERSION,
  buildAxesSignature,
  mapSignalToCubeCell,
  mapSignalsToCube,
  summarizeNormalization
};
