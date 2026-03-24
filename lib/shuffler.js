/**
 * CLASHD-27 Cube Shuffler — Anomaly Magnet v2.0
 *
 * Orchestrates multi-source paper sampling, classification, and cube population.
 * Manages cube.json lifecycle and golden collision scoring.
 *
 * v2.0: Multi-source sampling (OpenAlex + bioRxiv + arXiv + S2 + retractions)
 *       Retraction enrichment for surprise index boost
 *       Source metadata per paper for provenance tracking
 *
 * Cube structure: 3×3×3 = 27 cells
 *   X = Method DNA (0=imaging, 1=computational, 2=experimental)
 *   Y = Surprise Index (0=confirmatory, 1=deviation, 2=anomalous)
 *   Z = Semantic Orbit (0-2, rotates every SHUFFLE_INTERVAL ticks)
 *
 * Cell index: z*9 + y*3 + x (matches existing cube.js coordinate system)
 */

const fs = require('fs');
const path = require('path');
const { samplePapers } = require('./sampler');
const { classifyAll, METHOD_LABELS, SURPRISE_LABELS } = require('./classifier');

const CUBE_FILE = path.join(__dirname, '..', 'data', 'cube.json');
const SHUFFLE_INTERVAL = 50; // ticks between Z-axis reshuffles

// ─────────────────────────────────────────────────────────────
// Shuffle trigger
// ─────────────────────────────────────────────────────────────

function shouldShuffle(tick, lastShuffleAtTick) {
  // Shuffle if cube doesn't exist or never shuffled
  if (lastShuffleAtTick === null || lastShuffleAtTick === undefined) return true;
  // Shuffle every SHUFFLE_INTERVAL ticks
  return (tick - lastShuffleAtTick) >= SHUFFLE_INTERVAL;
}

// ─────────────────────────────────────────────────────────────
// Cube population
// ─────────────────────────────────────────────────────────────

function populateCube(classifiedPapers, clusterLabels) {
  const cells = {};
  const surpriseSums = {};
  const surpriseCounts = {};

  // Initialize all 27 cells
  for (let i = 0; i < 27; i++) {
    const x = i % 3;
    const y = Math.floor(i / 3) % 3;
    const z = Math.floor(i / 9);
    cells[String(i)] = {
      x, y, z,
      methodLabel: METHOD_LABELS[x],
      surpriseLabel: SURPRISE_LABELS[y],
      clusterLabel: (clusterLabels && clusterLabels[z]) || `cluster-${z}`,
      papers: [],
      paperCount: 0
    };
  }

  // Distribute papers into cells
  for (const cp of classifiedPapers) {
    const cellKey = String(cp.cell);
    if (!cells[cellKey]) continue;

    // Store compact paper data with source provenance
    cells[cellKey].papers.push({
      paperId: cp.paper.paperId,
      title: cp.paper.title,
      abstract: (cp.paper.abstract || '').slice(0, 300),
      year: cp.paper.year,
      citationCount: cp.paper.citationCount,
      doi: cp.paper.doi || null,
      fieldsOfStudy: cp.paper.fieldsOfStudy || [],
      authors: cp.paper.authors || '',
      source: cp.paper.source || 'unknown',
      isRetracted: cp.paper.isRetracted || false
    });
    cells[cellKey].paperCount++;
    surpriseSums[cellKey] = (surpriseSums[cellKey] || 0) + (cp.surpriseScore || 0);
    surpriseCounts[cellKey] = (surpriseCounts[cellKey] || 0) + 1;
  }

  // Sort papers within each cell by citation count (descending) for easy "top N" retrieval
  for (const cell of Object.values(cells)) {
    cell.papers.sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0));
  }
  for (const [key, cell] of Object.entries(cells)) {
    const sum = surpriseSums[key] || 0;
    const cnt = surpriseCounts[key] || 0;
    cell.surpriseScoreAvg = cnt > 0 ? Math.round((sum / cnt) * 1000) / 1000 : 0;
  }

  // Log distribution warnings
  let emptyCount = 0;
  let thinCount = 0;
  for (const [key, cell] of Object.entries(cells)) {
    if (cell.paperCount === 0) {
      emptyCount++;
      console.warn(`[SHUFFLER] WARNING: Cell ${key} [${cell.methodLabel}, ${cell.surpriseLabel}, ${cell.clusterLabel}] is EMPTY`);
    } else if (cell.paperCount < 10) {
      thinCount++;
      console.warn(`[SHUFFLER] WARNING: Cell ${key} has only ${cell.paperCount} papers (< 10)`);
    }
  }
  if (emptyCount > 0) console.warn(`[SHUFFLER] ${emptyCount} empty cells detected`);
  if (thinCount > 0) console.warn(`[SHUFFLER] ${thinCount} thin cells (< 10 papers)`);

  return cells;
}

