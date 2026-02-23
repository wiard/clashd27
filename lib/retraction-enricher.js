/**
 * CLASHD-27 Retraction Enricher
 *
 * Downloads and caches Retraction Watch data from Crossref Labs.
 * Cross-references during classification to boost Surprise Index.
 *
 * Full dataset: https://api.labs.crossref.org/data/retractionwatch
 * Fallback: Crossref API filter=update-type:retraction
 *
 * Cache: data/retraction-cache.json, 7-day TTL
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'retraction-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || process.env.OPENALEX_MAILTO || '';
const MAX_RETRIES = 2;

// In-memory retraction map (DOI → retraction info)
let retractionMap = new Map();
let initialized = false;

// ─────────────────────────────────────────────────────────────
// Cache management
// ─────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[RETRACTION] Cache read error: ${e.message}`);
  }
  return null;
}

function writeCache(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[RETRACTION] Cache write error: ${e.message}`);
  }
}

function isCacheValid(cache) {
  if (!cache || !cache.timestamp) return false;
  return Date.now() - new Date(cache.timestamp).getTime() < CACHE_TTL_MS;
}

// ─────────────────────────────────────────────────────────────
// Initialize: load from cache or fetch from Crossref API
// ─────────────────────────────────────────────────────────────

/**
 * Initialize retraction database.
 * Uses Crossref API to fetch retracted works (simpler than full CSV).
 * Caches results for 7 days.
 */
async function init() {
  if (initialized && retractionMap.size > 0) return;

  // Try cache first
  const cache = readCache();
  if (isCacheValid(cache)) {
    retractionMap = new Map(Object.entries(cache.retractions || {}));
    initialized = true;
    console.log(`[RETRACTION] Loaded ${retractionMap.size} retracted DOIs from cache`);
    return;
  }

  console.log('[RETRACTION] Fetching retraction data from Crossref...');
  retractionMap = new Map();

  try {
    // Fetch recent retractions from Crossref (last 5 years, paginated)
    const politeParam = CROSSREF_MAILTO ? `&mailto=${encodeURIComponent(CROSSREF_MAILTO)}` : '';
    const years = [2020, 2021, 2022, 2023, 2024, 2025];

    for (const year of years) {
      let cursor = '*';
      let fetched = 0;
      const maxPerYear = 2000;

      while (fetched < maxPerYear) {
        const url = `https://api.crossref.org/works?filter=type:journal-article,from-pub-date:${year}-01-01,until-pub-date:${year}-12-31,has-update:true&rows=100&cursor=${encodeURIComponent(cursor)}&select=DOI,title,update-to${politeParam}`;

        const response = await fetch(url, {
          headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
        });

        if (!response.ok) {
          console.error(`[RETRACTION] Crossref HTTP ${response.status} for year ${year}`);
          break;
        }

        const data = await response.json();
        const items = data.message?.items || [];

        if (items.length === 0) break;

        for (const item of items) {
          const doi = (item.DOI || '').toLowerCase();
          if (!doi) continue;

          // Check if any update is a retraction
          const updates = item['update-to'] || [];
          for (const update of updates) {
            if (update.type === 'retraction' || update.label === 'Retraction') {
              const retractedDoi = (update.DOI || '').toLowerCase();
              if (retractedDoi) {
                retractionMap.set(retractedDoi, {
                  retractingDoi: doi,
                  reason: update.label || 'retraction',
                  date: item.created?.['date-time'] || null
                });
              }
            }
          }
        }

        cursor = data.message?.['next-cursor'] || '';
        if (!cursor) break;
        fetched += items.length;

        // Rate limit: ~50 req/sec for polite pool, but be conservative
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch (e) {
    console.error(`[RETRACTION] Crossref fetch failed: ${e.message}`);
  }

  // Also try to get OpenAlex retracted papers as supplement
  try {
    const oaUrl = 'https://api.openalex.org/works?filter=is_retracted:true,publication_year:2015-2025&per_page=200&select=id,doi,title,publication_year';
    const polite = CROSSREF_MAILTO ? `&mailto=${encodeURIComponent(CROSSREF_MAILTO)}` : '';
    const oaResp = await fetch(`${oaUrl}${polite}`);
    if (oaResp.ok) {
      const oaData = await oaResp.json();
      for (const work of (oaData.results || [])) {
        if (work.doi) {
          const doi = work.doi.replace('https://doi.org/', '').toLowerCase();
          if (!retractionMap.has(doi)) {
            retractionMap.set(doi, { reason: 'retracted (openalex)', date: null });
          }
        }
      }
    }
  } catch (e) {
    console.error(`[RETRACTION] OpenAlex supplement failed: ${e.message}`);
  }

  // Cache results
  const cacheData = {
    timestamp: new Date().toISOString(),
    count: retractionMap.size,
    retractions: Object.fromEntries(retractionMap)
  };
  writeCache(cacheData);

  initialized = true;
  console.log(`[RETRACTION] Initialized: ${retractionMap.size} retracted DOIs`);
}

// ─────────────────────────────────────────────────────────────
// Query functions
// ─────────────────────────────────────────────────────────────

/**
 * Check if a DOI is retracted.
 */
function isRetracted(doi) {
  if (!doi) return false;
  return retractionMap.has(doi.toLowerCase());
}

/**
 * Get retraction reason for a DOI.
 */
function getRetractionReason(doi) {
  if (!doi) return null;
  const entry = retractionMap.get(doi.toLowerCase());
  return entry ? entry.reason : null;
}

/**
 * Check if a paper cites any retracted papers.
 * Takes an array of referenced DOIs.
 * Returns { count, retracted_dois }
 */
function citesRetractedPaper(referencedDois) {
  if (!Array.isArray(referencedDois) || referencedDois.length === 0) {
    return { count: 0, retracted_dois: [] };
  }

  const retractedCited = [];
  for (const refDoi of referencedDois) {
    const doi = typeof refDoi === 'string'
      ? refDoi.replace('https://doi.org/', '').toLowerCase()
      : '';
    if (doi && retractionMap.has(doi)) {
      retractedCited.push(doi);
    }
  }

  return {
    count: retractedCited.length,
    retracted_dois: retractedCited
  };
}

/**
 * Get total retraction count (for stats).
 */
function getRetractionCount() {
  return retractionMap.size;
}

/**
 * Check if initialized.
 */
function isInitialized() {
  return initialized;
}

module.exports = {
  init,
  isRetracted,
  getRetractionReason,
  citesRetractedPaper,
  getRetractionCount,
  isInitialized,
  CACHE_FILE
};
