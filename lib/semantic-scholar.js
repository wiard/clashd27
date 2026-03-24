/**
 * CLASHD-27 Semantic Scholar Integration
 * Provides real paper data from Semantic Scholar's free API.
 * - Rate-limited (1 req/sec)
 * - 7-day file cache (data/papers-cache.json)
 * - Zero dependencies beyond Node.js 22 built-in fetch
 */

const fs = require('fs');
const path = require('path');

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'papers-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MIN_REQUEST_INTERVAL_MS = 1100; // 1.1s between requests
const MAX_RETRIES = 2;
const SEARCH_FIELDS = 'title,abstract,year,citationCount,influentialCitationCount,isOpenAccess,authors,journal,tldr,fieldsOfStudy,externalIds';
const PAPER_FIELDS = 'title,abstract,year,citationCount,influentialCitationCount,isOpenAccess,authors,journal,tldr,fieldsOfStudy,externalIds';

// ─────────────────────────────────────────────────────────────
// Rate limiter (in-memory)
// ─────────────────────────────────────────────────────────────

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

function queryHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16);
}

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      // Prune expired entries (max once per day)
      const now = Date.now();
      if (!data._last_pruned || now - new Date(data._last_pruned).getTime() > 86400000) {
        let pruned = 0;
        for (const [id, paper] of Object.entries(data.papers || {})) {
          if (now - new Date(paper.cachedAt).getTime() > CACHE_TTL_MS) {
            delete data.papers[id];
            pruned++;
          }
        }
        for (const [hash, search] of Object.entries(data.searches || {})) {
          if (now - new Date(search.cachedAt).getTime() > CACHE_TTL_MS) {
            delete data.searches[hash];
            pruned++;
          }
        }
        data._last_pruned = new Date().toISOString();
        if (pruned > 0) writeCache(data);
      }
      return data;
    }
  } catch (e) {
    console.error(`[S2] Cache read error: ${e.message}`);
  }
  return { _version: 1, _last_pruned: new Date().toISOString(), papers: {}, searches: {} };
}

function writeCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[S2] Cache write error: ${e.message}`);
  }
}

function normalizePaper(raw) {
  if (!raw || !raw.paperId) return null;
  const doi = raw.externalIds?.DOI || null;
  const authors = (raw.authors || []).map(a => a.name).slice(0, 5);
  const authorStr = authors.length > 2
    ? `${authors[0]} et al.`
    : authors.join(' and ');
  return {
    paperId: raw.paperId,
    doi,
    title: raw.title || '',
    abstract: (raw.abstract || '').slice(0, 500),
    tldr: raw.tldr?.text || null,
    year: raw.year || null,
    citationCount: raw.citationCount || 0,
    influentialCitationCount: raw.influentialCitationCount || 0,
    authors: authorStr,
    journal: raw.journal?.name || '',
    fieldsOfStudy: raw.fieldsOfStudy || [],
    isOpenAccess: raw.isOpenAccess || false,
    cachedAt: new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────────────────
// Core API functions
// ─────────────────────────────────────────────────────────────

async function s2Fetch(urlPath, retries = 0) {
  await rateLimit();
  const url = `${S2_BASE}${urlPath}`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/1.0 (contact: greenbanaanas)' }
    });
    if (response.status === 429) {
      if (retries < MAX_RETRIES) {
        const wait = (retries + 1) * 2000;
        console.log(`[S2] Rate limited, waiting ${wait}ms (retry ${retries + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, wait));
        return s2Fetch(urlPath, retries + 1);
      }
      console.error('[S2] Rate limited after max retries');
      return null;
    }
    if (!response.ok) {
      console.error(`[S2] HTTP ${response.status}: ${url.slice(0, 120)}`);
      return null;
    }
    return await response.json();
  } catch (e) {
    console.error(`[S2] Fetch error: ${e.message}`);
    return null;
  }
}

/**
 * Search Semantic Scholar for papers matching a query.
 * Returns normalized paper objects. Uses cache.
 */
async function searchPapers(query, limit = 10) {
  const cache = readCache();
  const hash = queryHash(query.toLowerCase().trim());

  // Check cache
  const cached = cache.searches[hash];
  if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
    const papers = cached.paperIds.map(id => cache.papers[id]).filter(Boolean);
    if (papers.length > 0) return papers;
  }

  // Fetch from API
  const encoded = encodeURIComponent(query);
  const data = await s2Fetch(`/paper/search?query=${encoded}&limit=${limit}&fields=${SEARCH_FIELDS}`);
  if (!data || !data.data) return [];

  const papers = data.data.map(normalizePaper).filter(Boolean);

  // Store total from S2 on each paper for reference
  for (const p of papers) {
    p._searchTotal = data.total || papers.length;
    cache.papers[p.paperId] = p;
  }

  // Cache search result
  cache.searches[hash] = {
    query: query.slice(0, 200),
    paperIds: papers.map(p => p.paperId),
    total: data.total || papers.length,
    cachedAt: new Date().toISOString()
  };

  writeCache(cache);
  return papers;
}

