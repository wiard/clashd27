'use strict';

const { computeResearchGravity, selectGravityHotspots, summarizeGravityField } = require('./research-gravity');
const { detectDiscoveryCandidates, emitDiscoveryCandidateEvents } = require('./discovery-candidates');

/**
 * Run a full discovery cycle on the cube engine and produce structured events
 * consumable by openclashd-v2's observatory stream.
 *
 * Event types produced:
 *   - gravity_hotspot:      cells with strong research gravity pull
 *   - discovery_candidate:  cross-domain intersections for potential discoveries
 *   - emergence_cluster:    clusters of active cells
 *   - signal_summary:       summary of current cube state
 *
 * @param {Clashd27CubeEngine} engine - The cube engine instance
 * @param {object} opts
 * @param {number} opts.tick - Current tick number
 * @param {number} opts.minGravityScore - Minimum gravity score for hotspots (default 1.0)
 * @param {number} opts.maxHotspots - Maximum number of hotspots (default 5)
 * @returns {object} Structured output with events and summaries
 */
function runDiscoveryCycle(engine, opts = {}) {
  const tick = Number.isFinite(opts.tick) ? opts.tick : (engine.getState().clock || 0);
  const emergenceSummary = engine.summarizeEmergence({ persist: false });
  const cubeState = engine.getState();

  // Compute gravity field
  const gravityCells = computeResearchGravity(cubeState, emergenceSummary);
  const gravityHotspots = selectGravityHotspots(gravityCells, {
    minScore: opts.minGravityScore,
    maxHotspots: opts.maxHotspots
  });
  const gravityField = summarizeGravityField(gravityCells);

  // Detect discovery candidates
  const candidates = detectDiscoveryCandidates({
    gravityCells,
    emergenceSummary,
    cubeState
  });
  const candidateEvents = emitDiscoveryCandidateEvents(candidates);

  // Package emergence clusters as events
  const now = new Date().toISOString();
  const clusterEvents = (emergenceSummary.clusters || []).map((c, i) => ({
    type: 'emergence_cluster',
    timestamp: now,
    clusterId: c.id,
    cells: c.cells,
    size: c.size,
    totalScore: c.totalScore,
    strongestCell: c.strongestCell,
    rank: i + 1
  }));

  // Build signal summary
  const signalSummary = {
    type: 'signal_summary',
    timestamp: now,
    tick,
    totalCollisions: (emergenceSummary.collisions || []).length,
    totalClusters: (emergenceSummary.clusters || []).length,
    totalGradients: (emergenceSummary.gradients || []).length,
    totalCorridors: (emergenceSummary.corridors || []).length,
    gravityField,
    strongestCell: emergenceSummary.strongestCell || null,
    suggestions: emergenceSummary.suggestions || []
  };

  // Merge all events into a flat sorted array
  const allEvents = [
    ...gravityHotspots,
    ...candidateEvents,
    ...clusterEvents,
    signalSummary
  ].sort((a, b) => {
    // Sort by type priority: discovery_candidate > gravity_hotspot > emergence_cluster > signal_summary
    const priority = { discovery_candidate: 0, gravity_hotspot: 1, emergence_cluster: 2, signal_summary: 3 };
    const pa = priority[a.type] ?? 9;
    const pb = priority[b.type] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.candidateScore || b.gravityScore || b.totalScore || 0) -
           (a.candidateScore || a.gravityScore || a.totalScore || 0);
  });

  return {
    tick,
    timestamp: now,
    events: allEvents,
    gravity: {
      cells: gravityCells,
      hotspots: gravityHotspots,
      field: gravityField
    },
    discovery: {
      candidates,
      candidateEvents
    },
    emergence: {
      clusters: emergenceSummary.clusters || [],
      gradients: emergenceSummary.gradients || [],
      corridors: emergenceSummary.corridors || [],
      collisions: emergenceSummary.collisions || []
    }
  };
}

module.exports = {
  runDiscoveryCycle
};