// ─────────────────────────────────────────────────────────────
// Full shuffle pipeline
// ─────────────────────────────────────────────────────────────

async function shuffle(tick, generation = 0, onProgress = null) {
  const startTime = Date.now();
  console.log(`[SHUFFLE] Starting cube generation ${generation + 1} at tick ${tick}`);

  // 1. Sample papers from multi-source pipeline
  const sampleResult = await samplePapers({ onProgress });
  const { papers, sourceBreakdown, cached_hits, from_cache } = sampleResult;
  console.log(`[SHUFFLE] Sampled ${papers.length} papers (cached=${cached_hits}, from_cache=${from_cache})`);
  if (sourceBreakdown) {
    console.log(`[SHUFFLE] Source breakdown: ${JSON.stringify(sourceBreakdown)}`);
  }

  if (papers.length < 27) {
    throw new Error(`[SHUFFLE] Insufficient papers: ${papers.length} (need at least 27)`);
  }

  // 2. Retraction enrichment (non-blocking, best-effort)
  let retractionCount = 0;
  try {
    const { isRetracted, citesRetractedPaper, isInitialized } = require('./retraction-enricher');
    if (isInitialized()) {
      for (const paper of papers) {
        // Check if paper is retracted
        if (paper.doi && isRetracted(paper.doi)) {
          paper.isRetracted = true;
          retractionCount++;
        }
        // Check if paper cites retracted papers
        if (paper.referencedWorks && paper.referencedWorks.length > 0) {
          const refs = paper.referencedWorks
            .map(r => typeof r === 'string' ? r.replace('https://openalex.org/', '') : '')
            .filter(Boolean);
          paper.citesRetracted = citesRetractedPaper(refs);
        }
      }
      if (retractionCount > 0) {
        console.log(`[SHUFFLE] Retraction enrichment: ${retractionCount} retracted papers found`);
      }
    }
  } catch (e) {
    console.error(`[SHUFFLE] Retraction enrichment failed (non-fatal): ${e.message}`);
  }

  // 3. Classify along all 3 axes
  const { classified, clusterLabels } = classifyAll(papers);
  console.log(`[SHUFFLE] Classified ${classified.length} papers, cluster labels: [${clusterLabels.join(', ')}]`);

  // 4. Populate cube
  const cells = populateCube(classified, clusterLabels);

  // 5. Build cube document
  const cube = {
    generation: generation + 1,
    createdAtTick: tick,
    timestamp: new Date().toISOString(),
    totalPapers: classified.length,
    shuffleDurationMs: Date.now() - startTime,
    fromCache: from_cache,
    sourceBreakdown: sourceBreakdown || {},
    retractionEnriched: retractionCount,
    cells,
    axisLabels: {
      x: [...METHOD_LABELS],
      y: [...SURPRISE_LABELS],
      z: clusterLabels
    },
    distribution: {}
  };

  // Compute distribution summary
  for (const [key, cell] of Object.entries(cells)) {
    cube.distribution[key] = cell.paperCount;
  }

  // 6. Atomic write
  const dir = path.dirname(CUBE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = CUBE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cube, null, 2));
  fs.renameSync(tmp, CUBE_FILE);

  const elapsed = Date.now() - startTime;
  console.log(`[SHUFFLE] Cube generation ${cube.generation} complete: ${classified.length} papers in 27 cells (${elapsed}ms)`);

  return cube;
}

