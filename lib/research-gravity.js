'use strict';

const { cellToCoords, manhattanDistance, AXIS_WHAT, AXIS_WHERE, AXIS_TIME } = require('./clashd27-cube-engine');

const CELL_COUNT = 27;

function round(num, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function cellAxes(cellId) {
  const { a, b, c } = cellToCoords(cellId);
  return {
    what: AXIS_WHAT[a],
    where: AXIS_WHERE[b],
    time: AXIS_TIME[c]
  };
}

function gravityBand(score) {
  if (score >= 6) return 'red';
  if (score >= 3) return 'yellow';
  if (score > 0) return 'green';
  return 'blue';
}

/**
 * Compute research gravity for each cell in the 27-cell cube.
 *
 * Gravity pulls research attention toward cells where multiple
 * signals converge: collisions, emergence clusters, high residue,
 * signal diversity, and gradient endpoints.
 *
 * @param {object} cubeState - The cube engine state
 * @param {object} emergenceSummary - Output of summarizeEmergence()
 * @returns {object[]} Array of 27 gravity cells sorted by gravityScore desc
 */
function computeResearchGravity(cubeState, emergenceSummary) {
  const cells = cubeState.cells || {};
  const collisions = emergenceSummary.collisions || [];
  const clusters = emergenceSummary.clusters || [];
  const gradients = emergenceSummary.gradients || [];
  const corridors = emergenceSummary.corridors || [];

  const collisionWeight = new Float64Array(CELL_COUNT);
  const clusterWeight = new Float64Array(CELL_COUNT);
  const gradientWeight = new Float64Array(CELL_COUNT);
  const corridorWeight = new Float64Array(CELL_COUNT);

  // Collision contribution: cells involved in collisions pull gravity
  for (const col of collisions) {
    const score = col.emergenceScore || 0;
    for (const cellId of (col.cells || [])) {
      const id = Number(cellId);
      if (id >= 0 && id < CELL_COUNT) {
        collisionWeight[id] += score * 2;
      }
    }
  }

  // Cluster contribution: cells in emergence clusters pull gravity
  for (const cluster of clusters) {
    const clusterScore = (cluster.totalScore || 0) / Math.max(1, cluster.size || 1);
    for (const cellId of (cluster.cells || [])) {
      const id = Number(cellId);
      if (id >= 0 && id < CELL_COUNT) {
        clusterWeight[id] += clusterScore * 1.5;
      }
    }
    // Strongest cell gets extra pull
    if (typeof cluster.strongestCell === 'number' && cluster.strongestCell < CELL_COUNT) {
      clusterWeight[cluster.strongestCell] += 0.5;
    }
  }

  // Gradient contribution: endpoint cells of gradients pull gravity
  for (const gradient of gradients) {
    const path = gradient.path || [];
    if (path.length >= 2) {
      const endpoint = path[path.length - 1];
      if (endpoint >= 0 && endpoint < CELL_COUNT) {
        gradientWeight[endpoint] += (gradient.slope || 0) * 1.2;
      }
      // Mid-path cells get smaller contribution
      for (let i = 1; i < path.length - 1; i++) {
        const mid = path[i];
        if (mid >= 0 && mid < CELL_COUNT) {
          gradientWeight[mid] += (gradient.slope || 0) * 0.3;
        }
      }
    }
  }

  // Corridor contribution: corridor cells pull sustained gravity
  for (const corridor of corridors) {
    const strength = corridor.strength || 0;
    for (const cellId of (corridor.path || [])) {
      const id = Number(cellId);
      if (id >= 0 && id < CELL_COUNT) {
        corridorWeight[id] += strength * 0.8;
      }
    }
  }

  const gravityCells = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    const cell = cells[String(i)] || {};
    const residueScore = cell.score || 0;
    const diversityFactor = clamp((cell.peerDiversity || 0) / 4, 0, 1);
    const timeFactor = clamp((cell.timeSpread || 0) / 8, 0, 1);
    const residuePressure = residueScore * (1 + diversityFactor) * (1 + timeFactor * 0.5);

    const gravityScore = round(
      collisionWeight[i] +
      clusterWeight[i] +
      gradientWeight[i] +
      corridorWeight[i] +
      residuePressure
    );

    const contributors = [];
    if (collisionWeight[i] > 0) contributors.push(`collisions(${round(collisionWeight[i])})`);
    if (clusterWeight[i] > 0) contributors.push(`clusters(${round(clusterWeight[i])})`);
    if (gradientWeight[i] > 0) contributors.push(`gradients(${round(gradientWeight[i])})`);
    if (corridorWeight[i] > 0) contributors.push(`corridors(${round(corridorWeight[i])})`);
    if (residuePressure > 0) contributors.push(`residue(${round(residuePressure)})`);

    gravityCells.push({
      cell: i,
      axes: cellAxes(i),
      gravityScore,
      band: gravityBand(gravityScore),
      collisions: round(collisionWeight[i]),
      clusters: round(clusterWeight[i]),
      gradients: round(gradientWeight[i]),
      corridors: round(corridorWeight[i]),
      residuePressure: round(residuePressure),
      contributors: contributors.length > 0 ? contributors : ['none']
    });
  }

  gravityCells.sort((a, b) => (b.gravityScore - a.gravityScore) || (a.cell - b.cell));
  return gravityCells;
}

