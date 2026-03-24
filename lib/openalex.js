/**
 * CLASHD-27 OpenAlex Integration — Primary Paper Sampler
 *
 * Replaces random S2 sampling with OpenAlex (240M+ works, free, CC0).
 * Provides random sampling, anomaly-targeted sampling, and semantic search.
 *
 * API: https://api.openalex.org
 * Rate limit: 100K/day free (polite pool with mailto param → 10 req/sec)
 * Cache: data/openalex-cache.json, 6-hour TTL
 */

const fs = require('fs');
const path = require('path');

const OA_BASE = 'https://api.openalex.org';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'openalex-cache.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MIN_REQUEST_INTERVAL_MS = 110; // 10 req/sec polite pool
const MAX_RETRIES = 3;
const MAILTO = process.env.OPENALEX_MAILTO || '';

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
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return data;
    }
  } catch (e) {
    console.error(`[OPENALEX] Cache read error: ${e.message}`);
  }
  return { _version: 1, samples: {}, timestamp: null };
}

function writeCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[OPENALEX] Cache write error: ${e.message}`);
  }
}

function isCacheValid(cache, key) {
  if (!cache.samples[key]) return false;
  const age = Date.now() - new Date(cache.samples[key].timestamp).getTime();
  return age < CACHE_TTL_MS;
}

// ─────────────────────────────────────────────────────────────
// Abstract reconstruction from inverted index
// ─────────────────────────────────────────────────────────────

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      words[pos] = word;
    }
  }
  return words.join(' ');
}

// ─────────────────────────────────────────────────────────────
// Core API fetch
// ─────────────────────────────────────────────────────────────

async function oaFetch(urlPath, retries = 0) {
  await rateLimit();
  const sep = urlPath.includes('?') ? '&' : '?';
  const politeParam = MAILTO ? `${sep}mailto=${encodeURIComponent(MAILTO)}` : '';
  const url = `${OA_BASE}${urlPath}${politeParam}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });

    if (response.status === 429) {
      if (retries < MAX_RETRIES) {
        const wait = (retries + 1) * 2000;
        console.log(`[OPENALEX] Rate limited, waiting ${wait}ms (retry ${retries + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, wait));
        return oaFetch(urlPath, retries + 1);
      }
      console.error('[OPENALEX] Rate limited after max retries');
      return null;
    }

    if (!response.ok) {
      console.error(`[OPENALEX] HTTP ${response.status}: ${url.slice(0, 150)}`);
      return null;
    }

    return await response.json();
  } catch (e) {
    if (retries < MAX_RETRIES) {
      const wait = (retries + 1) * 1500;
      console.error(`[OPENALEX] Fetch error (retry ${retries + 1}/${MAX_RETRIES}): ${e.message}`);
      await new Promise(r => setTimeout(r, wait));
      return oaFetch(urlPath, retries + 1);
    }
    console.error(`[OPENALEX] Fetch failed after retries: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Normalize OpenAlex work to internal paper format
// ─────────────────────────────────────────────────────────────

function normalizeWork(work) {
  if (!work || !work.id) return null;

  const abstract = work.abstract_inverted_index
    ? reconstructAbstract(work.abstract_inverted_index)
    : '';

  if (!abstract || abstract.length < 50) return null;

  const doi = work.doi ? work.doi.replace('https://doi.org/', '') : null;
  const authors = (work.authorships || [])
    .slice(0, 5)
    .map(a => a.author?.display_name || '')
    .filter(Boolean);
  const authorStr = authors.length > 2
    ? `${authors[0]} et al.`
    : authors.join(' and ');

  const concepts = (work.concepts || [])
    .filter(c => c.score > 0.3)
    .map(c => c.display_name)
    .slice(0, 10);

  const primaryTopic = work.primary_topic || null;
  const fieldsOfStudy = primaryTopic
    ? [primaryTopic.field?.display_name, primaryTopic.subfield?.display_name, primaryTopic.domain?.display_name].filter(Boolean)
    : concepts.slice(0, 3);

  return {
    paperId: work.id.replace('https://openalex.org/', ''),
    doi,
    title: work.title || '',
    abstract: abstract.slice(0, 500),
    year: work.publication_year || null,
    citationCount: work.cited_by_count || 0,
    influentialCitationCount: 0,
    authors: authorStr,
    journal: work.primary_location?.source?.display_name || '',
    fieldsOfStudy,
    concepts,
    primaryTopic: primaryTopic ? {
      field: primaryTopic.field?.display_name || '',
      subfield: primaryTopic.subfield?.display_name || '',
      domain: primaryTopic.domain?.display_name || ''
    } : null,
    isRetracted: work.is_retracted || false,
    type: work.type || 'article',
    referencedWorksCount: work.referenced_works_count || 0,
    referencedWorks: (work.referenced_works || []).slice(0, 20),
    source: 'openalex'
  };
}

// ─────────────────────────────────────────────────────────────
// Sampling functions
// ─────────────────────────────────────────────────────────────

const OA_FIELDS = 'id,doi,title,abstract_inverted_index,concepts,primary_topic,type,publication_year,cited_by_count,referenced_works_count,referenced_works,is_retracted,authorships,primary_location';

/**
 * Random sample across diverse fields.
 * Makes multiple paginated requests to get broad coverage.
 */
async function sampleRandom(count = 1620) {
  const cache = readCache();
  if (isCacheValid(cache, 'random')) {
    console.log(`[OPENALEX] Using cached random sample: ${cache.samples.random.papers.length} papers`);
    return cache.samples.random.papers;
  }

  console.log(`[OPENALEX] Sampling ${count} random papers...`);
  const papers = [];
  const seen = new Set();

  // Strategy: diverse field sampling with publication_year filter
  const fields = [
    'C86803240',  // Biology
    'C71924100',  // Medicine
    'C41008148',  // Computer Science
    'C121332964', // Physics
    'C185592680', // Chemistry
    'C127313418', // Geology
    'C15744967',  // Psychology
    'C33923547',  // Mathematics
    'C162324750', // Environmental Science
    'C205649164', // Political Science
  ];

  const years = [2020, 2021, 2022, 2023, 2024, 2025];
  const perRequest = 50;
  const requestsNeeded = Math.ceil(count / perRequest);

  for (let i = 0; i < requestsNeeded && papers.length < count; i++) {
    const field = fields[i % fields.length];
    const year = years[i % years.length];
    const page = Math.floor(i / fields.length) + 1;

    const data = await oaFetch(
      `/works?filter=concepts.id:${field},publication_year:${year}&per_page=${perRequest}&page=${page}&select=${OA_FIELDS}&sort=cited_by_count:desc`
    );

    if (!data || !data.results) continue;

    for (const work of data.results) {
      const paper = normalizeWork(work);
      if (!paper || seen.has(paper.paperId)) continue;
      seen.add(paper.paperId);
      papers.push(paper);
    }

    if (papers.length % 200 === 0) {
      console.log(`[OPENALEX] Random sample progress: ${papers.length}/${count}`);
    }
  }

  // Also add some truly random samples
  for (let i = 0; i < 5 && papers.length < count; i++) {
    const data = await oaFetch(
      `/works?sample=50&per_page=50&filter=publication_year:2020-2025,has_abstract:true&select=${OA_FIELDS}`
    );
    if (!data || !data.results) continue;
    for (const work of data.results) {
      const paper = normalizeWork(work);
      if (!paper || seen.has(paper.paperId)) continue;
      seen.add(paper.paperId);
      papers.push(paper);
    }
  }

  console.log(`[OPENALEX] Random sample complete: ${papers.length} papers`);

  // Cache
  cache.samples.random = { papers, timestamp: new Date().toISOString() };
  writeCache(cache);

  return papers;
}

/**
 * Anomaly-targeted sampling: retracted papers, high citation velocity, overlooked connections.
 */
async function sampleByAnomaly(count = 270) {
  const cache = readCache();
  if (isCacheValid(cache, 'anomaly')) {
    console.log(`[OPENALEX] Using cached anomaly sample: ${cache.samples.anomaly.papers.length} papers`);
    return cache.samples.anomaly.papers;
  }

  console.log(`[OPENALEX] Sampling ${count} anomaly-targeted papers...`);
  const papers = [];
  const seen = new Set();
  const perRequest = 50;

  // 1. Retracted papers
  const retractedData = await oaFetch(
    `/works?filter=is_retracted:true,publication_year:2015-2025&per_page=${perRequest}&select=${OA_FIELDS}&sort=cited_by_count:desc`
  );
  if (retractedData && retractedData.results) {
    for (const work of retractedData.results) {
      const paper = normalizeWork(work);
      if (paper && !seen.has(paper.paperId)) {
        seen.add(paper.paperId);
        papers.push(paper);
      }
    }
  }

  // 2. High citation count recent papers (citation velocity proxy)
  const highCiteData = await oaFetch(
    `/works?filter=cited_by_count:>100,publication_year:2024-2025&per_page=${perRequest}&select=${OA_FIELDS}&sort=cited_by_count:desc`
  );
  if (highCiteData && highCiteData.results) {
    for (const work of highCiteData.results) {
      const paper = normalizeWork(work);
      if (paper && !seen.has(paper.paperId)) {
        seen.add(paper.paperId);
        papers.push(paper);
      }
    }
  }

  // 3. Semantic search for anomaly language
  const anomalyQueries = [
    'unexpected finding contradicts hypothesis',
    'surprising result paradoxical effect',
    'failed replication reproducibility crisis',
    'anomalous observation novel mechanism'
  ];
  for (const query of anomalyQueries) {
    if (papers.length >= count) break;
    const data = await oaFetch(
      `/works?search=${encodeURIComponent(query)}&per_page=25&filter=publication_year:2020-2025,has_abstract:true&select=${OA_FIELDS}`
    );
    if (!data || !data.results) continue;
    for (const work of data.results) {
      const paper = normalizeWork(work);
      if (paper && !seen.has(paper.paperId)) {
        seen.add(paper.paperId);
        papers.push(paper);
      }
    }
  }

  console.log(`[OPENALEX] Anomaly sample complete: ${papers.length} papers`);

  cache.samples.anomaly = { papers, timestamp: new Date().toISOString() };
  writeCache(cache);

  return papers;
}

/**
 * Fresh preprints from OpenAlex (type=preprint, current year).
 */
async function sampleFreshPreprints(count = 200) {
  const cache = readCache();
  if (isCacheValid(cache, 'preprints_oa')) {
    console.log(`[OPENALEX] Using cached OA preprint sample: ${cache.samples.preprints_oa.papers.length} papers`);
    return cache.samples.preprints_oa.papers;
  }

  console.log(`[OPENALEX] Sampling ${count} fresh preprints...`);
  const papers = [];
  const seen = new Set();
  const currentYear = new Date().getFullYear();

  const data = await oaFetch(
    `/works?filter=type:article,publication_year:${currentYear},has_abstract:true&per_page=50&sort=publication_date:desc&select=${OA_FIELDS}`
  );

  if (data && data.results) {
    for (const work of data.results) {
      const paper = normalizeWork(work);
      if (paper && !seen.has(paper.paperId)) {
        seen.add(paper.paperId);
        papers.push(paper);
      }
    }
  }

  // Second page
  if (papers.length < count) {
    const data2 = await oaFetch(
      `/works?filter=type:article,publication_year:${currentYear},has_abstract:true&per_page=50&page=2&sort=publication_date:desc&select=${OA_FIELDS}`
    );
    if (data2 && data2.results) {
      for (const work of data2.results) {
        const paper = normalizeWork(work);
        if (paper && !seen.has(paper.paperId)) {
          seen.add(paper.paperId);
          papers.push(paper);
        }
      }
    }
  }

  console.log(`[OPENALEX] Fresh preprint sample complete: ${papers.length} papers`);

  cache.samples.preprints_oa = { papers, timestamp: new Date().toISOString() };
  writeCache(cache);

  return papers;
}

/**
 * Clear expired cache entries.
 */
function pruneCache() {
  const cache = readCache();
  let pruned = 0;
  for (const [key, entry] of Object.entries(cache.samples)) {
    if (Date.now() - new Date(entry.timestamp).getTime() > CACHE_TTL_MS) {
      delete cache.samples[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    writeCache(cache);
    console.log(`[OPENALEX] Pruned ${pruned} expired cache entries`);
  }
}

module.exports = {
  sampleRandom,
  sampleByAnomaly,
  sampleFreshPreprints,
  reconstructAbstract,
  normalizeWork,
  pruneCache,
  oaFetch,
  OA_FIELDS,
  CACHE_FILE
};
