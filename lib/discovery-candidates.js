'use strict';

const { cellToCoords, manhattanDistance, AXIS_WHAT, AXIS_WHERE, AXIS_TIME } = require('./clashd27-cube-engine');

const CELL_COUNT = 27;

function round(num, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

function hash32(input) {
  const str = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cellAxes(cellId) {
  const { a, b, c } = cellToCoords(cellId);
  return {
    what: AXIS_WHAT[a],
    where: AXIS_WHERE[b],
    time: AXIS_TIME[c]
  };
}

/**
 * Detect discovery candidates by combining gravity hotspots, emergence
 * patterns, and collision data. A discovery candidate represents a
 * cross-domain intersection where new research insights may emerge.
 *
 * @param {object} input
 * @param {object[]} input.gravityCells - From computeResearchGravity()
 * @param {object} input.emergenceSummary - From summarizeEmergence()
 * @param {object} input.cubeState - Current cube engine state
 * @returns {object[]} Discovery candidates sorted by candidateScore desc
 */
function detectDiscoveryCandidates(input) {
  const { gravityCells, emergenceSummary, cubeState } = input;
  const cells = cubeState.cells || {};
  const collisions = emergenceSummary.collisions || [];
  const clusters = emergenceSummary.clusters || [];
  const gradients = emergenceSummary.gradients || [];

  const candidates = [];

  // Strategy 1: Collision pairs with high combined gravity
  for (const col of collisions) {
    if ((col.emergenceScore || 0) < 0.5) continue;
    const colCells = (col.cells || []).map(Number).filter(c => c >= 0 && c < CELL_COUNT);
    if (colCells.length < 2) continue;

    const gravityA = findGravityCell(gravityCells, colCells[0]);
    const gravityB = findGravityCell(gravityCells, colCells[1]);
    const combinedGravity = (gravityA ? gravityA.gravityScore : 0) + (gravityB ? gravityB.gravityScore : 0);

    if (combinedGravity < 0.5) continue;

    const axesA = cellAxes(colCells[0]);
    const axesB = cellAxes(colCells[1]);
    const crossDomain = axesA.what !== axesB.what || axesA.where !== axesB.where;

    const candidateScore = round(
      (col.emergenceScore * 0.4) +
      (combinedGravity * 0.3) +
      (crossDomain ? 0.2 : 0) +
      (col.sources.length / 5 * 0.1)
    );

    const id = `disc-col-${hash32(`${colCells[0]}-${colCells[1]}-${col.id}`)}`;
    candidates.push({
      id,
      type: 'collision_intersection',
      cells: colCells,
      axes: [axesA, axesB],
      candidateScore,
      emergenceScore: col.emergenceScore,
      combinedGravity: round(combinedGravity),
      crossDomain,
      sources: col.sources,
      explanation: buildCollisionExplanation(axesA, axesB, col, combinedGravity)
    });
  }

  // Strategy 2: Cluster peaks — strongest cell in each cluster as candidate
  for (const cluster of clusters) {
    if (cluster.size < 2) continue;
    const strongId = cluster.strongestCell;
    if (typeof strongId !== 'number' || strongId < 0 || strongId >= CELL_COUNT) continue;

    const gravity = findGravityCell(gravityCells, strongId);
    const gravityScore = gravity ? gravity.gravityScore : 0;
    if (gravityScore < 0.3) continue;

    const strongAxes = cellAxes(strongId);
    const cell = cells[String(strongId)] || {};
    const diverseSources = (cell.uniqueSourceTypes || []).length >= 2;

    const candidateScore = round(
      (gravityScore * 0.4) +
      ((cluster.totalScore / cluster.size) * 0.3) +
      (diverseSources ? 0.2 : 0) +
      (cluster.size / 5 * 0.1)
    );

    const id = `disc-clust-${hash32(`${cluster.id}-${strongId}`)}`;
    candidates.push({
      id,
      type: 'cluster_peak',
      cells: cluster.cells,
      axes: [strongAxes],
      candidateScore,
      peakCell: strongId,
      clusterSize: cluster.size,
      gravityScore: round(gravityScore),
      sources: cell.uniqueSourceTypes || [],
      explanation: buildClusterExplanation(strongAxes, cluster, gravityScore)
    });
  }

  // Strategy 3: Gradient endpoints — where score ascends may indicate emerging knowledge
  for (const gradient of gradients) {
    const path = gradient.path || [];
    if (path.length < 3) continue;

    const endpoint = path[path.length - 1];
    const gravity = findGravityCell(gravityCells, endpoint);
    const gravityScore = gravity ? gravity.gravityScore : 0;

    const startAxes = cellAxes(path[0]);
    const endAxes = cellAxes(endpoint);
    const spansDomains = startAxes.what !== endAxes.what || startAxes.where !== endAxes.where;

    const candidateScore = round(
      (gravityScore * 0.3) +
      ((gradient.slope || 0) * 0.4) +
      (spansDomains ? 0.2 : 0) +
      (path.length / 6 * 0.1)
    );

    if (candidateScore < 0.3) continue;

    const id = `disc-grad-${hash32(gradient.id)}`;
    candidates.push({
      id,
      type: 'gradient_ascent',
      cells: path,
      axes: [startAxes, endAxes],
      candidateScore,
      slope: gradient.slope,
      pathLength: path.length,
      gravityScore: round(gravityScore),
      spansDomains,
      explanation: buildGradientExplanation(startAxes, endAxes, gradient, gravityScore)
    });
  }

  // Deduplicate by overlapping cells
  const seen = new Set();
  const unique = [];
  candidates.sort((a, b) => (b.candidateScore - a.candidateScore) || (a.id < b.id ? -1 : 1));

  for (const candidate of candidates) {
    const key = candidate.cells.slice().sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique.slice(0, 10);
}

/**
 * Package discovery candidates as structured events for the observatory stream.
 */
function emitDiscoveryCandidateEvents(candidates) {
  const now = new Date().toISOString();
  return candidates.map((c, rank) => ({
    type: 'discovery_candidate',
    timestamp: now,
    candidateId: c.id,
    candidateType: c.type,
    candidateScore: c.candidateScore,
    rank: rank + 1,
    cells: c.cells,
    axes: c.axes,
    crossDomain: c.crossDomain || c.spansDomains || false,
    sources: c.sources || [],
    explanation: c.explanation
  }));
}

function findGravityCell(gravityCells, cellId) {
  return gravityCells.find(gc => gc.cell === cellId) || null;
}

function buildCollisionExplanation(axesA, axesB, col, combinedGravity) {
  return `Collision between ${axesA.what}/${axesA.where} and ${axesB.what}/${axesB.where} ` +
    `(emergence ${col.emergenceScore}, gravity ${round(combinedGravity)}) — ` +
    `${col.sources.length} sources converging across ${axesA.time} time domain`;
}

function buildClusterExplanation(axes, cluster, gravityScore) {
  return `Cluster of ${cluster.size} cells peaked at ${axes.what}/${axes.where}/${axes.time} ` +
    `(cluster score ${round(cluster.totalScore)}, gravity ${round(gravityScore)}) — ` +
    `sustained multi-cell activity suggests knowledge accumulation`;
}

function buildGradientExplanation(startAxes, endAxes, gradient, gravityScore) {
  return `Ascending gradient from ${startAxes.what}/${startAxes.where} to ${endAxes.what}/${endAxes.where} ` +
    `(slope ${gradient.slope}, gravity ${round(gravityScore)}) — ` +
    `${gradient.path.length}-step path indicates directional knowledge flow`;
}

module.exports = {
  detectDiscoveryCandidates,
  emitDiscoveryCandidateEvents
};
