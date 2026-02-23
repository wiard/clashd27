/**
 * CLASHD-27 Paper Sampler — Anomaly Magnet
 *
 * Pulls diverse papers from Semantic Scholar using multiple query strategies.
 * Reuses existing S2 rate limiter (1.1s between requests) and 7-day cache.
 *
 * Sampling strategies:
 *   1. Broad field × random year (2015-2025)
 *   2. High citation velocity
 *   3. Recent papers with anomaly/deviation markers
 *   4. Cross-domain intersection queries
 */

const fs = require('fs');
const path = require('path');
const { searchPapers } = require('./semantic-scholar');

const SAMPLE_CACHE_FILE = path.join(__dirname, '..', 'data', 'sample-cache.json');
const SAMPLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────
// Query Strategies — designed to spread across all 3 axes
// ─────────────────────────────────────────────────────────────

// Broad research fields
const FIELDS = [
  'cancer', 'immunology', 'genomics', 'neuroscience', 'cardiology',
  'metabolic disease', 'infectious disease', 'microbiome', 'stem cell',
  'drug discovery', 'pharmacology', 'epigenetics', 'proteomics',
  'bioinformatics', 'clinical trial', 'pathology', 'epidemiology',
  'synthetic biology', 'gene therapy', 'biomarker'
];

// Method-biased queries (ensure X-axis spread)
const METHOD_QUERIES = [
  // Imaging/observation (X=0)
  'MRI imaging tumor detection',
  'histopathology cancer diagnosis',
  'epidemiological cohort cancer risk',
  'fluorescence microscopy cell',
  'mass spectrometry protein',
  // Computational (X=1)
  'machine learning cancer prediction',
  'bioinformatics genomic analysis',
  'deep learning medical imaging',
  'computational drug design',
  'network analysis gene expression',
  // Experimental (X=2)
  'CRISPR gene knockout cancer',
  'xenograft mouse model tumor',
  'clinical trial randomized cancer',
  'in vitro drug screening',
  'cell culture assay cytotoxicity'
];

// Surprise-biased queries (ensure Y-axis spread)
const SURPRISE_QUERIES = [
  'unexpected finding cancer',
  'paradoxical effect treatment',
  'contradicts previous findings',
  'surprising result tumor',
  'failed to replicate cancer',
  'serendipitous discovery biology',
  'novel mechanism disease',
  'counterintuitive immune response',
  'anomalous results clinical',
  'unprecedented response therapy'
];

// Cross-domain queries (maximize collision potential)
const CROSSDOMAIN_QUERIES = [
  'microbiome immunotherapy response',
  'artificial intelligence drug resistance',
  'epigenetics environmental exposure cancer',
  'gut bacteria chemotherapy',
  'machine learning pathology diagnosis',
  'metabolomics cancer biomarker',
  'nanotechnology drug delivery tumor',
  'circadian rhythm cancer treatment',
  'exercise oncology immune',
  'diet microbiome cancer prevention'
];

// Year-specific queries for temporal diversity
function yearQuery(field, year) {
  return `${field} ${year} research`;
}

function buildQueryList() {
  const queries = [];

  // Strategy 1: field × year (random years 2018-2025)
  const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
  for (const field of FIELDS.slice(0, 10)) {
    const year = years[Math.floor(Math.random() * years.length)];
    queries.push(yearQuery(field, year));
  }

  // Strategy 2: method-biased queries
  queries.push(...METHOD_QUERIES);

  // Strategy 3: surprise-biased queries
  queries.push(...SURPRISE_QUERIES);

  // Strategy 4: cross-domain queries
  queries.push(...CROSSDOMAIN_QUERIES);

  // Strategy 5: high-impact recent papers
  queries.push(
    'highly cited cancer research 2024',
    'breakthrough therapy cancer 2024',
    'landmark study oncology 2023',
    'high impact immunotherapy 2024',
    'seminal finding genomics 2023'
  );

  return queries;
}

// ─────────────────────────────────────────────────────────────
// Sample cache (avoid re-fetching within 1 hour)
// ─────────────────────────────────────────────────────────────

function readSampleCache() {
  try {
    if (fs.existsSync(SAMPLE_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SAMPLE_CACHE_FILE, 'utf8'));
      if (Date.now() - new Date(data.timestamp).getTime() < SAMPLE_CACHE_TTL_MS) {
        return data;
      }
    }
  } catch (e) {
    console.error(`[SAMPLER] Cache read error: ${e.message}`);
  }
  return null;
}

function writeSampleCache(papers, queriesUsed) {
  try {
    const dir = path.dirname(SAMPLE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      timestamp: new Date().toISOString(),
      paperCount: papers.length,
      queriesUsed,
      papers: papers.map(p => ({
        paperId: p.paperId,
        doi: p.doi,
        title: p.title,
        abstract: (p.abstract || '').slice(0, 500),
        year: p.year,
        citationCount: p.citationCount,
        influentialCitationCount: p.influentialCitationCount || 0,
        fieldsOfStudy: p.fieldsOfStudy || [],
        authors: p.authors || '',
        journal: p.journal || ''
      }))
    };
    const tmp = SAMPLE_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, SAMPLE_CACHE_FILE);
    console.log(`[SAMPLER] Cache written: ${papers.length} papers`);
  } catch (e) {
    console.error(`[SAMPLER] Cache write error: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Main sampling function
// ─────────────────────────────────────────────────────────────

async function samplePapers({
  targetTotal = 2700,
  papersPerQuery = 10,
  onProgress = null
} = {}) {
  // Check cache first
  const cached = readSampleCache();
  if (cached && cached.papers.length > 0) {
    console.log(`[SAMPLER] Using cached sample: ${cached.papers.length} papers from ${cached.timestamp}`);
    return {
      papers: cached.papers,
      queries_used: cached.queriesUsed || 0,
      cached_hits: cached.papers.length,
      from_cache: true
    };
  }

  const queries = buildQueryList();
  const seen = new Set();
  const allPapers = [];
  let queriesUsed = 0;

  console.log(`[SAMPLER] Starting sample: ${queries.length} queries, target ${targetTotal} papers`);

  for (const query of queries) {
    if (allPapers.length >= targetTotal) break;

    try {
      const papers = await searchPapers(query, papersPerQuery);
      queriesUsed++;

      for (const p of papers) {
        if (seen.has(p.paperId)) continue;
        // Filter: must have abstract with real content
        if (!p.abstract || p.abstract.trim().length < 50) continue;
        // Filter: must be relatively recent
        if (p.year && p.year < 2015) continue;

        seen.add(p.paperId);
        allPapers.push(p);
      }

      if (onProgress) {
        onProgress(allPapers.length, targetTotal);
      }

      if (queriesUsed % 10 === 0) {
        console.log(`[SAMPLER] Progress: ${allPapers.length} papers from ${queriesUsed} queries`);
      }
    } catch (err) {
      console.error(`[SAMPLER] Query failed "${query.slice(0, 50)}": ${err.message}`);
    }
  }

  console.log(`[SAMPLER] Complete: ${allPapers.length} papers from ${queriesUsed} queries (${seen.size} unique)`);

  // Cache the results
  writeSampleCache(allPapers, queriesUsed);

  return {
    papers: allPapers,
    queries_used: queriesUsed,
    cached_hits: 0,
    from_cache: false
  };
}

module.exports = { samplePapers, buildQueryList, SAMPLE_CACHE_FILE };
