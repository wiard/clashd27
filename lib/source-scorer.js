/**
 * Source Scorer — ranks signal sources by their contribution to emergence.
 *
 * Analyzes the semantic cube's signal history to compute per-source metrics:
 *   - emergence contribution: fraction of emergence events involving this source
 *   - collision participation: how many collisions this source appears in
 *   - diversity reach: how many unique cells this source has touched
 *   - gap discovery rate: fraction of signals flagged as gaps
 *   - recency: how recently this source was active
 *
 * The combined score determines sampling priority adjustments.
 * Sources that contribute more to emergence get higher priority.
 *
 * Parity note: source names align with openclashd-v2 source taxonomy
 * (competitors, knowledge_openalex, internal, openclaw-skills, etc.)
 */

const { AXIS_WHAT, AXIS_WHERE, AXIS_TIME } = require('./clashd27-cube-engine');

function round(num, decimals = 6) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

/**
 * Compute per-source scores from cube engine state.
 * @param {Object} state - The cube engine state (from engine.getState())
 * @param {Array} collisions - Current collision list
 * @param {Array} emergenceEvents - Emergence event list
 * @returns {Array} Ranked source scores
 */
function scoreSignalSources(state, collisions, emergenceEvents) {
  if (!state || !state.signals || !state.cells) return [];

  const signals = state.signals || [];
  const events = emergenceEvents || state.emergenceEvents || [];
  const cols = collisions || state.collisions || [];

  // Aggregate per-source stats
  const sourceStats = {};

  for (const signal of signals) {
    const src = signal.source || 'unknown';
    if (!sourceStats[src]) {
      sourceStats[src] = {
        source: src,
        signalCount: 0,
        uniqueCells: new Set(),
        totalScoreDelta: 0,
        gapSignals: 0,
        lastTick: 0,
        firstTick: Infinity,
        axes: { what: {}, where: {}, time: {} }
      };
    }
    const s = sourceStats[src];
    s.signalCount++;
    s.uniqueCells.add(signal.cellId);
    s.totalScoreDelta += signal.scoreDelta || 0;
    if (signal.axes) {
      if (signal.axes.what) s.axes.what[signal.axes.what] = (s.axes.what[signal.axes.what] || 0) + 1;
      if (signal.axes.where) s.axes.where[signal.axes.where] = (s.axes.where[signal.axes.where] || 0) + 1;
      if (signal.axes.time) s.axes.time[signal.axes.time] = (s.axes.time[signal.axes.time] || 0) + 1;
    }
    const tick = signal.tick || 0;
    if (tick > s.lastTick) s.lastTick = tick;
    if (tick < s.firstTick) s.firstTick = tick;
  }

  // Count gap signals per source from cell data
  for (let i = 0; i < 27; i++) {
    const cell = state.cells[String(i)];
    if (!cell) continue;
    for (const src of (cell.uniqueSources || [])) {
      if (sourceStats[src]) {
        // Approximate: cells with gap-related axes count toward gap signals
        if (cell.axes && cell.axes.time === 'emerging') {
          sourceStats[src].gapSignals++;
        }
      }
    }
  }

  // Compute collision participation
  for (const col of cols) {
    for (const src of (col.sources || [])) {
      if (sourceStats[src]) {
        sourceStats[src].collisionParticipation = (sourceStats[src].collisionParticipation || 0) + 1;
      }
    }
  }

  // Compute emergence contribution
  for (const evt of events) {
    for (const src of (evt.sources || [])) {
      if (sourceStats[src]) {
        sourceStats[src].emergenceContribution = (sourceStats[src].emergenceContribution || 0) + 1;
      }
    }
  }

  // Normalize and compute combined scores
  const currentTick = state.clock || 0;
  const totalSignals = signals.length || 1;
  const totalCollisions = cols.length || 1;
  const totalEmergence = events.length || 1;

  const results = [];

  for (const [src, stats] of Object.entries(sourceStats)) {
    const diversityReach = round(stats.uniqueCells.size / 27, 3);
    const collisionRate = round((stats.collisionParticipation || 0) / totalCollisions, 3);
    const emergenceRate = round((stats.emergenceContribution || 0) / totalEmergence, 3);
    const gapRate = round(stats.gapSignals / Math.max(stats.signalCount, 1), 3);
    const volumeShare = round(stats.signalCount / totalSignals, 3);

    // Recency: 1.0 if last signal was this tick, decaying by 0.02 per tick
    const ticksAgo = Math.max(0, currentTick - stats.lastTick);
    const recency = round(Math.max(0, 1 - (ticksAgo * 0.02)), 3);

    // Combined score: weighted sum of factors
    const combinedScore = round(
      (0.30 * emergenceRate) +
      (0.25 * collisionRate) +
      (0.20 * diversityReach) +
      (0.10 * gapRate) +
      (0.10 * recency) +
      (0.05 * volumeShare),
      3
    );

    // Dominant axis per dimension for this source
    const dominantWhat = Object.entries(stats.axes.what).sort((a, b) => b[1] - a[1])[0];
    const dominantWhere = Object.entries(stats.axes.where).sort((a, b) => b[1] - a[1])[0];
    const dominantTime = Object.entries(stats.axes.time).sort((a, b) => b[1] - a[1])[0];

    results.push({
      source: src,
      signalCount: stats.signalCount,
      uniqueCells: stats.uniqueCells.size,
      diversityReach,
      totalScoreDelta: round(stats.totalScoreDelta, 3),
      collisionParticipation: stats.collisionParticipation || 0,
      collisionRate,
      emergenceContribution: stats.emergenceContribution || 0,
      emergenceRate,
      gapSignals: stats.gapSignals,
      gapRate,
      volumeShare,
      recency,
      combinedScore,
      firstTick: stats.firstTick === Infinity ? 0 : stats.firstTick,
      lastTick: stats.lastTick,
      dominantAxes: {
        what: dominantWhat ? dominantWhat[0] : null,
        where: dominantWhere ? dominantWhere[0] : null,
        time: dominantTime ? dominantTime[0] : null
      }
    });
  }

  results.sort((a, b) => (b.combinedScore - a.combinedScore) || (b.signalCount - a.signalCount));
  return results;
}

/**
 * Suggest sampling weight adjustments based on source scores.
 * Returns a map of source → suggested weight multiplier (0.5–2.0).
 * Sources with higher emergence contribution get boosted;
 * sources with low contribution get reduced.
 */
function suggestWeightAdjustments(sourceScores) {
  if (!sourceScores || sourceScores.length === 0) return {};

  const maxScore = sourceScores[0].combinedScore || 1;
  const adjustments = {};

  for (const entry of sourceScores) {
    const ratio = maxScore > 0 ? entry.combinedScore / maxScore : 0.5;
    // Map ratio to multiplier: 0.5 (underperformer) to 2.0 (top performer)
    const multiplier = round(0.5 + (ratio * 1.5), 2);
    adjustments[entry.source] = {
      multiplier,
      reason: ratio >= 0.8 ? 'high emergence contribution'
        : ratio >= 0.4 ? 'moderate contribution'
        : 'low emergence contribution'
    };
  }

  return adjustments;
}

module.exports = {
  scoreSignalSources,
  suggestWeightAdjustments
};
