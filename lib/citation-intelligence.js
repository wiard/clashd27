/**
 * CLASHD-27 Citation Intelligence — OpenCitations
 *
 * Uses OpenCitations API for:
 *   - Citation/reference retrieval
 *   - Shared reference detection (dormant gap signal)
 *   - Citation velocity analysis (anomaly signal)
 *   - Cross-citation rate between paper sets
 *
 * API: https://opencitations.net/index/api/v2/
 * Rate limit: polite usage, no auth needed
 * Cache: data/citation-cache.json, 30-day TTL
 */

const fs = require('fs');
const path = require('path');

const OC_BASE = 'https://opencitations.net/index/api/v2';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'citation-cache.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_REQUEST_INTERVAL_MS = 500; // conservative, no auth
const MAX_RETRIES = 2;

let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ─────────────────────────────────────────────────────────────
// Cache management
// ─────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const data = JSON.parse(raw);
      // Size guard: if cache is over 50MB, prune
      if (raw.length > 50 * 1024 * 1024) {
        pruneCache(data);
      }
      return data;
    }
  } catch (e) {
    console.error(`[CITATIONS] Cache read error: ${e.message}`);
  }
  return { _version: 1, citations: {}, references: {}, velocity: {} };
}

function writeCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[CITATIONS] Cache write error: ${e.message}`);
  }
}

function pruneCache(cache) {
  let pruned = 0;
  const now = Date.now();
  for (const section of ['citations', 'references', 'velocity']) {
    for (const [key, entry] of Object.entries(cache[section] || {})) {
      if (now - new Date(entry.timestamp || 0).getTime() > CACHE_TTL_MS) {
        delete cache[section][key];
        pruned++;
      }
    }
  }
  if (pruned > 0) {
    writeCache(cache);
    console.log(`[CITATIONS] Pruned ${pruned} expired cache entries`);
  }
}

// ─────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────

async function ocFetch(urlPath, retries = 0) {
  await rateLimit();
  const url = `${OC_BASE}${urlPath}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0', 'Accept': 'application/json' }
    });

    if (response.status === 429) {
      if (retries < MAX_RETRIES) {
        const wait = (retries + 1) * 3000;
        console.log(`[CITATIONS] Rate limited, waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        return ocFetch(urlPath, retries + 1);
      }
      return null;
    }

    if (!response.ok) {
      console.error(`[CITATIONS] HTTP ${response.status}: ${url.slice(0, 120)}`);
      return null;
    }

    return await response.json();
  } catch (e) {
    if (retries < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000));
      return ocFetch(urlPath, retries + 1);
    }
    console.error(`[CITATIONS] Fetch failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Citation and reference retrieval
// ─────────────────────────────────────────────────────────────

/**
 * Get papers that cite a given DOI.
 * Returns [{ citing_doi, date }]
 */
async function getCitations(doi) {
  if (!doi) return [];

  const cache = readCache();
  const key = doi.toLowerCase();
  if (cache.citations[key] && Date.now() - new Date(cache.citations[key].timestamp).getTime() < CACHE_TTL_MS) {
    return cache.citations[key].data;
  }

  const data = await ocFetch(`/citations/doi:${encodeURIComponent(doi)}`);
  if (!Array.isArray(data)) return [];

  const citations = data.map(item => ({
    citing_doi: item.citing ? item.citing.replace('doi:', '') : '',
    date: item.creation || null
  })).filter(c => c.citing_doi);

  // Cache
  cache.citations[key] = { data: citations, timestamp: new Date().toISOString() };
  writeCache(cache);

  return citations;
}

/**
 * Get papers referenced by a given DOI.
 * Returns [{ cited_doi, date }]
 */
async function getReferences(doi) {
  if (!doi) return [];

  const cache = readCache();
  const key = doi.toLowerCase();
  if (cache.references[key] && Date.now() - new Date(cache.references[key].timestamp).getTime() < CACHE_TTL_MS) {
    return cache.references[key].data;
  }

  const data = await ocFetch(`/references/doi:${encodeURIComponent(doi)}`);
  if (!Array.isArray(data)) return [];

  const references = data.map(item => ({
    cited_doi: item.cited ? item.cited.replace('doi:', '') : '',
    date: item.creation || null
  })).filter(r => r.cited_doi);

  // Cache
  cache.references[key] = { data: references, timestamp: new Date().toISOString() };
  writeCache(cache);

  return references;
}

// ─────────────────────────────────────────────────────────────
// Cross-citation analysis
// ─────────────────────────────────────────────────────────────

/**
 * Find shared references between two papers.
 * Shared refs = shared knowledge base (potential for dormant gap).
 */
async function findSharedReferences(doi1, doi2) {
  if (!doi1 || !doi2) return { shared: [], count: 0 };

  const [refs1, refs2] = await Promise.all([
    getReferences(doi1),
    getReferences(doi2)
  ]);

  const set1 = new Set(refs1.map(r => r.cited_doi.toLowerCase()));
  const shared = refs2.filter(r => set1.has(r.cited_doi.toLowerCase()));

  return {
    shared: shared.map(r => r.cited_doi),
    count: shared.length,
    refs1_count: refs1.length,
    refs2_count: refs2.length
  };
}

/**
 * Estimate citation velocity for a DOI.
 * Spike > 3x baseline = anomaly signal.
 */
async function citationVelocity(doi) {
  if (!doi) return { velocity: 0, spike: false };

  const cache = readCache();
  const key = doi.toLowerCase();
  if (cache.velocity[key] && Date.now() - new Date(cache.velocity[key].timestamp).getTime() < CACHE_TTL_MS) {
    return cache.velocity[key].data;
  }

  const citations = await getCitations(doi);
  if (citations.length < 5) {
    const result = { velocity: citations.length, spike: false, total: citations.length };
    cache.velocity[key] = { data: result, timestamp: new Date().toISOString() };
    writeCache(cache);
    return result;
  }

  // Count citations per year
  const yearCounts = {};
  for (const c of citations) {
    if (!c.date) continue;
    const year = c.date.slice(0, 4);
    yearCounts[year] = (yearCounts[year] || 0) + 1;
  }

  const years = Object.keys(yearCounts).sort();
  if (years.length < 2) {
    const result = { velocity: citations.length, spike: false, total: citations.length };
    cache.velocity[key] = { data: result, timestamp: new Date().toISOString() };
    writeCache(cache);
    return result;
  }

  // Calculate baseline (average of all years except the most recent)
  const recentYear = years[years.length - 1];
  const baselineYears = years.slice(0, -1);
  const baseline = baselineYears.reduce((sum, y) => sum + yearCounts[y], 0) / baselineYears.length;
  const recentCount = yearCounts[recentYear] || 0;

  const spike = baseline > 0 && recentCount / baseline > 3;

  const result = {
    velocity: recentCount,
    baseline: Math.round(baseline * 10) / 10,
    ratio: baseline > 0 ? Math.round((recentCount / baseline) * 10) / 10 : 0,
    spike,
    total: citations.length,
    yearCounts
  };

  cache.velocity[key] = { data: result, timestamp: new Date().toISOString() };
  writeCache(cache);

  return result;
}

/**
 * Dormant gap detector: cross-citation analysis between two paper sets.
 *
 * Cross-citation rate = 0 BUT shared refs exist = dormant gap (highest value).
 *
 * @param {Array} paperSetA - papers with .doi field
 * @param {Array} paperSetB - papers with .doi field
 * @param {number} maxPairs - max paper pairs to check (API budget)
 * @returns {{ crossCitationRate, sharedRefCount, dormantScore }}
 */
async function dormantGapDetector(paperSetA, paperSetB, maxPairs = 5) {
  const doisA = paperSetA.filter(p => p.doi).map(p => p.doi).slice(0, maxPairs);
  const doisB = paperSetB.filter(p => p.doi).map(p => p.doi).slice(0, maxPairs);

  if (doisA.length === 0 || doisB.length === 0) {
    return { crossCitationRate: 0, sharedRefCount: 0, dormantScore: 0 };
  }

  let crossCitations = 0;
  let totalPairs = 0;
  let totalSharedRefs = 0;

  // Check if papers in set A cite papers in set B (and vice versa)
  const doisBSet = new Set(doisB.map(d => d.toLowerCase()));
  const doisASet = new Set(doisA.map(d => d.toLowerCase()));

  for (const doiA of doisA.slice(0, 3)) {
    try {
      const refs = await getReferences(doiA);
      const citesB = refs.filter(r => doisBSet.has(r.cited_doi.toLowerCase())).length;
      crossCitations += citesB;
      totalPairs++;
    } catch (e) {
      // non-fatal
    }
  }

  for (const doiB of doisB.slice(0, 3)) {
    try {
      const refs = await getReferences(doiB);
      const citesA = refs.filter(r => doisASet.has(r.cited_doi.toLowerCase())).length;
      crossCitations += citesA;
      totalPairs++;
    } catch (e) {
      // non-fatal
    }
  }

  // Check shared references between first paper of each set
  if (doisA.length > 0 && doisB.length > 0) {
    try {
      const shared = await findSharedReferences(doisA[0], doisB[0]);
      totalSharedRefs = shared.count;
    } catch (e) {
      // non-fatal
    }
  }

  const crossCitationRate = totalPairs > 0
    ? Math.round((crossCitations / totalPairs) * 100)
    : 0;

  // Dormant score: high shared refs + zero cross-citations = dormant gap
  let dormantScore = 0;
  if (crossCitations === 0 && totalSharedRefs > 0) {
    dormantScore = Math.min(1.0, totalSharedRefs / 10);
  } else if (crossCitations === 0) {
    dormantScore = 0.3; // no cross-citations but also no shared refs
  }

  return {
    crossCitationRate: totalPairs > 0 ? Math.round((crossCitations / totalPairs) * 100) : 0,
    crossCitations,
    sharedRefCount: totalSharedRefs,
    dormantScore: Math.round(dormantScore * 100) / 100,
    pairsChecked: totalPairs
  };
}

module.exports = {
  getCitations,
  getReferences,
  findSharedReferences,
  citationVelocity,
  dormantGapDetector,
  CACHE_FILE
};
