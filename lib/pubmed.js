/**
 * CLASHD-27 — PubMed Module
 * Searches the NCBI PubMed E-Utilities API for papers and MeSH terms.
 * Uses shared rate-limiter and api-cache.
 */

const { limiters } = require('./rate-limiter');
const { ApiCache } = require('./api-cache');

const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const ESUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const cache = new ApiCache('cache-pubmed.json', 24);

/**
 * Search PubMed for papers matching a query.
 *
 * @param {string} query - search query
 * @param {object} options
 * @param {number} options.maxResults - max results (default 20)
 * @returns {object[]} papers with pmid, title, year, authors, mesh_terms
 */
async function searchPapers(query, options = {}) {
  const { maxResults = 20 } = options;

  if (!query || query.trim().length < 3) return [];

  const cacheKey = `pubmed-search-${query.toLowerCase().slice(0, 80)}-${maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  await limiters.pubmed.throttle();

  try {
    // Step 1: esearch to get PMIDs
    const searchParams = new URLSearchParams({
      db: 'pubmed',
      term: query,
      retmax: String(maxResults),
      retmode: 'json',
      sort: 'relevance'
    });

    const searchRes = await fetch(`${ESEARCH_URL}?${searchParams}`, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });

    if (!searchRes.ok) {
      console.error(`[PUBMED] esearch HTTP ${searchRes.status}`);
      return [];
    }

    const searchData = await searchRes.json();
    const pmids = searchData.esearchresult?.idlist || [];

    if (pmids.length === 0) return [];

    // Step 2: esummary to get paper details
    await limiters.pubmed.throttle();

    const summaryParams = new URLSearchParams({
      db: 'pubmed',
      id: pmids.join(','),
      retmode: 'json'
    });

    const summaryRes = await fetch(`${ESUMMARY_URL}?${summaryParams}`, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });

    if (!summaryRes.ok) {
      console.error(`[PUBMED] esummary HTTP ${summaryRes.status}`);
      return [];
    }

    const summaryData = await summaryRes.json();
    const result = summaryData.result || {};

    const papers = pmids.map(pmid => {
      const doc = result[pmid];
      if (!doc) return null;

      const authors = (doc.authors || []).map(a => a.name);
      const authorsShort = authors.length > 3
        ? `${authors[0]} et al.`
        : authors.join(', ');

      return {
        pmid,
        title: (doc.title || '').replace(/<[^>]*>/g, ''),
        authors: authors.slice(0, 10),
        authors_short: authorsShort,
        journal: doc.fulljournalname || doc.source || '',
        year: parseInt(doc.pubdate?.split(' ')[0]) || null,
        doi: (doc.elocationid || '').replace('doi: ', '') || null,
        pubtype: doc.pubtype || [],
        is_review: (doc.pubtype || []).some(t => t.toLowerCase().includes('review')),
      };
    }).filter(Boolean);

    cache.set(cacheKey, papers);
    return papers;
  } catch (e) {
    console.error(`[PUBMED] Search failed: ${e.message}`);
    return [];
  }
}

/**
 * Fetch MeSH terms for a list of PMIDs using efetch XML.
 *
 * @param {string[]} pmids
 * @returns {Map<string, string[]>} pmid -> mesh terms
 */
async function fetchMeshTerms(pmids) {
  if (!pmids || pmids.length === 0) return new Map();

  const cacheKey = `pubmed-mesh-${pmids.slice(0, 10).join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached) return new Map(Object.entries(cached));

  await limiters.pubmed.throttle();

  try {
    const params = new URLSearchParams({
      db: 'pubmed',
      id: pmids.join(','),
      rettype: 'xml',
      retmode: 'xml'
    });

    const res = await fetch(`${EFETCH_URL}?${params}`, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });

    if (!res.ok) return new Map();

    const xml = await res.text();
    const meshMap = new Map();

    // Simple XML parsing for MeSH headings (no dependency needed)
    const articleBlocks = xml.split('<PubmedArticle>');
    for (const block of articleBlocks) {
      const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      if (!pmidMatch) continue;
      const pmid = pmidMatch[1];

      const meshTerms = [];
      const meshMatches = block.matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g);
      for (const m of meshMatches) {
        meshTerms.push(m[1]);
      }
      meshMap.set(pmid, meshTerms);
    }

    // Cache as plain object
    const cacheObj = {};
    for (const [k, v] of meshMap) cacheObj[k] = v;
    cache.set(cacheKey, cacheObj);

    return meshMap;
  } catch (e) {
    console.error(`[PUBMED] MeSH fetch failed: ${e.message}`);
    return new Map();
  }
}

/**
 * Enrich a gap packet with PubMed references and MeSH terms.
 *
 * @param {object} gapPacket - { cellLabels, keywords, title, hypothesis }
 * @returns {object[]} enriched references with relevance notes
 */
async function enrichWithReferences(gapPacket) {
  const labels = gapPacket.cellLabels || [];
  const keywords = gapPacket.keywords || [];
  const title = gapPacket.title || gapPacket.hypothesis || gapPacket.discovery || '';

  // Build search query
  let query;
  if (keywords.length > 0) {
    // Use top keywords OR-joined
    query = keywords.slice(0, 6).join(' OR ');
  } else if (labels.length >= 2) {
    query = `(${labels[0]}) AND (${labels[1]})`;
  } else {
    query = title.split(' ').slice(0, 8).join(' ');
  }

  if (!query || query.trim().length < 3) return [];

  const papers = await searchPapers(query, { maxResults: 20 });
  if (papers.length === 0) return [];

  // Fetch MeSH terms for top papers
  const topPmids = papers.slice(0, 10).map(p => p.pmid);
  const meshMap = await fetchMeshTerms(topPmids);

  // Attach MeSH terms and compute relevance
  const labelLower = labels.map(l => l.toLowerCase());

  const enriched = papers.map(p => {
    const meshTerms = meshMap.get(p.pmid) || [];
    const titleLower = p.title.toLowerCase();

    // Simple relevance scoring
    let relevance = 'general';
    const matchesBoth = labelLower.length >= 2 &&
      labelLower.every(l => l.split(/\s+/).some(w => w.length > 3 && titleLower.includes(w)));

    if (matchesBoth) {
      relevance = 'cross-domain';
    } else if (labelLower.some(l => l.split(/\s+/).some(w => w.length > 3 && titleLower.includes(w)))) {
      relevance = 'single-domain';
    }

    return {
      ...p,
      mesh_terms: meshTerms,
      relevance,
      relevance_note: relevance === 'cross-domain'
        ? `Bridges ${labels.join(' and ')}`
        : relevance === 'single-domain'
          ? `Related to one domain`
          : 'General background'
    };
  });

  // Store MeSH terms on the gap packet for downstream use
  const allMesh = new Set();
  for (const terms of meshMap.values()) {
    for (const t of terms) allMesh.add(t);
  }
  if (allMesh.size > 0) {
    gapPacket.mesh_terms = [...allMesh];
  }

  return enriched;
}

module.exports = { searchPapers, fetchMeshTerms, enrichWithReferences };
