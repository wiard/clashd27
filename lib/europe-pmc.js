/**
 * CLASHD-27 — Europe PMC Module
 * Searches Europe PMC REST API for papers and recognized-funded research.
 * Uses shared rate-limiter and api-cache.
 */

const { limiters } = require('./rate-limiter');
const { ApiCache } = require('./api-cache');

const EUROPEPMC_API = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const cache = new ApiCache('cache-europepmc.json', 24);

/**
 * Whitelist of recognized funding agencies, grouped by region.
 * Matched case-insensitive against grant agency strings.
 * NIH Reporter already covers NIH separately, so NIH is excluded here.
 */
const RECOGNIZED_FUNDING_AGENCIES = [
  // ── EU-niveau ──
  'european commission', 'horizon europe', 'horizon 2020', 'fp7',
  'european research council', 'erc', 'erasmus',
  'european molecular biology', 'embo', 'embl',

  // ── Grote nationale fondsen Europa ──
  'deutsche forschungsgemeinschaft', 'dfg',
  'wellcome trust', 'wellcome',
  'medical research council', 'mrc',
  'engineering and physical sciences research council', 'epsrc',
  'biotechnology and biological sciences research council', 'bbsrc',
  'uk research and innovation', 'ukri',
  'agence nationale de la recherche', 'anr',
  'netherlands organisation for scientific research', 'nwo',
  'zonmw',
  'swiss national science foundation', 'snsf',
  'fonds wetenschappelijk onderzoek', 'fwo',
  'swedish research council',
  'research council of norway',
  'academy of finland',
  'austrian science fund', 'fwf',
  'irish research council',
  'fundação para a ciência e a tecnologia', 'fct',
  'ministerio de ciencia',
  'instituto de salud carlos iii',
  'associazione italiana per la ricerca sul cancro', 'airc',

  // ── Europese ziektefondsen ──
  'cancer research uk',
  'deutsche krebshilfe',
  'ligue contre le cancer',
  'kwf kankerbestrijding', 'kwf',
  'hartstichting',

  // ── VS (niet-NIH, want NIH Reporter dekt NIH al apart) ──
  'national science foundation', 'nsf',
  'national cancer institute', 'nci',
  'department of defense', 'dod',
  'department of energy', 'doe',
  'food and drug administration', 'fda',
  'centers for disease control', 'cdc',
  'darpa',
  'american cancer society', 'acs',
  'howard hughes medical institute', 'hhmi',
  'v foundation',
  'susan g. komen',
  'leukemia & lymphoma society',
  'st. baldrick',
  "alex's lemonade stand",

  // ── Internationaal ──
  'world health organization', 'who',
  'bill & melinda gates foundation', 'gates foundation',
  'canadian institutes of health research', 'cihr',
  'natural sciences and engineering research council', 'nserc',
  'australian research council', 'arc',
  'national health and medical research council', 'nhmrc',
  'japan society for the promotion of science', 'jsps',
];

// Region classification for summary grouping
const EU_AGENCIES = new Set([
  'european commission', 'horizon europe', 'horizon 2020', 'fp7',
  'european research council', 'erc', 'erasmus',
  'european molecular biology', 'embo', 'embl',
  'deutsche forschungsgemeinschaft', 'dfg',
  'wellcome trust', 'wellcome',
  'medical research council', 'mrc',
  'engineering and physical sciences research council', 'epsrc',
  'biotechnology and biological sciences research council', 'bbsrc',
  'uk research and innovation', 'ukri',
  'agence nationale de la recherche', 'anr',
  'netherlands organisation for scientific research', 'nwo',
  'zonmw',
  'swiss national science foundation', 'snsf',
  'fonds wetenschappelijk onderzoek', 'fwo',
  'swedish research council',
  'research council of norway',
  'academy of finland',
  'austrian science fund', 'fwf',
  'irish research council',
  'fundação para a ciência e a tecnologia', 'fct',
  'ministerio de ciencia',
  'instituto de salud carlos iii',
  'associazione italiana per la ricerca sul cancro', 'airc',
  'cancer research uk',
  'deutsche krebshilfe',
  'ligue contre le cancer',
  'kwf kankerbestrijding', 'kwf',
  'hartstichting',
]);

const US_AGENCIES = new Set([
  'national science foundation', 'nsf',
  'national cancer institute', 'nci',
  'department of defense', 'dod',
  'department of energy', 'doe',
  'food and drug administration', 'fda',
  'centers for disease control', 'cdc',
  'darpa',
  'american cancer society', 'acs',
  'howard hughes medical institute', 'hhmi',
  'v foundation',
  'susan g. komen',
  'leukemia & lymphoma society',
  'st. baldrick',
  "alex's lemonade stand",
]);

