/**
 * CLASHD-27 Paper Sampler — Anomaly Magnet v2.0
 *
 * Multi-source sampling orchestration:
 *   25% OpenAlex random (diverse fields)
 *   5%  PubMed via Europe PMC
 *   45% bioRxiv/medRxiv/arXiv fresh preprints (AI-heavy)
 *   10% OpenAlex targeted anomaly sampling
 *   10% S2 keyword queries (AI-heavy)
 *   5%  Retraction ecosystem (OpenAlex retracted papers)
 *
 * Graceful degradation: if any source fails, continues with remaining.
 * OpenAlex alone = minimum viable source.
 *
 * Cache: data/sample-cache.json, 1-hour TTL
 */

const fs = require('fs');
const path = require('path');
const { searchPapers } = require('./semantic-scholar');

const SAMPLE_CACHE_FILE = path.join(__dirname, '..', 'data', 'sample-cache.json');
const SAMPLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─────────────────────────────────────────────────────────────
// SOURCE_WEIGHTS — target distribution for multi-source sampling
// ─────────────────────────────────────────────────────────────
const SOURCE_WEIGHTS = {
  preprints: 0.45,   // AI-heavy preprints
  openalex: 0.25,    // OpenAlex random diverse fields
  s2: 0.10,          // S2 keyword queries (AI-heavy)
  anomaly: 0.10,     // OpenAlex targeted anomaly sampling
  pubmed: 0.05,      // PubMed via Europe PMC
  retraction: 0.05,  // Retraction ecosystem (OpenAlex retracted papers)
};

// ─────────────────────────────────────────────────────────────
// Legacy S2 query strategies (kept as fallback and supplement)
// ─────────────────────────────────────────────────────────────

const METHOD_QUERIES = [
  'large language model architecture', 'transformer efficiency', 'mixture of experts',
  'reinforcement learning from human feedback', 'DPO preference optimization',
  'diffusion model vision', 'multimodal transformer', 'agentic tool use'
];

const SURPRISE_QUERIES = [
  'LLM hallucination evaluation', 'prompt injection failure', 'jailbreak attack',
  'OOD generalization failure', 'benchmark leakage detection', 'unexpected emergent capability'
];

const CROSSDOMAIN_QUERIES = [
  'formal verification of LLMs', 'neurosymbolic reasoning transformers',
  'robotics foundation models', 'safety alignment reward hacking'
];

// ─────────────────────────────────────────────────────────────
// Sample cache
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

