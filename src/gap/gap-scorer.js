'use strict';

const { computeDomainDistance } = require('../../lib/clashd27-cube-engine');
const { computeNovelty, computeEvidenceDensity, computeCrossDomainScore } = require('../../lib/proposal-metadata');

function round(num, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function avg(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function uniqueCount(values) {
  return new Set((values || []).filter(Boolean)).size;
}

function cellsForCandidate(candidate, cubeState) {
  return (candidate.cells || []).map(cellId => cubeState.cells[String(cellId)] || null).filter(Boolean);
}

function findRelatedCollisions(candidate, emergenceSummary) {
  const candidateCells = new Set((candidate.cells || []).map(Number));
  return (emergenceSummary.collisions || []).filter(collision =>
    (collision.cells || []).some(cellId => candidateCells.has(Number(cellId)))
  );
}

function uniqueTimes(candidate) {
  return uniqueCount((candidate.axes || []).map(axis => axis && axis.time));
}

function buildSourceScoreMap(sourceScores) {
  const map = new Map();
  for (const entry of sourceScores || []) {
    map.set(entry.source, entry);
  }
  return map;
}

function sourceContribution(candidate, sourceScoreMap) {
  const scores = (candidate.sources || [])
    .map(source => typeof source === 'string' ? source : (source.source || source.sourceId || source.sourceType))
    .map(source => sourceScoreMap.get(source))
    .filter(Boolean)
    .map(entry => entry.combinedScore || 0);
  return avg(scores);
}

function normalizeGravity(candidate, gravityCells) {
  const relevant = (candidate.cells || [])
    .map(cellId => gravityCells.find(entry => entry.cell === Number(cellId)))
    .filter(Boolean);
  const peak = gravityCells.length > 0 ? gravityCells[0].gravityScore || 0 : 0;
  const local = relevant.length > 0 ? avg(relevant.map(entry => entry.gravityScore || 0)) : 0;
  if (peak <= 0) return 0;
  return round(clamp(local / peak, 0, 1));
}

function computeNoveltyScore(candidate, cubeState) {
  const cells = cellsForCandidate(candidate, cubeState);
  const timeWeights = cells.map(cell => {
    if (cell.axes.time === 'emerging') return 0.95;
    if (cell.axes.time === 'current') return 0.65;
    return 0.35;
  });
  const lowSaturation = cells.length > 0
    ? avg(cells.map(cell => 1 - clamp(((cell.uniqueSourceTypes || []).length - 1) / 4, 0, 0.75)))
    : 0.5;
  const domainBonus = clamp((candidate.domainDistance || 0) / 0.3, 0, 1);
  const proposalNovelty = computeNovelty(candidate);
  return round(clamp(
    (proposalNovelty * 0.4) +
    (avg(timeWeights) * 0.3) +
    (lowSaturation * 0.2) +
    (domainBonus * 0.1),
    0,
    1
  ));
}

function computeCollisionScore(candidate, emergenceSummary) {
  const collisions = findRelatedCollisions(candidate, emergenceSummary);
  if (collisions.length === 0) return 0;
  const emergence = avg(collisions.map(c => c.emergenceScore || 0));
  const domainDistance = avg(collisions.map(c => clamp((c.domainDistance || 0) / 0.3, 0, 1)));
  const farFieldBonus = collisions.some(c => c.collisionType === 'far-field') ? 0.15 : 0;
  return round(clamp((emergence * 0.65) + (domainDistance * 0.2) + farFieldBonus, 0, 1));
}

function computeResidueScore(candidate, cubeState) {
  const cells = cellsForCandidate(candidate, cubeState);
  if (cells.length === 0) return 0;
  const pressure = avg(cells.map(cell => clamp(cell.score || 0, 0, 1)));
  const formula = avg(cells.map(cell => clamp((cell.formulaResidue || 0) / 20, 0, 1)));
  const persistence = avg(cells.map(cell => clamp((cell.timeSpread || 0) / 6, 0, 1)));
  return round(clamp((pressure * 0.4) + (formula * 0.35) + (persistence * 0.25), 0, 1));
}

function computeEvidenceScore(candidate, cubeState, sourceScores) {
  const cells = cellsForCandidate(candidate, cubeState);
  if (cells.length === 0) return 0;
  const evidenceDensity = avg(cells.map(cell => clamp((cell.evidenceScore || 0) + ((cell.directScore || 0) * 0.5), 0, 1)));
  const diversity = clamp(uniqueCount(cells.flatMap(cell => cell.uniqueSourceTypes || [])) / 4, 0, 1);
  const temporal = avg(cells.map(cell => clamp((cell.ticks || []).length / 5, 0, 1)));
  const proposalEvidence = computeEvidenceDensity(candidate);
  const contribution = sourceContribution(candidate, buildSourceScoreMap(sourceScores));
  return round(clamp(
    (proposalEvidence * 0.25) +
    (evidenceDensity * 0.3) +
    (diversity * 0.2) +
    (temporal * 0.15) +
    (contribution * 0.1),
    0,
    1
  ));
}

function computeEntropyScore(candidate, cubeState) {
  const cells = cellsForCandidate(candidate, cubeState);
  if (cells.length === 0) return 0;
  const seedEntropy = avg(cells.map(cell => clamp(((cell.entropySeed || 0.9) - 0.9) / 1, 0, 1)));
  const sourceDispersion = clamp(uniqueCount(cells.flatMap(cell => cell.uniqueSourceTypes || [])) / 4, 0, 1);
  const timeDispersion = clamp(uniqueTimes(candidate) / 3, 0, 1);
  return round(clamp((seedEntropy * 0.5) + (sourceDispersion * 0.25) + (timeDispersion * 0.25), 0, 1));
}

function computeSerendipityScore(candidate, cubeState, emergenceSummary) {
  const cells = cellsForCandidate(candidate, cubeState);
  const collisions = findRelatedCollisions(candidate, emergenceSummary);
  const domainDistance = computeCrossDomainScore(candidate);
  const farField = collisions.some(collision => collision.collisionType === 'far-field') ? 1 : 0;
  const sourceMix = clamp(uniqueCount(cells.flatMap(cell => cell.uniqueSourceTypes || [])) / 4, 0, 1);
  const timeMix = clamp(uniqueTimes(candidate) / 3, 0, 1);
  return round(clamp(
    (domainDistance * 0.35) +
    (farField * 0.25) +
    (sourceMix * 0.2) +
    (timeMix * 0.2),
    0,
    1
  ));
}

function computeTotalScore(scores) {
  return round(clamp(
    (scores.novelty * 0.16) +
    (scores.collision * 0.18) +
    (scores.residue * 0.16) +
    (scores.gravity * 0.16) +
    (scores.evidence * 0.14) +
    (scores.entropy * 0.1) +
    (scores.serendipity * 0.1),
    0,
    1
  ));
}

function scoreGapCandidate(input) {
  const candidate = input.candidate || {};
  const cubeState = input.cubeState || { cells: {} };
  const emergenceSummary = input.emergenceSummary || {};
  const gravityCells = input.gravityCells || [];
  const sourceScores = input.sourceScores || [];
  const cells = (candidate.cells || []).map(Number);

  const domainDistance = typeof candidate.domainDistance === 'number'
    ? candidate.domainDistance
    : (cells.length >= 2 ? computeDomainDistance(cells[0], cells[cells.length - 1]) : 0);

  const normalizedCandidate = {
    ...candidate,
    cells,
    domainDistance
  };

  const scores = {
    novelty: computeNoveltyScore(normalizedCandidate, cubeState),
    collision: computeCollisionScore(normalizedCandidate, emergenceSummary),
    residue: computeResidueScore(normalizedCandidate, cubeState),
    gravity: normalizeGravity(normalizedCandidate, gravityCells),
    evidence: computeEvidenceScore(normalizedCandidate, cubeState, sourceScores),
    entropy: computeEntropyScore(normalizedCandidate, cubeState),
    serendipity: computeSerendipityScore(normalizedCandidate, cubeState, emergenceSummary)
  };
  scores.total = computeTotalScore(scores);

  return {
    candidate: normalizedCandidate,
    scores,
    promising: scores.total >= 0.62,
    scoringTrace: {
      version: 'clashd27.gap-score.v1',
      cells,
      domainDistance: round(domainDistance),
      collisionCount: findRelatedCollisions(normalizedCandidate, emergenceSummary).length,
      gravityPeak: gravityCells.length > 0 ? gravityCells[0].gravityScore || 0 : 0,
      sourceContribution: round(sourceContribution(normalizedCandidate, buildSourceScoreMap(sourceScores))),
      formulas: {
        novelty: 'proposal-novelty + time-weight + low-saturation + domain-bonus',
        collision: 'emergence + domain-distance + far-field-bonus',
        residue: 'score-pressure + formula-residue + persistence',
        gravity: 'local-gravity / peak-gravity',
        evidence: 'proposal-evidence + evidence-density + source-diversity + temporal-spread + source-contribution',
        entropy: 'entropy-seed + source-dispersion + time-dispersion',
        serendipity: 'cross-domain-score + far-field + source-mix + time-mix',
        total: '0.16N + 0.18C + 0.16R + 0.16G + 0.14E + 0.10H + 0.10S'
      }
    }
  };
}

function scoreGapCandidates(input) {
  return (input.candidates || []).map(candidate => scoreGapCandidate({
    ...input,
    candidate
  }));
}

module.exports = {
  computeCollisionScore,
  computeEvidenceScore,
  computeEntropyScore,
  computeNoveltyScore,
  computeResidueScore,
  computeSerendipityScore,
  computeTotalScore,
  scoreGapCandidate,
  scoreGapCandidates
};
