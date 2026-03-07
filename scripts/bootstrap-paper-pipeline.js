#!/usr/bin/env node
/**
 * Bootstrap the paper-first discovery pipeline.
 *
 * 1. Populate cube.json from cached papers (or fetch fresh if needed)
 * 2. Seed the CLASHD27 cube engine with paper signals
 * 3. Verify the discovery feed produces real output
 *
 * Usage:
 *   node scripts/bootstrap-paper-pipeline.js [--fresh]
 *
 *   --fresh    Force fresh paper fetch instead of using cache
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CUBE_FILE = path.join(DATA_DIR, 'cube.json');
const PAPERS_CACHE = path.join(DATA_DIR, 'papers-cache.json');
const CUBE_STATE_FILE = path.join(DATA_DIR, 'clashd27-cube-state.json');

const { classifyAll, METHOD_LABELS, SURPRISE_LABELS } = require('../lib/classifier');
const { populateCube } = require('../lib/shuffler');
const { Clashd27CubeEngine } = require('../lib/clashd27-cube-engine');
const { buildPaperDiscoveryFeed } = require('../lib/paper-discovery-feed');

// ── Helpers ──────────────────────────────────────────────────

function hashId(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function log(msg) {
  console.log(`[BOOTSTRAP] ${msg}`);
}

function warn(msg) {
  console.warn(`[BOOTSTRAP] WARNING: ${msg}`);
}

// ── Step 1: Get papers ──────────────────────────────────────

function loadCachedPapers() {
  if (!fs.existsSync(PAPERS_CACHE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(PAPERS_CACHE, 'utf8'));
    const papers = Object.values(data.papers || {});
    // Normalize: ensure required fields
    return papers
      .filter(p => p.title && p.abstract && p.abstract.length > 30)
      .map(p => ({
        paperId: p.paperId || hashId(p.title),
        doi: p.doi || null,
        title: p.title,
        abstract: (p.abstract || '').slice(0, 500),
        year: p.year || new Date().getFullYear(),
        citationCount: p.citationCount || 0,
        influentialCitationCount: p.influentialCitationCount || 0,
        fieldsOfStudy: p.fieldsOfStudy || [],
        concepts: p.concepts || [],
        primaryTopic: p.primaryTopic || null,
        authors: p.authors || '',
        journal: p.journal || '',
        source: p.source || 's2',
        isRetracted: p.isRetracted || false
      }));
  } catch (e) {
    warn(`Failed to load papers cache: ${e.message}`);
    return [];
  }
}

// ── Step 2: Populate cube ───────────────────────────────────

function buildCube(papers) {
  log(`Classifying ${papers.length} papers on 3 axes...`);
  const { classified, clusterLabels } = classifyAll(papers);

  log(`Populating 27-cell cube...`);
  const cells = populateCube(classified, clusterLabels);

  const cube = {
    generation: 1,
    createdAtTick: 0,
    timestamp: new Date().toISOString(),
    totalPapers: classified.length,
    shuffleDurationMs: 0,
    fromCache: true,
    sourceBreakdown: {},
    retractionEnriched: 0,
    cells,
    axisLabels: {
      x: [...METHOD_LABELS],
      y: [...SURPRISE_LABELS],
      z: clusterLabels
    },
    distribution: {}
  };

  // Source breakdown
  const breakdown = {};
  for (const cp of classified) {
    const src = cp.paper.source || 'unknown';
    breakdown[src] = (breakdown[src] || 0) + 1;
  }
  cube.sourceBreakdown = breakdown;

  // Distribution
  for (const [key, cell] of Object.entries(cells)) {
    cube.distribution[key] = cell.paperCount;
  }

  // Atomic write
  const tmp = CUBE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cube, null, 2));
  fs.renameSync(tmp, CUBE_FILE);

  log(`Cube written: ${classified.length} papers across 27 cells`);

  // Report distribution
  const nonEmpty = Object.values(cells).filter(c => c.paperCount > 0).length;
  log(`Cell coverage: ${nonEmpty}/27 cells populated`);

  return cube;
}

// ── Step 3: Seed engine with paper signals ──────────────────

function seedEngine(cube) {
  const engine = new Clashd27CubeEngine({ stateFile: CUBE_STATE_FILE });
  let totalIngested = 0;
  let tick = 1;

  for (const [cellKey, cell] of Object.entries(cube.cells)) {
    const papers = cell.papers || [];
    if (papers.length === 0) continue;

    for (const paper of papers) {
      const signalId = hashId(`paper|${paper.source || 'unknown'}|${paper.title}|${cellKey}`);
      const keywords = (paper.fieldsOfStudy || []).map(f => f.toLowerCase());
      // Add source-relevant keywords for better mapping
      if (paper.source === 'openalex' || paper.source === 'preprints') {
        keywords.push('paper', 'research');
      }

      try {
        engine.ingestSignal({
          id: signalId,
          source: `paper-${paper.source || 'research'}`,
          timestamp: paper.year
            ? new Date(paper.year, 0, 1).toISOString()
            : new Date().toISOString(),
          keywords,
          publishedAtIso: paper.year
            ? new Date(paper.year, 0, 1).toISOString()
            : null
        }, { tick, persist: false });
        totalIngested++;
      } catch (e) {
        // Non-fatal: some papers may fail to map
      }
    }

    // Advance tick between cells to create temporal spread
    tick++;
  }

  // Advance clock and update residue
  engine.updateResidue(tick + 5, { persist: false });

  // Detect collisions
  const collisions = engine.detectCollisions({ tick: tick + 5 });
  log(`Collisions detected: ${collisions.meaningful?.length || 0} meaningful, ${collisions.emergence?.length || 0} emergence`);

  // Save state
  engine.save();
  log(`Engine seeded: ${totalIngested} signals ingested across ${tick} ticks`);

  return engine;
}

// ── Step 4: Verify discovery feed ───────────────────────────

function verifyDiscoveryFeed(engine, cube) {
  const feed = buildPaperDiscoveryFeed({ engine, cube, maxSignals: 50 });

  log(`Discovery feed verification:`);
  log(`  signals:      ${feed.counts.signal_detected}`);
  log(`  clusters:     ${feed.counts.emergence_cluster}`);
  log(`  hotspots:     ${feed.counts.gravity_hotspot}`);
  log(`  candidates:   ${feed.counts.discovery_candidate}`);
  log(`  total events: ${feed.events.length}`);

  if (feed.counts.signal_detected === 0) {
    warn('No paper signals in feed — check cube.json');
    return false;
  }

  // Show sample events
  const sample = feed.events.slice(0, 3);
  for (const ev of sample) {
    log(`  [${ev.type}] ${ev.title || ev.explanation || ev.summary || '(no title)'}`);
  }

  return true;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  log('Starting paper pipeline bootstrap...');

  // Step 1: Get papers
  let papers = loadCachedPapers();
  log(`Loaded ${papers.length} papers from cache`);

  if (papers.length < 27) {
    log('Not enough cached papers. Attempting fresh fetch...');
    try {
      const { samplePapers } = require('../lib/sampler');
      const result = await samplePapers({ targetTotal: 100 });
      papers = result.papers.filter(p => p.title && p.abstract && p.abstract.length > 30);
      log(`Fetched ${papers.length} papers from APIs`);
    } catch (e) {
      console.error(`[BOOTSTRAP] FATAL: Cannot get enough papers: ${e.message}`);
      process.exit(1);
    }
  }

  if (papers.length < 27) {
    console.error(`[BOOTSTRAP] FATAL: Only ${papers.length} papers available, need at least 27`);
    process.exit(1);
  }

  // Step 2: Build cube
  const cube = buildCube(papers);

  // Step 3: Seed engine
  const engine = seedEngine(cube);

  // Step 4: Verify
  const ok = verifyDiscoveryFeed(engine, cube);
  if (!ok) {
    console.error('[BOOTSTRAP] Discovery feed verification failed');
    process.exit(1);
  }

  log('Paper pipeline bootstrap complete!');
  log(`cube.json: ${CUBE_FILE}`);
  log(`engine state: ${CUBE_STATE_FILE}`);
}

main().catch(e => {
  console.error(`[BOOTSTRAP] Fatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