/**
 * Select the top gravity hotspots from gravity cells.
 * A hotspot is a cell with gravity score above a threshold.
 *
 * @param {object[]} gravityCells - Output of computeResearchGravity()
 * @param {object} opts - Options
 * @param {number} opts.minScore - Minimum gravity score (default 1.0)
 * @param {number} opts.maxHotspots - Maximum number of hotspots (default 5)
 * @returns {object[]} Array of gravity hotspot events
 */
function selectGravityHotspots(gravityCells, opts = {}) {
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1.0;
  const maxHotspots = Number.isFinite(opts.maxHotspots) ? opts.maxHotspots : 5;

  const hotspots = gravityCells
    .filter(gc => gc.gravityScore >= minScore)
    .slice(0, maxHotspots);

  const now = new Date().toISOString();

  return hotspots.map((gc, rank) => ({
    type: 'gravity_hotspot',
    timestamp: now,
    cell: gc.cell,
    axes: gc.axes,
    gravityScore: gc.gravityScore,
    band: gc.band,
    rank: rank + 1,
    contributors: gc.contributors,
    explanation: buildGravityExplanation(gc)
  }));
}

function buildGravityExplanation(gc) {
  const parts = [];
  const { what, where, time } = gc.axes;
  parts.push(`Cell ${gc.cell} (${what}/${where}/${time})`);
  parts.push(`gravity ${gc.gravityScore} [${gc.band}]`);
  if (gc.collisions > 0) parts.push(`collisions pulling ${gc.collisions}`);
  if (gc.clusters > 0) parts.push(`cluster mass ${gc.clusters}`);
  if (gc.gradients > 0) parts.push(`gradient endpoint ${gc.gradients}`);
  if (gc.corridors > 0) parts.push(`corridor flow ${gc.corridors}`);
  if (gc.residuePressure > 0) parts.push(`residue pressure ${gc.residuePressure}`);
  return parts.join(' — ');
}

/**
 * Compute the gravity field summary: top hotspots, field shape, center of mass.
 */
function summarizeGravityField(gravityCells) {
  let totalMass = 0;
  let cx = 0, cy = 0, cz = 0;

  for (const gc of gravityCells) {
    if (gc.gravityScore <= 0) continue;
    const { a, b, c } = cellToCoords(gc.cell);
    totalMass += gc.gravityScore;
    cx += a * gc.gravityScore;
    cy += b * gc.gravityScore;
    cz += c * gc.gravityScore;
  }

  const centerOfMass = totalMass > 0
    ? {
        what: round(cx / totalMass),
        where: round(cy / totalMass),
        time: round(cz / totalMass)
      }
    : { what: 1, where: 1, time: 1 };

  const hotCells = gravityCells.filter(gc => gc.band === 'red' || gc.band === 'yellow');
  const coldCells = gravityCells.filter(gc => gc.band === 'blue');

  return {
    totalMass: round(totalMass),
    centerOfMass,
    hotCount: hotCells.length,
    coldCount: coldCells.length,
    peakCell: gravityCells[0] || null,
    distribution: {
      red: gravityCells.filter(gc => gc.band === 'red').length,
      yellow: gravityCells.filter(gc => gc.band === 'yellow').length,
      green: gravityCells.filter(gc => gc.band === 'green').length,
      blue: gravityCells.filter(gc => gc.band === 'blue').length
    }
  };
}

module.exports = {
  computeResearchGravity,
  selectGravityHotspots,
  summarizeGravityField,
  gravityBand
};
