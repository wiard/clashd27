'use strict';

const { cellToCoords, manhattanDistance, computeDomainDistance, AXIS_WHAT, AXIS_WHERE, AXIS_TIME } = require('./clashd27-cube-engine');

const CELL_COUNT = 27;
const MAX_DISCOVERY_HINTS = 5;

function round(num, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
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

function computeNoveltyScore(cells, cubeState) {
  const allCells = cubeState.cells || {};
  let totalNovelty = 0;
  let count = 0;
  for (const cellId of cells) {
    const axes = cellAxes(cellId);
    const timeScore = axes.time === 'emerging' ? 0.9 : axes.time === 'current' ? 0.6 : 0.3;
    totalNovelty += timeScore;
    count++;
  }
  return count > 0 ? round(totalNovelty / count) : 0.5;
}

function computeEvidenceDensity(cells, cubeState) {
  const allCells = cubeState.cells || {};
  const sources = new Set();
  let totalEvidenceScore = 0;
  let cellCount = 0;
  for (const cellId of cells) {
    const cell = allCells[String(cellId)] || {};
    for (const src of (cell.uniqueSourceTypes || [])) {
      sources.add(src);
    }
    // Factor in evidenceScore from the cell (evidence-backed signals)
    totalEvidenceScore += (cell.evidenceScore || 0);
    cellCount++;
  }
  const sourceComponent = Math.min(1, sources.size / 4);
  const evidenceComponent = cellCount > 0 ? Math.min(1, totalEvidenceScore / cellCount) : 0;
  return round(Math.min(1, sourceComponent * 0.7 + evidenceComponent * 0.3));
}

function computeSourceConfidence(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return 0.3;
  const unique = new Set(sources.map(s => typeof s === 'string' ? s : (s.sourceType || s)));
  return round(Math.min(1, 0.3 + (unique.size * 0.2)));
}

/**
 * Compute temporal trust: signals arriving across multiple time windows
 * receive a bonus reflecting temporal persistence or acceleration.
 */
function computeTemporalTrust(cells, cubeState) {
  const allCells = cubeState.cells || {};
  let maxTicks = 0;
  let maxTimeSpread = 0;
  for (const cellId of cells) {
    const cell = allCells[String(cellId)] || {};
    const ticks = cell.ticks || [];
    if (ticks.length > maxTicks) maxTicks = ticks.length;
    if ((cell.timeSpread || 0) > maxTimeSpread) maxTimeSpread = cell.timeSpread || 0;
  }
  let trust = 0;
  // Signals in 3+ distinct ticks → +0.1
  if (maxTicks >= 3) trust += 0.1;
  // Signals spread over many ticks → additional +0.05
  if (maxTicks >= 6) trust += 0.05;
  // Far-apart timestamps already reflected in cell scoring; add +0.15 if
  // the cell has signals across a wide temporal range (timeSpread >= 4)
  if (maxTimeSpread >= 4) trust += 0.15;
  return round(clamp(trust, 0, 0.3));
}

/**
 * Detect discovery candidates by combining gravity hotspots, emergence
 * patterns, and collision data. Uses domain distance scoring,
 * temporal trust, and evidence-aware ranking.
 *
 * Candidate ranking formula:
 *   0.35 * emergenceScore
 *   0.25 * gravityScore
 *   0.20 * domainDistance
 *   0.10 * evidenceDensity
 *   0.10 * sourceConfidence
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
    const domDist = col.domainDistance || computeDomainDistance(colCells[0], colCells[1]);
    const evidDensity = computeEvidenceDensity(colCells, cubeState);
    const srcConf = computeSourceConfidence(col.sources);
    const tempTrust = computeTemporalTrust(colCells, cubeState);

    // V2 ranking formula
    const candidateScore = round(
      (col.emergenceScore * 0.35) +
      (clamp(combinedGravity / 2, 0, 1) * 0.25) +
      (domDist / 0.3 * 0.20) +
      (evidDensity * 0.10) +
      (srcConf * 0.10)
    );

    const isFarField = (col.collisionType === 'far-field');
    const crossDomain = domDist > 0;

    const id = `disc-col-${hash32(`${colCells[0]}-${colCells[1]}-${col.id}`)}`;
    candidates.push({
      id,
      type: isFarField ? 'far_field_collision' : 'collision_intersection',
      cells: colCells,
      axes: [axesA, axesB],
      candidateScore,
      emergenceScore: col.emergenceScore,
      combinedGravity: round(combinedGravity),
      crossDomain,
      domainDistance: domDist,
      sources: col.sources,
      explanation: buildCollisionExplanation(axesA, axesB, col, combinedGravity, isFarField),
      rankingMetadata: {
        novelty: computeNoveltyScore(colCells, cubeState),
        evidenceDensity: evidDensity,
        crossDomainScore: domDist / 0.3,
        candidateType: isFarField ? 'far_field_collision' : 'collision_intersection',
        sourceConfidence: srcConf,
        temporalTrust: tempTrust,
        governanceConfidence: 0.5,
        collisionType: col.collisionType || 'near-field'
      }
    });
  }

  // Strategy 2: Cluster peaks
  for (const cluster of clusters) {
    if (cluster.size < 2) continue;
    const strongId = cluster.strongestCell;
    if (typeof strongId !== 'number' || strongId < 0 || strongId >= CELL_COUNT) continue;

    const gravity = findGravityCell(gravityCells, strongId);
    const gravityScore = gravity ? gravity.gravityScore : 0;
    if (gravityScore < 0.3) continue;

    const strongAxes = cellAxes(strongId);
    const cell = cells[String(strongId)] || {};
    const evidDensity = computeEvidenceDensity([strongId], cubeState);
    const srcConf = computeSourceConfidence(cell.uniqueSourceTypes || []);
    const tempTrust = computeTemporalTrust(cluster.cells, cubeState);

    // Compute domain distance as max pairwise distance within cluster
    let maxDomDist = 0;
    for (let i = 0; i < cluster.cells.length; i++) {
      for (let j = i + 1; j < cluster.cells.length; j++) {
        const d = computeDomainDistance(cluster.cells[i], cluster.cells[j]);
        if (d > maxDomDist) maxDomDist = d;
      }
    }

    const candidateScore = round(
      (clamp(cluster.totalScore / cluster.size, 0, 1) * 0.35) +
      (clamp(gravityScore / 3, 0, 1) * 0.25) +
      (maxDomDist / 0.3 * 0.20) +
      (evidDensity * 0.10) +
      (srcConf * 0.10)
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
      domainDistance: maxDomDist,
      sources: cell.uniqueSourceTypes || [],
      explanation: buildClusterExplanation(strongAxes, cluster, gravityScore),
      rankingMetadata: {
        novelty: computeNoveltyScore(cluster.cells, cubeState),
        evidenceDensity: evidDensity,
        crossDomainScore: maxDomDist / 0.3,
        candidateType: 'cluster_peak',
        sourceConfidence: srcConf,
        temporalTrust: tempTrust,
        governanceConfidence: 0.5
      }
    });
  }

  // Strategy 3: Gradient endpoints
  for (const gradient of gradients) {
    const path = gradient.path || [];
    if (path.length < 3) continue;

    const endpoint = path[path.length - 1];
    const gravity = findGravityCell(gravityCells, endpoint);
    const gravityScore = gravity ? gravity.gravityScore : 0;

    const startAxes = cellAxes(path[0]);
    const endAxes = cellAxes(endpoint);
    const domDist = computeDomainDistance(path[0], endpoint);
    const evidDensity = computeEvidenceDensity(path, cubeState);
    const srcConf = computeSourceConfidence([]);
    const tempTrust = computeTemporalTrust(path, cubeState);

    const candidateScore = round(
      ((gradient.slope || 0) * 0.35) +
      (clamp(gravityScore / 3, 0, 1) * 0.25) +
      (domDist / 0.3 * 0.20) +
      (evidDensity * 0.10) +
      (srcConf * 0.10)
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
      domainDistance: domDist,
      spansDomains: domDist > 0,
      explanation: buildGradientExplanation(startAxes, endAxes, gradient, gravityScore),
      rankingMetadata: {
        novelty: computeNoveltyScore(path, cubeState),
        evidenceDensity: evidDensity,
        crossDomainScore: domDist / 0.3,
        candidateType: 'gradient_ascent',
        sourceConfidence: srcConf,
        temporalTrust: tempTrust,
        governanceConfidence: 0.5
      }
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
 * Package discovery candidates as structured discovery hints for the
 * observatory stream and Jeeves morning briefing.
 * Capped at MAX_DISCOVERY_HINTS per cycle.
 */
function emitDiscoveryHints(candidates) {
  const now = new Date().toISOString();
  const capped = (candidates || []).slice(0, MAX_DISCOVERY_HINTS);
  return capped.map((c, rank) => {
    const meta = c.rankingMetadata || {};
    return {
      type: 'discovery_hint',
      timestamp: now,
      candidateId: c.id,
      topic: buildTopicLabel(c),
      candidateType: c.type,
      candidateScore: c.candidateScore,
      rank: rank + 1,
      cells: c.cells,
      axes: c.axes,
      crossDomain: c.crossDomain || c.spansDomains || false,
      domainDistance: c.domainDistance || 0,
      sources: c.sources || [],
      evidenceRefs: buildEvidenceRefs(c),
      noveltyScore: meta.novelty || 0,
      pressureScore: round(c.combinedGravity || c.gravityScore || 0),
      confidenceScore: round((meta.sourceConfidence || 0.3) * 0.5 + (meta.evidenceDensity || 0) * 0.5),
      temporalTrust: meta.temporalTrust || 0,
      governanceConfidence: meta.governanceConfidence || 0.5,
      whyItMatters: c.explanation || '',
      rankingMetadata: meta
    };
  });
}

/**
 * Legacy-compatible wrapper: emits discovery candidate events.
 */
function emitDiscoveryCandidateEvents(candidates) {
  const now = new Date().toISOString();
  return (candidates || []).map((c, rank) => ({
    type: 'discovery_candidate',
    timestamp: now,
    candidateId: c.id,
    candidateType: c.type,
    candidateScore: c.candidateScore,
    rank: rank + 1,
    cells: c.cells,
    axes: c.axes,
    crossDomain: c.crossDomain || c.spansDomains || false,
    domainDistance: c.domainDistance || 0,
    sources: c.sources || [],
    explanation: c.explanation,
    rankingMetadata: c.rankingMetadata || null
  }));
}

function findGravityCell(gravityCells, cellId) {
  return gravityCells.find(gc => gc.cell === cellId) || null;
}

function buildTopicLabel(candidate) {
  const axes = candidate.axes || [];
  const domains = [...new Set(axes.map(a => a && a.what).filter(Boolean))];
  const contexts = [...new Set(axes.map(a => a && a.where).filter(Boolean))];
  return `${domains.join('+')} in ${contexts.join('+')}`;
}

function buildEvidenceRefs(candidate) {
  return (candidate.sources || []).slice(0, 5).map(src => {
    if (typeof src === 'string') return { sourceType: src, sourceId: src };
    return { sourceType: src.sourceType || 'unknown', sourceId: src.sourceId || src.source || '' };
  });
}

function buildCollisionExplanation(axesA, axesB, col, combinedGravity, isFarField) {
  const prefix = isFarField ? 'Far-field collision' : 'Collision';
  return `${prefix} between ${axesA.what}/${axesA.where} and ${axesB.what}/${axesB.where} ` +
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
  emitDiscoveryCandidateEvents,
  emitDiscoveryHints,
  computeTemporalTrust,
  computeEvidenceDensity,
  computeNoveltyScore,
  computeSourceConfidence,
  MAX_DISCOVERY_HINTS
};
