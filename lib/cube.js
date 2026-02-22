/**
 * CLASHD-27 Cube Mathematics
 * 3×3×3 cube with 27 cells (0-26)
 * Cell mapping: cell = z*9 + y*3 + x where x,y,z ∈ {0,1,2}
 *
 * Three layers:
 *   Layer 0 (cells 0–8):   THE FLOOR
 *   Layer 1 (cells 9–17):  NO HATS ALLOWED
 *   Layer 2 (cells 18–26): MOD 27 ZONE
 *
 * Three neighbor types (by how many axes differ):
 *   FACE   — 1 axis differs  — direct, strong
 *   EDGE   — 2 axes differ   — diagonal, moderate
 *   CORNER — 3 axes differ   — deepest diagonal, rare
 */

const NEIGHBOR_TYPE = {
  FACE: 'face',
  EDGE: 'edge',
  CORNER: 'corner',
};

const NEIGHBOR_INFO = {
  face:   { emoji: '🟥', label: 'Face',   desc: 'Direct — strong clash' },
  edge:   { emoji: '🟧', label: 'Edge',   desc: 'Diagonal — moderate clash' },
  corner: { emoji: '🟨', label: 'Corner', desc: 'Deep diagonal — rare clash' },
};

const LAYERS = [
  { name: 'THE FLOOR',        range: [0, 8],   emoji: '🪱', z: 0 },
  { name: 'NO HATS ALLOWED',  range: [9, 17],  emoji: '💯', z: 1 },
  { name: 'MOD 27 ZONE',      range: [18, 26], emoji: '🧠', z: 2 },
];

function getLayerName(cell) {
  return LAYERS[Math.floor(cell / 9)].name;
}

function getLayerInfo(cell) {
  return LAYERS[Math.floor(cell / 9)];
}

function cellToCoords(cell) {
  const x = cell % 3;
  const y = Math.floor(cell / 3) % 3;
  const z = Math.floor(cell / 9);
  return { x, y, z };
}

function coordsToCell(x, y, z) {
  return z * 9 + y * 3 + x;
}

function getNeighborType(cellA, cellB) {
  const a = cellToCoords(cellA);
  const b = cellToCoords(cellB);
  let diffs = 0;
  if (a.x !== b.x) diffs++;
  if (a.y !== b.y) diffs++;
  if (a.z !== b.z) diffs++;
  if (diffs === 1) return NEIGHBOR_TYPE.FACE;
  if (diffs === 2) return NEIGHBOR_TYPE.EDGE;
  if (diffs === 3) return NEIGHBOR_TYPE.CORNER;
  return null;
}

function isCrossLayer(cellA, cellB) {
  return Math.floor(cellA / 9) !== Math.floor(cellB / 9);
}

// Pre-compute all neighbor lists with types
const NEIGHBORS_TYPED = new Map();
const NEIGHBORS = new Map();

for (let cell = 0; cell < 27; cell++) {
  const { x, y, z } = cellToCoords(cell);
  const typed = [];
  const flat = [];

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx >= 0 && nx < 3 && ny >= 0 && ny < 3 && nz >= 0 && nz < 3) {
          const neighborCell = coordsToCell(nx, ny, nz);
          const type = getNeighborType(cell, neighborCell);
          typed.push({ cell: neighborCell, type });
          flat.push(neighborCell);
        }
      }
    }
  }

  NEIGHBORS_TYPED.set(cell, typed);
  NEIGHBORS.set(cell, flat);
}

function getNeighbors(cell) {
  return NEIGHBORS.get(cell) || [];
}

function getNeighborsTyped(cell) {
  return NEIGHBORS_TYPED.get(cell) || [];
}

function isNeighbor(cellA, cellB) {
  return NEIGHBORS.get(cellA)?.includes(cellB) || false;
}

function getNeighborsByType(cell) {
  const typed = NEIGHBORS_TYPED.get(cell) || [];
  return {
    face:   typed.filter(n => n.type === NEIGHBOR_TYPE.FACE).map(n => n.cell),
    edge:   typed.filter(n => n.type === NEIGHBOR_TYPE.EDGE).map(n => n.cell),
    corner: typed.filter(n => n.type === NEIGHBOR_TYPE.CORNER).map(n => n.cell),
  };
}

function cellLabel(cell) {
  const { x, y, z } = cellToCoords(cell);
  const xNames = ['L', 'C', 'R'];
  const yNames = ['F', 'M', 'B'];
  return `${LAYERS[z].name}-${yNames[y]}${xNames[x]}`;
}

function cellLabelShort(cell) {
  const { x, y, z } = cellToCoords(cell);
  const xNames = ['L', 'C', 'R'];
  const yNames = ['F', 'M', 'B'];
  const zNames = ['G', 'R', 'C'];
  return `${zNames[z]}${yNames[y]}${xNames[x]}`;
}

function renderLayer(z, occupants = new Map(), activeCell = -1) {
  const lines = [];
  const layer = LAYERS[z];
  lines.push(`**${layer.emoji} ${layer.name}** (cells ${layer.range[0]}–${layer.range[1]})`);

  for (let y = 2; y >= 0; y--) {
    const row = [];
    for (let x = 0; x < 3; x++) {
      const cell = coordsToCell(x, y, z);
      const count = occupants.get(cell) || 0;
      const padded = String(cell).padStart(2, '0');
      const isActive = cell === activeCell;
      if (isActive && count > 0) {
        row.push(`»${padded}:${count}«`);
      } else if (isActive) {
        row.push(`»${padded}  «`);
      } else if (count > 0) {
        row.push(`[${padded}:${count}]`);
      } else {
        row.push(`${padded}  `);
      }
    }
    lines.push('`' + row.join('|') + '`');
  }
  return lines.join('\n');
}

function renderCube(occupants = new Map(), activeCell = -1) {
  const lines = [];
  for (let z = 2; z >= 0; z--) {
    lines.push(renderLayer(z, occupants, activeCell));
    if (z > 0) lines.push('');
  }
  if (activeCell >= 0) {
    const nByType = getNeighborsByType(activeCell);
    lines.unshift(
      `🔥 Active: **${activeCell}** (${cellLabel(activeCell)})\n` +
      `🟥 Face: [${nByType.face.join(',')}] · 🟧 Edge: [${nByType.edge.join(',')}] · 🟨 Corner: [${nByType.corner.join(',')}]`
    );
  }
  return lines.join('\n');
}

function neighborSummary(cell) {
  const byType = getNeighborsByType(cell);
  const parts = [];
  if (byType.face.length)   parts.push(`🟥 Face(${byType.face.length}): [${byType.face.join(',')}]`);
  if (byType.edge.length)   parts.push(`🟧 Edge(${byType.edge.length}): [${byType.edge.join(',')}]`);
  if (byType.corner.length) parts.push(`🟨 Corner(${byType.corner.length}): [${byType.corner.join(',')}]`);
  return parts.join('\n');
}

function getLayerForCell(cell) {
  return Math.floor(cell / 9);
}

module.exports = {
  cellToCoords, coordsToCell,
  getNeighbors, getNeighborsTyped, getNeighborsByType, getNeighborType,
  isNeighbor, isCrossLayer, getLayerForCell,
  cellLabel, cellLabelShort, getLayerName, getLayerInfo,
  renderLayer, renderCube, neighborSummary,
  NEIGHBORS, NEIGHBORS_TYPED, NEIGHBOR_TYPE, NEIGHBOR_INFO, LAYERS,
};