/**
 * Check if a grant agency matches the recognized funding whitelist.
 * @param {string} agency
 * @returns {boolean}
 */
function isRecognizedAgency(agency) {
  if (!agency) return false;
  const lower = agency.toLowerCase().trim();
  return RECOGNIZED_FUNDING_AGENCIES.some(a => lower.includes(a));
}

/**
 * Classify a grant agency into a region.
 * @param {string} agency
 * @returns {'eu'|'us'|'international'|null}
 */
function classifyAgencyRegion(agency) {
  if (!agency) return null;
  const lower = agency.toLowerCase().trim();
  for (const a of EU_AGENCIES) {
    if (lower.includes(a)) return 'eu';
  }
  for (const a of US_AGENCIES) {
    if (lower.includes(a)) return 'us';
  }
  if (isRecognizedAgency(agency)) return 'international';
  return null;
}

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
  const grants = (raw.grantsList?.grant || []).map(g => ({
    grantId: g.grantId || '',
    agency: g.agency || '',
    acronym: g.acronym || ''
  }));

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
    grantsList: grants,
    hasRecognizedFunding: grants.some(g => isRecognizedAgency(g.agency))
  };
}

/**
 * Build a regional summary from funded papers.
 */
function buildRegionalSummary(fundedPapers) {
  const regions = { eu: new Set(), us: new Set(), international: new Set() };
  const counts = { eu: 0, us: 0, international: 0 };

  for (const p of fundedPapers) {
    const paperRegions = new Set();
    for (const g of p.grantsList) {
      const region = classifyAgencyRegion(g.agency);
      if (region) {
        regions[region].add(g.agency);
        paperRegions.add(region);
      }
    }
    for (const r of paperRegions) counts[r]++;
  }

  const parts = [];
  if (counts.eu > 0) {
    parts.push(`EU/European funding: ${counts.eu} paper(s) (${[...regions.eu].slice(0, 3).join(', ')})`);
  }
  if (counts.us > 0) {
    parts.push(`US funding (non-NIH): ${counts.us} paper(s) (${[...regions.us].slice(0, 3).join(', ')})`);
  }
  if (counts.international > 0) {
    parts.push(`International funding: ${counts.international} paper(s) (${[...regions.international].slice(0, 3).join(', ')})`);
  }

  return { parts, counts, agencies: regions };
}

/**
 * Search for recognized-funded papers related to a gap packet.
 *
 * @param {object} gapPacket - { cellLabels, hypothesis }
 * @returns {{ papers: object[], recognized_funded_count: number, recognized_funded_papers: number, total_found: number, regional_breakdown: object, summary: string }}
 */
async function enrichWithFunding(gapPacket) {
  const labels = gapPacket.cellLabels || [];
  const hypothesis = gapPacket.hypothesis || gapPacket.discovery || '';

  const query = labels.length >= 2
    ? `(${labels[0]}) AND (${labels[1]})`
    : hypothesis.split(' ').slice(0, 8).join(' ');

  if (!query || query.trim().length < 3) {
    return {
      papers: [], recognized_funded_count: 0, recognized_funded_papers: 0,
      total_found: 0, regional_breakdown: { eu: 0, us: 0, international: 0 },
      summary: 'Insufficient query terms.'
    };
  }

  const papers = await searchPapers(query, { pageSize: 50 });
  const funded = papers.filter(p => p.hasRecognizedFunding);
  const regional = buildRegionalSummary(funded);

  let summary;
  if (papers.length === 0) {
    summary = 'No papers found in Europe PMC for this domain combination.';
  } else if (funded.length > 0) {
    summary = `${papers.length} papers found, ${funded.length} with recognized funding. ${regional.parts.join('. ')}.`;
  } else {
    summary = `${papers.length} papers found, none with recognized funding.`;
  }

  return {
    papers: papers.slice(0, 20),
    recognized_funded_count: funded.length,
    recognized_funded_papers: funded.length,
    total_found: papers.length,
    regional_breakdown: regional.counts,
    summary
  };
}

// Backward-compatible alias
const enrichWithEUFunding = enrichWithFunding;

module.exports = { searchPapers, enrichWithFunding, enrichWithEUFunding, isRecognizedAgency, classifyAgencyRegion, RECOGNIZED_FUNDING_AGENCIES };