// ─────────────────────────────────────────────────────────────
// Cube readers
// ─────────────────────────────────────────────────────────────

function readCube() {
  try {
    if (fs.existsSync(CUBE_FILE)) {
      return JSON.parse(fs.readFileSync(CUBE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[CUBE] Read failed: ${e.message}`);
  }
  return null;
}

/**
 * Get cell description for use in researcher prompts.
 * Returns metadata + top 5 papers sorted by citation count.
 */
function getCubeDescription(cell) {
  const cube = readCube();
  if (!cube || !cube.cells || !cube.cells[String(cell)]) return null;

  const c = cube.cells[String(cell)];
  const topPapers = (c.papers || []).slice(0, 5);

  return {
    cell,
    x: c.x,
    y: c.y,
    z: c.z,
    methodLabel: c.methodLabel,
    surpriseLabel: c.surpriseLabel,
    surpriseScoreAvg: c.surpriseScoreAvg || 0,
    clusterLabel: c.clusterLabel,
    paperCount: c.paperCount,
    topPapers,
    description: `${c.methodLabel} | ${c.surpriseLabel} | ${c.clusterLabel} (${c.paperCount} papers)`
  };
}

// ─────────────────────────────────────────────────────────────
// Golden Collision Scoring
// ─────────────────────────────────────────────────────────────

/**
 * Score a collision between two cells.
 * Higher score = more different = more potential for novel cross-domain gaps.
 *
 * Components:
 *   methodDistance:    |x1-x2| / 2                    (0-1)
 *   surprisePair:      soft interaction with floor   (0-1, never zeroed by y=0)
 *   semanticDistance:  z1 !== z2 ? 1.0 : 0.3          (different clusters = bonus)
 *
 * Golden threshold: score > 0.5
 */
function goldenCollisionScore(cellA, cellB) {
  const cube = readCube();
  if (!cube || !cube.cells) return { score: 0, golden: false, reason: 'no cube' };

  const a = cube.cells[String(cellA)];
  const b = cube.cells[String(cellB)];
  if (!a || !b) return { score: 0, golden: false, reason: 'cell not found' };

  const methodDistance = Math.abs(a.x - b.x) / 2;
  const yA = a.y / 2;
  const yB = b.y / 2;
  const surprisePair = 0.2 + 0.8 * (0.6 * ((yA + yB) / 2) + 0.4 * Math.sqrt(yA * yB));
  const semanticDistance = a.z !== b.z ? 1.0 : 0.3;

  const raw = (0.45 * methodDistance) + (0.35 * surprisePair) + (0.20 * semanticDistance);
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 1000) / 1000;

  return {
    score,
    golden: score > 0.5,
    components: {
      methodDistance: Math.round(methodDistance * 100) / 100,
      surprisePair: Math.round(surprisePair * 100) / 100,
      semanticDistance
    },
    cellA: {
      coords: [a.x, a.y, a.z],
      method: a.methodLabel,
      surprise: a.surpriseLabel,
      cluster: a.clusterLabel,
      paperCount: a.paperCount
    },
    cellB: {
      coords: [b.x, b.y, b.z],
      method: b.methodLabel,
      surprise: b.surpriseLabel,
      cluster: b.clusterLabel,
      paperCount: b.paperCount
    }
  };
}

module.exports = {
  shouldShuffle,
  populateCube,
  shuffle,
  readCube,
  getCubeDescription,
  goldenCollisionScore,
  SHUFFLE_INTERVAL,
  CUBE_FILE
};