/**
 * Get a single paper by ID. Supports: S2 ID, "DOI:10.xxx/yyy", "PMID:12345"
 */
async function getPaper(paperId) {
  const cache = readCache();
  const cached = cache.papers[paperId];
  if (cached && Date.now() - new Date(cached.cachedAt).getTime() < CACHE_TTL_MS) {
    return cached;
  }

  const data = await s2Fetch(`/paper/${encodeURIComponent(paperId)}?fields=${PAPER_FIELDS}`);
  if (!data) return null;

  const paper = normalizePaper(data);
  if (paper) {
    cache.papers[paper.paperId] = paper;
    writeCache(cache);
  }
  return paper;
}

/**
 * Verify a DOI exists in Semantic Scholar.
 */
async function verifyDOI(doiString) {
  if (!doiString) return { exists: false, paper: null };
  // Extract DOI pattern (10.xxxx/yyyy)
  const doiMatch = doiString.match(/(10\.\d{4,}\/[^\s,;]+)/);
  if (!doiMatch) return { exists: false, paper: null };

  const doi = doiMatch[1].replace(/[.)}\]]+$/, ''); // Strip trailing punctuation
  const paper = await getPaper(`DOI:${doi}`);
  return { exists: !!paper, paper, doi };
}

// ─────────────────────────────────────────────────────────────
// High-level functions for researcher.js
// ─────────────────────────────────────────────────────────────

/**
 * Fetch papers for two domains + their intersection.
 * Called before investigateDiscovery's Claude API call.
 * Makes 3 S2 searches (cached after first run).
 */
async function fetchPapersForDomains(domainA, domainB, keywordsA, keywordsB) {
  const kA = (keywordsA || []).slice(0, 2).join(' ');
  const kB = (keywordsB || []).slice(0, 2).join(' ');

  const queryA = `${domainA} ${kA} cancer`.trim();
  const queryB = `${domainB} ${kB} cancer`.trim();
  const queryIntersection = `${domainA} ${domainB} cancer`.trim();

  // Fetch all three sequentially (rate limiter enforces 1.1s gaps)
  const papersA = await searchPapers(queryA, 5).catch(() => []);
  const papersB = await searchPapers(queryB, 5).catch(() => []);
  const papersIntersection = await searchPapers(queryIntersection, 5).catch(() => []);

  // Deduplicate by paperId
  const seen = new Set();
  const dedup = (arr) => arr.filter(p => {
    if (seen.has(p.paperId)) return false;
    seen.add(p.paperId);
    return true;
  });

  return {
    domainA_papers: dedup(papersA),
    domainB_papers: dedup(papersB),
    intersection_papers: dedup(papersIntersection),
    total_papers: seen.size,
    search_queries: [queryA, queryB, queryIntersection]
  };
}

/**
 * Verify abc_chain sources against Semantic Scholar.
 * Extracts author + year from source strings and searches S2.
 */