function writeSampleCache(papers, sourceBreakdown) {
  try {
    const dir = path.dirname(SAMPLE_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = {
      timestamp: new Date().toISOString(),
      paperCount: papers.length,
      sourceBreakdown,
      papers: papers.map(p => ({
        paperId: p.paperId,
        doi: p.doi,
        title: p.title,
        abstract: (p.abstract || '').slice(0, 500),
        year: p.year,
        citationCount: p.citationCount,
        influentialCitationCount: p.influentialCitationCount || 0,
        fieldsOfStudy: p.fieldsOfStudy || [],
        concepts: p.concepts || [],
        primaryTopic: p.primaryTopic || null,
        authors: p.authors || '',
        journal: p.journal || '',
        isRetracted: p.isRetracted || false,
        source: p.source || 'unknown',
        referencedWorks: p.referencedWorks || []
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
// S2 fallback sampling (legacy strategy)
// ─────────────────────────────────────────────────────────────

async function sampleFromS2(targetCount = 270, onProgress = null) {
  const queries = [...METHOD_QUERIES, ...SURPRISE_QUERIES, ...CROSSDOMAIN_QUERIES];
  const seen = new Set();
  const papers = [];

  for (const query of queries) {
    if (papers.length >= targetCount) break;
    try {
      const results = await searchPapers(query, 10);
      for (const p of results) {
        if (seen.has(p.paperId)) continue;
        if (!p.abstract || p.abstract.trim().length < 50) continue;
        if (p.year && p.year < 2015) continue;
        seen.add(p.paperId);
        p.source = 's2';
        papers.push(p);
      }
    } catch (err) {
      console.error(`[SAMPLER] S2 query failed: ${err.message}`);
    }
  }

  return papers;
}

// ─────────────────────────────────────────────────────────────
// Multi-source sampling orchestration
// ─────────────────────────────────────────────────────────────

/**
 * Sample papers from multiple sources for cube population.
 *
 * Distribution (see SOURCE_WEIGHTS):
 *   50% OpenAlex random diverse fields
 *   10% PubMed via Europe PMC
 *   15% Fresh preprints (bioRxiv + medRxiv + arXiv)
 *   10% OpenAlex anomaly-targeted
 *   10% S2 keyword queries (fallback/supplement)
 *   5%  Retraction ecosystem
 *
 * @param {Object} options
 * @param {number} options.targetTotal - target number of papers (default 2700)
 * @param {function} options.onProgress - progress callback(fetched, total)
 * @returns {{ papers, sourceBreakdown, from_cache }}
 */
async function samplePapers({
  targetTotal = 2700,
  onProgress = null
} = {}) {
  // Check cache first
  const cached = readSampleCache();
  if (cached && cached.papers.length > 0) {
    console.log(`[SAMPLER] Using cached multi-source sample: ${cached.papers.length} papers from ${cached.timestamp}`);
    return {
      papers: cached.papers,
      sourceBreakdown: cached.sourceBreakdown || {},
      cached_hits: cached.papers.length,
      from_cache: true
    };
  }

  console.log(`[SAMPLER] Starting multi-source sample: target ${targetTotal} papers`);
  const seen = new Set();
  const allPapers = [];
  const sourceBreakdown = { openalex: 0, pubmed: 0, preprints: 0, anomaly: 0, s2: 0, retraction: 0 };
  const oaRandomTarget = Math.ceil(targetTotal * SOURCE_WEIGHTS.openalex);
  const pubmedTarget = Math.ceil(targetTotal * SOURCE_WEIGHTS.pubmed);
  const preprintTarget = Math.ceil(targetTotal * SOURCE_WEIGHTS.preprints);
  const anomalyTarget = Math.ceil(targetTotal * SOURCE_WEIGHTS.anomaly);

  function addPapers(papers, sourceTag) {
    let added = 0;
    for (const p of papers) {
      const key = p.doi ? p.doi.toLowerCase() : p.paperId;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!p.source) p.source = sourceTag;
      allPapers.push(p);
      sourceBreakdown[sourceTag] = (sourceBreakdown[sourceTag] || 0) + 1;
      added++;
    }
    return added;
  }

  // 1. OpenAlex random (50%) — primary source
  try {
    const { sampleRandom } = require('./openalex');
    console.log(`[SAMPLER] OpenAlex random start: target ${oaRandomTarget}`);
    const oaPapers = await sampleRandom(oaRandomTarget);
    const added = addPapers(oaPapers, 'openalex');
    console.log(`[SAMPLER] OpenAlex random: ${added} papers`);
    if (onProgress) onProgress(allPapers.length, targetTotal);
  } catch (e) {
    console.error(`[SAMPLER] OpenAlex random failed: ${e.message}`);
  }

  // 2. Fresh preprints (45% → AI-heavy)
  try {
    const { getFreshPreprints } = require('./preprint-monitor');
    console.log(`[SAMPLER] Preprints start: target ${preprintTarget}`);
    const preprints = await getFreshPreprints(7, { aiFocus: true });
    const added = addPapers(preprints, 'preprints');
    console.log(`[SAMPLER] Preprints: ${added} papers`);
    if (onProgress) onProgress(allPapers.length, targetTotal);
  } catch (e) {
    console.error(`[SAMPLER] Preprints failed: ${e.message}`);
  }

  // 3. PubMed via Europe PMC (10%)
  if (process.env.NCBI_API_KEY || true) {
    try {
      const { searchPapers: searchEPMC } = require('./europe-pmc');
      console.log(`[SAMPLER] PubMed/EuropePMC start: target ${pubmedTarget}`);
      const queries = CROSSDOMAIN_QUERIES.concat(SURPRISE_QUERIES.slice(0, 3));
      let pubmedAdded = 0;
      for (const q of queries) {
        if (pubmedAdded >= pubmedTarget) break;
        const results = await searchEPMC(q, { pageSize: Math.min(25, pubmedTarget - pubmedAdded) });
        for (const p of results) {
          if (pubmedAdded >= pubmedTarget) break;
          const key = p.doi ? p.doi.toLowerCase() : p.pmid || p.id;
          if (!key || seen.has(key)) continue;
          if (!p.abstract || p.abstract.length < 50) continue;
          seen.add(key);
          const normalized = {
            paperId: p.pmid || p.id,
            doi: p.doi,
            title: p.title,
            abstract: p.abstract,
            year: p.year,
            citationCount: p.citedByCount || 0,
            authors: p.authors,
            journal: p.journal,
            source: 'pubmed'
          };
          allPapers.push(normalized);
          sourceBreakdown.pubmed = (sourceBreakdown.pubmed || 0) + 1;
          pubmedAdded++;
        }
      }
      console.log(`[SAMPLER] PubMed/EuropePMC: ${pubmedAdded} papers`);
      if (onProgress) onProgress(allPapers.length, targetTotal);
    } catch (e) {
      console.error(`[SAMPLER] PubMed/EuropePMC failed: ${e.message}`);
    }
  }

  // 4. OpenAlex anomaly-targeted (10%)
  try {
    const { sampleByAnomaly } = require('./openalex');
    console.log(`[SAMPLER] OpenAlex anomaly start: target ${anomalyTarget}`);
    const anomalyPapers = await sampleByAnomaly(anomalyTarget);
    const added = addPapers(anomalyPapers, 'anomaly');
    console.log(`[SAMPLER] Anomaly targeted: ${added} papers`);
    if (onProgress) onProgress(allPapers.length, targetTotal);
  } catch (e) {
    console.error(`[SAMPLER] Anomaly sampling failed: ${e.message}`);
  }

  // 5. If still under target, try OpenAlex fresh preprints as filler
  if (allPapers.length < targetTotal) {
    try {
      const { sampleFreshPreprints } = require('./openalex');
      const remaining = targetTotal - allPapers.length;
      const fillerCount = Math.min(500, Math.max(200, remaining));
      console.log(`[SAMPLER] OpenAlex fresh filler start: target ${fillerCount} (remaining ${remaining})`);
      const freshPapers = await sampleFreshPreprints(fillerCount);
      const added = addPapers(freshPapers, 'openalex');
      console.log(`[SAMPLER] OpenAlex fresh filler: ${added} papers`);
    } catch (e) {
      console.error(`[SAMPLER] OpenAlex fresh filler failed: ${e.message}`);
    }
  }

  // 6. S2 keyword queries — fallback only if still under target
  if (allPapers.length < targetTotal) {
    try {
      const remaining = targetTotal - allPapers.length;
      console.warn(`[SAMPLER] S2 fallback engaged: remaining ${remaining} papers`);
      const s2Papers = await sampleFromS2(remaining);
      const added = addPapers(s2Papers, 's2');
      console.log(`[SAMPLER] S2 fallback: ${added} papers`);
      if (onProgress) onProgress(allPapers.length, targetTotal);
    } catch (e) {
      console.error(`[SAMPLER] S2 fallback failed: ${e.message}`);
    }
  } else {
    console.log('[SAMPLER] S2 fallback skipped (target reached)');
  }

  console.log(`[SAMPLER] Complete: ${allPapers.length} papers | ` +
    `openalex=${sourceBreakdown.openalex} pubmed=${sourceBreakdown.pubmed} preprints=${sourceBreakdown.preprints} ` +
    `anomaly=${sourceBreakdown.anomaly} s2=${sourceBreakdown.s2}`);

  // Cache the results
  writeSampleCache(allPapers, sourceBreakdown);

  return {
    papers: allPapers,
    sourceBreakdown,
    cached_hits: 0,
    from_cache: false
  };
}

module.exports = { samplePapers, sampleFromS2, SAMPLE_CACHE_FILE, SOURCE_WEIGHTS };
