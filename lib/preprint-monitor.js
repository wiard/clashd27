/**
 * CLASHD-27 Preprint Monitor
 *
 * Fetches fresh preprints from:
 *   - bioRxiv API (biology preprints)
 *   - medRxiv API (health/medicine preprints)
 *   - arXiv API (physics, CS, quantitative biology preprints)
 *
 * Rate limits:
 *   bioRxiv/medRxiv: reasonable usage, 100 per page
 *   arXiv: 1 request per 3 seconds (strict!)
 *
 * Cache: data/preprint-cache.json, 24-hour TTL
 */

const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'preprint-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const BIORXIV_BASE = 'https://api.biorxiv.org/details';
const ARXIV_BASE = 'http://export.arxiv.org/api/query';
const ARXIV_MIN_INTERVAL_MS = 3100; // 1 request per 3 seconds (strict)

let lastArxivRequest = 0;
const AI_ARXIV_CATEGORIES = ['cs.LG', 'cs.AI', 'cs.CL', 'cs.CV', 'stat.ML', 'cs.RO', 'cs.CR', 'cs.SE'];

// ─────────────────────────────────────────────────────────────
// Cache management
// ─────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[PREPRINT] Cache read error: ${e.message}`);
  }
  return { _version: 1, sources: {}, timestamp: null };
}

function writeCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[PREPRINT] Cache write error: ${e.message}`);
  }
}

function isCacheValid(cache, key) {
  if (!cache.sources[key]) return false;
  return Date.now() - new Date(cache.sources[key].timestamp).getTime() < CACHE_TTL_MS;
}

// ─────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ─────────────────────────────────────────────────────────────
// bioRxiv / medRxiv API
// ─────────────────────────────────────────────────────────────

async function fetchBioRxiv(startDate, endDate, server = 'biorxiv') {
  const start = typeof startDate === 'string' ? startDate : formatDate(startDate);
  const end = typeof endDate === 'string' ? endDate : formatDate(endDate);
  const url = `${BIORXIV_BASE}/${server}/${start}/${end}/0/100`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });
    if (!response.ok) {
      console.error(`[PREPRINT] ${server} HTTP ${response.status}`);
      return [];
    }
    const data = await response.json();
    const collection = data.collection || [];

    return collection.map(item => ({
      paperId: `${server}:${item.doi || item.biorxiv_doi || ''}`,
      doi: item.doi || item.biorxiv_doi || null,
      title: item.title || '',
      abstract: (item.abstract || '').slice(0, 500),
      year: item.date ? parseInt(item.date.slice(0, 4)) : new Date().getFullYear(),
      citationCount: 0,
      influentialCitationCount: 0,
      authors: item.authors || '',
      journal: server === 'biorxiv' ? 'bioRxiv' : 'medRxiv',
      fieldsOfStudy: item.category ? [item.category] : [],
      concepts: [],
      primaryTopic: null,
      isRetracted: false,
      type: 'preprint',
      source: server
    })).filter(p => p.abstract.length >= 50);
  } catch (e) {
    console.error(`[PREPRINT] ${server} fetch error: ${e.message}`);
    return [];
  }
}

async function fetchMedRxiv(startDate, endDate) {
  return fetchBioRxiv(startDate, endDate, 'medrxiv');
}

// ─────────────────────────────────────────────────────────────
// arXiv API (Atom XML)
// ─────────────────────────────────────────────────────────────

async function arxivRateLimit() {
  const now = Date.now();
  const elapsed = now - lastArxivRequest;
  if (elapsed < ARXIV_MIN_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, ARXIV_MIN_INTERVAL_MS - elapsed));
  }
  lastArxivRequest = Date.now();
}

/**
 * Fetch papers from arXiv.
 * Categories: q-bio.*, stat.ML, cs.AI, cs.LG, physics.bio-ph, physics.med-ph
 */
async function fetchArxiv(categories, maxResults = 100) {
  await arxivRateLimit();

  const catQuery = categories.map(c => `cat:${c}`).join('+OR+');
  const url = `${ARXIV_BASE}?search_query=${catQuery}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });
    if (!response.ok) {
      console.error(`[PREPRINT] arXiv HTTP ${response.status}`);
      return [];
    }

    const xml = await response.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false });

    const feed = parsed.feed;
    if (!feed || !feed.entry) return [];

    const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];

    return entries.map(entry => {
      const id = entry.id || '';
      const arxivId = id.replace('http://arxiv.org/abs/', '');
      const categories = Array.isArray(entry.category)
        ? entry.category.map(c => c.$ ? c.$.term : c)
        : entry.category?.$ ? [entry.category.$.term] : [];
      const authors = Array.isArray(entry.author)
        ? entry.author.map(a => a.name || '').slice(0, 5).join(', ')
        : entry.author?.name || '';

      const summary = typeof entry.summary === 'string'
        ? entry.summary
        : entry.summary?._ || '';

      return {
        paperId: `arxiv:${arxivId}`,
        doi: null,
        title: (typeof entry.title === 'string' ? entry.title : entry.title?._ || '').replace(/\n/g, ' ').trim(),
        abstract: summary.replace(/\n/g, ' ').trim().slice(0, 500),
        year: entry.published ? parseInt(entry.published.slice(0, 4)) : new Date().getFullYear(),
        citationCount: 0,
        influentialCitationCount: 0,
        authors,
        journal: 'arXiv',
        fieldsOfStudy: categories.filter(Boolean),
        concepts: [],
        primaryTopic: null,
        isRetracted: false,
        type: 'preprint',
        source: 'arxiv'
      };
    }).filter(p => p.abstract.length >= 50);
  } catch (e) {
    console.error(`[PREPRINT] arXiv fetch error: ${e.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Combined fresh anomaly pipeline
// ─────────────────────────────────────────────────────────────

/**
 * Fetch fresh preprints from all sources, optionally filtering for anomaly language.
 */
async function getFreshPreprints(daysBack = 7, opts = {}) {
  const cache = readCache();
  if (isCacheValid(cache, 'combined')) {
    console.log(`[PREPRINT] Using cached combined preprints: ${cache.sources.combined.papers.length} papers`);
    return cache.sources.combined.papers;
  }

  console.log(`[PREPRINT] Fetching fresh preprints (last ${daysBack} days)...`);
  const startDate = daysAgo(daysBack);
  const endDate = new Date();

  // Fetch from all 3 sources
  const arxivCats = opts.aiFocus ? AI_ARXIV_CATEGORIES : ['q-bio.BM', 'q-bio.GN', 'q-bio.MN', 'q-bio.QM', 'stat.ML', 'cs.AI', 'cs.LG', 'physics.bio-ph'];
  const arxivMax = opts.aiFocus ? 300 : 100;

  const [bioRxivPapers, medRxivPapers, arxivPapers] = await Promise.all([
    fetchBioRxiv(startDate, endDate).catch(e => {
      console.error(`[PREPRINT] bioRxiv failed: ${e.message}`);
      return [];
    }),
    fetchMedRxiv(startDate, endDate).catch(e => {
      console.error(`[PREPRINT] medRxiv failed: ${e.message}`);
      return [];
    }),
    fetchArxiv(arxivCats, arxivMax).catch(e => {
      console.error(`[PREPRINT] arXiv failed: ${e.message}`);
      return [];
    })
  ]);

  // Deduplicate by paperId
  const seen = new Set();
  const allPapers = [];
  for (const paper of [...bioRxivPapers, ...medRxivPapers, ...arxivPapers]) {
    if (seen.has(paper.paperId)) continue;
    seen.add(paper.paperId);
    allPapers.push(paper);
  }

  console.log(`[PREPRINT] Fetched ${allPapers.length} preprints (bioRxiv=${bioRxivPapers.length} medRxiv=${medRxivPapers.length} arXiv=${arxivPapers.length})`);

  // Cache results
  cache.sources.combined = {
    papers: allPapers,
    timestamp: new Date().toISOString(),
    counts: {
      biorxiv: bioRxivPapers.length,
      medrxiv: medRxivPapers.length,
      arxiv: arxivPapers.length
    }
  };
  writeCache(cache);

  return allPapers;
}

/**
 * Filter preprints for anomaly language markers.
 */
function filterAnomalies(papers) {
  const anomalyMarkers = [
    'unexpectedly', 'contrary to', 'surprisingly', 'paradoxically',
    'contradicts', 'failed to replicate', 'counterintuitive',
    'unprecedented', 'anomalous', 'challenges the assumption'
  ];

  return papers.filter(p => {
    const text = `${p.title} ${p.abstract}`.toLowerCase();
    return anomalyMarkers.some(m => text.includes(m));
  });
}

module.exports = {
  fetchBioRxiv,
  fetchMedRxiv,
  fetchArxiv,
  getFreshPreprints,
  filterAnomalies,
  CACHE_FILE
};