async function verifyAbcChainSources(abcChain) {
  if (!Array.isArray(abcChain) || abcChain.length === 0) return abcChain;

  const verified = [];
  for (const link of abcChain) {
    const result = { ...link, doi_verified: false, verified_doi: null, verified_title: null, citation_count: null, verification_method: 'unverified' };

    if (!link.source || link.source.trim() === '' || link.source === 'no supporting evidence found') {
      verified.push(result);
      continue;
    }

    try {
      // Strategy 1: Check if source contains a DOI
      const doiMatch = link.source.match(/(10\.\d{4,}\/[^\s,;]+)/);
      if (doiMatch) {
        const check = await verifyDOI(doiMatch[1]);
        if (check.exists) {
          result.doi_verified = true;
          result.verified_doi = check.doi;
          result.verified_title = check.paper.title;
          result.citation_count = check.paper.citationCount;
          result.verification_method = 'doi_match';
          verified.push(result);
          continue;
        }
      }

      // Strategy 2: Extract author + year and search
      const authorYearMatch = link.source.match(/^([A-Z][a-z]+)\s+et\s+al\.?,?\s*(?:.*?)\s+(\d{4})/);
      if (authorYearMatch) {
        const [, surname, year] = authorYearMatch;
        // Build a search query from author name + year + key words from claim
        const claimWords = (link.claim || '').split(/\s+/).filter(w => w.length > 4).slice(0, 3).join(' ');
        const searchQ = `${surname} ${year} ${claimWords}`.trim();
        const papers = await searchPapers(searchQ, 3);

        if (papers.length > 0) {
          // Find best match by checking if author surname and year match
          const match = papers.find(p =>
            p.authors.toLowerCase().includes(surname.toLowerCase()) &&
            p.year === parseInt(year)
          );
          if (match) {
            result.doi_verified = true;
            result.verified_doi = match.doi;
            result.verified_title = match.title;
            result.citation_count = match.citationCount;
            result.verification_method = 'title_search';
            verified.push(result);
            continue;
          }
        }
      }

      // Strategy 3: Search with the full source text (truncated)
      const shortSource = link.source.slice(0, 80).replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
      if (shortSource.length > 10) {
        const papers = await searchPapers(shortSource, 3);
        if (papers.length > 0) {
          const topPaper = papers[0];
          // Check if title words overlap significantly
          const sourceWords = new Set(shortSource.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          const titleWords = new Set(topPaper.title.toLowerCase().split(/\s+/).filter(w => w.length > 3));
          const overlap = [...sourceWords].filter(w => titleWords.has(w)).length;
          const similarity = sourceWords.size > 0 ? overlap / sourceWords.size : 0;

          if (similarity > 0.3) {
            result.doi_verified = true;
            result.verified_doi = topPaper.doi;
            result.verified_title = topPaper.title;
            result.citation_count = topPaper.citationCount;
            result.verification_method = 'fuzzy_search';
            verified.push(result);
            continue;
          }
        }
      }
    } catch (e) {
      console.error(`[S2] Source verification error: ${e.message}`);
    }

    // If we get here, source couldn't be verified
    verified.push(result);
  }

  return verified;
}

/**
 * Format a PaperContext into a string injectable into the Claude prompt.
 * Max ~2000 characters to avoid bloating the prompt.
 */
function formatPaperContext(ctx) {
  if (!ctx || ctx.total_papers === 0) return '';

  const lines = [];
  const formatPaper = (p) => {
    const summary = p.tldr || (p.abstract ? p.abstract.slice(0, 200) + '...' : 'No abstract');
    const doi = p.doi ? ` DOI:${p.doi}` : '';
    return `- ${p.authors}, ${p.journal || 'Unknown'} ${p.year || '?'} [${p.citationCount} citations${doi}]\n  "${summary}"`;
  };

  if (ctx.domainA_papers.length > 0) {
    lines.push(`Domain A papers (${ctx.search_queries[0]}):`);
    ctx.domainA_papers.slice(0, 3).forEach(p => lines.push(formatPaper(p)));
  }
  if (ctx.domainB_papers.length > 0) {
    lines.push(`\nDomain B papers (${ctx.search_queries[1]}):`);
    ctx.domainB_papers.slice(0, 3).forEach(p => lines.push(formatPaper(p)));
  }
  if (ctx.intersection_papers.length > 0) {
    lines.push(`\nCross-domain papers (${ctx.search_queries[2]}):`);
    ctx.intersection_papers.slice(0, 3).forEach(p => lines.push(formatPaper(p)));
  }

  const result = lines.join('\n');
  // Hard cap at 2500 chars to keep prompt cost reasonable
  return result.length > 2500 ? result.slice(0, 2500) + '\n[...truncated]' : result;
}

/**
 * Batch search: execute multiple queries sequentially, dedup results.
 * Used by sampler.js for cube population.
 */
async function searchPapersBatch(queries, limitPerQuery = 10, onProgress = null) {
  const allPapers = [];
  const seen = new Set();
  for (let i = 0; i < queries.length; i++) {
    try {
      const papers = await searchPapers(queries[i], limitPerQuery);
      for (const p of papers) {
        if (!seen.has(p.paperId)) {
          seen.add(p.paperId);
          allPapers.push(p);
        }
      }
    } catch (e) {
      console.error(`[S2] Batch query ${i} failed: ${e.message}`);
    }
    if (onProgress) onProgress(allPapers.length, queries.length * limitPerQuery);
  }
  return allPapers;
}

module.exports = {
  searchPapers,
  getPaper,
  verifyDOI,
  fetchPapersForDomains,
  verifyAbcChainSources,
  formatPaperContext,
  searchPapersBatch
};
