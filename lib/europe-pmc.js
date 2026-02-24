/**
 * CLASHD-27 — Europe PMC Module
 * Searches Europe PMC REST API for papers and EU-funded research.
 * Uses shared rate-limiter and api-cache.
 */

const { limiters } = require('./rate-limiter');
const { ApiCache } = require('./api-cache');

const EUROPEPMC_API = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const cache = new ApiCache('cache-europepmc.json', 24);

/**
 * Search Europe PMC for papers matching a query.
 *
 * @param {string} query - search query
 * @param {object} options
 * @param {number} options.pageSize - results per page (default 25)
 * @param {string} options.sort - sort field (default 'RELEVANCE')
 * @param {boolean} options.openAccess - filter to open-access only
 * @returns {object[]} normalized papers
 */
async function searchPapers(query, options = {}) {
  const { pageSize = 25, sort = 'RELEVANCE', openAccess = false } = options;

  if (!query || query.trim().length < 3) return [];

  const cacheKey = `epmc-${query.toLowerCase().slice(0, 80)}-${pageSize}-${sort}-${openAccess}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  await limiters.europepmc.throttle();

  try {
    const params = new URLSearchParams({
      query: openAccess ? `${query} OPEN_ACCESS:y` : query,
      format: 'json',
      pageSize: String(pageSize),
      resultType: 'core'
    });
    // Europe PMC sort param: only add for date sorting (default is relevance)
    if (sort === 'DATE') params.set('sort', 'date desc');

    const res = await fetch(`${EUROPEPMC_API}?${params}`, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });

    if (!res.ok) {
      console.error(`[EUROPEPMC] HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const results = (data.resultList?.result || []).map(normalizePaper);
    cache.set(cacheKey, results);
    return results;
  } catch (e) {
    console.error(`[EUROPEPMC] Search failed: ${e.message}`);
    return [];
  }
}

function normalizePaper(raw) {
  return {
    id: raw.id || '',
    source: raw.source || 'MED',
    pmid: raw.pmid || null,
    pmcid: raw.pmcid || null,
    doi: raw.doi || null,
    title: (raw.title || '').slice(0, 300),
    authors: (raw.authorString || '').slice(0, 200),
    journal: raw.journalTitle || '',
    year: parseInt(raw.pubYear) || null,
    abstract: (raw.abstractText || '').slice(0, 500),
    citedByCount: raw.citedByCount || 0,
    isOpenAccess: raw.isOpenAccess === 'Y',
    grantsList: (raw.grantsList?.grant || []).map(g => ({
      grantId: g.grantId || '',
      agency: g.agency || '',
      acronym: g.acronym || ''
    })),
    hasEUFunding: (raw.grantsList?.grant || []).some(g =>
      (g.agency || '').match(/european|horizon|eu|erc|fp7|h2020/i)
    )
  };
}

/**
 * Search for EU-funded papers related to a gap packet.
 *
 * @param {object} gapPacket - { cellLabels, hypothesis }
 * @returns {{ papers: object[], eu_funded_count: number, total_found: number, summary: string }}
 */
async function enrichWithEUFunding(gapPacket) {
  const labels = gapPacket.cellLabels || [];
  const hypothesis = gapPacket.hypothesis || gapPacket.discovery || '';

  // Build search query from labels
  const query = labels.length >= 2
    ? `(${labels[0]}) AND (${labels[1]})`
    : hypothesis.split(' ').slice(0, 8).join(' ');

  if (!query || query.trim().length < 3) {
    return { papers: [], eu_funded_count: 0, total_found: 0, summary: 'Insufficient query terms.' };
  }

  const papers = await searchPapers(query, { pageSize: 50 });
  const euFunded = papers.filter(p => p.hasEUFunding);

  // TODO: Sampler integration — feed EU-funded papers back into cube sampling

  const summary = papers.length === 0
    ? 'No papers found in Europe PMC for this domain combination.'
    : euFunded.length > 0
      ? `${papers.length} papers found, ${euFunded.length} with EU funding (${euFunded.map(p => p.grantsList.map(g => g.agency).join(', ')).filter(Boolean).slice(0, 3).join('; ')}).`
      : `${papers.length} papers found, none with identified EU funding.`;

  return {
    papers: papers.slice(0, 20),
    eu_funded_count: euFunded.length,
    total_found: papers.length,
    summary
  };
}

module.exports = { searchPapers, enrichWithEUFunding };
