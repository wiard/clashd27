'use strict';

const { schedule } = require('./rate-limiter');

const S2_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';
const OPENALEX_URL = 'https://api.openalex.org/works';
const PUBMED_SEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_SUMMARY_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function parseJSONResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(text || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

async function withRetry(fn, retries = 3, backoffMs = 2000) {
  for (let index = 0; index < retries; index += 1) {
    try {
      return await fn();
    } catch (err) {
      const isLast = index === retries - 1;
      if (err && err.status === 429) {
        console.warn('[paper-fetcher] rate limited, wacht 60s');
        if (isLast) throw err;
        await sleep(60000);
        continue;
      }
      if (isLast) throw err;
      await sleep(backoffMs * Math.pow(2, index));
    }
  }
  throw new Error('Retry loop exited unexpectedly');
}

function semanticScholarFields() {
  return [
    'title',
    'abstract',
    'authors',
    'year',
    'externalIds',
    'url',
    'citationCount',
    'openAccessPdf'
  ].join(',');
}

function normalizeSemanticScholarPaper(paper) {
  const doi = paper?.externalIds?.DOI || null;
  const url = paper?.url || paper?.openAccessPdf?.url || (doi ? `https://doi.org/${doi}` : '');
  return {
    id: paper?.paperId || doi || normalizeText(paper?.title),
    title: normalizeText(paper?.title),
    abstract: normalizeText(paper?.abstract),
    authors: Array.isArray(paper?.authors) ? paper.authors.map((author) => normalizeText(author?.name)).filter(Boolean) : [],
    year: Number(paper?.year) || null,
    doi,
    url,
    source: 'semantic-scholar',
    citationCount: Number(paper?.citationCount) || 0
  };
}

async function fetchSemanticScholar(keywords, limit, minYear) {
  const query = keywords.join(' ');
  const params = new URLSearchParams({
    query,
    fields: semanticScholarFields(),
    limit: String(limit),
    year: `${minYear}-`
  });

  const data = await withRetry(() => schedule('semantic-scholar', async () => {
    const response = await fetch(`${S2_URL}?${params.toString()}`, {
      headers: { 'User-Agent': 'CLASHD27/1.0' }
    });
    return parseJSONResponse(response);
  }), 3, 2000);

  return uniqueBy((data?.data || []).map(normalizeSemanticScholarPaper), (paper) => paper.id)
    .filter((paper) => paper.title && paper.abstract);
}

function normalizeOpenAlexPaper(paper) {
  const doi = typeof paper?.doi === 'string' ? paper.doi.replace(/^https?:\/\/doi\.org\//i, '') : null;
  const abstract = paper?.abstract_inverted_index
    ? Object.entries(paper.abstract_inverted_index)
      .flatMap(([word, positions]) => (positions || []).map((position) => [position, word]))
      .sort((left, right) => left[0] - right[0])
      .map((entry) => entry[1])
      .join(' ')
    : '';
  return {
    id: paper?.id || doi || normalizeText(paper?.display_name),
    title: normalizeText(paper?.display_name),
    abstract: normalizeText(abstract),
    authors: Array.isArray(paper?.authorships) ? paper.authorships.map((entry) => normalizeText(entry?.author?.display_name)).filter(Boolean) : [],
    year: Number(paper?.publication_year) || null,
    doi,
    url: paper?.primary_location?.landing_page_url || paper?.id || (doi ? `https://doi.org/${doi}` : ''),
    source: 'openalex',
    citationCount: Number(paper?.cited_by_count) || 0
  };
}

async function fetchOpenAlex(keywords, limit, minYear) {
  const search = keywords.join(' ');
  const params = new URLSearchParams({
    search,
    filter: `from_publication_date:${minYear}-01-01`,
    per_page: String(limit),
    mailto: process.env.OPENALEX_CONTACT || 'operator@clashd27.local'
  });

  const data = await withRetry(() => schedule('openalex', async () => {
    const response = await fetch(`${OPENALEX_URL}?${params.toString()}`, {
      headers: { 'User-Agent': 'CLASHD27/1.0' }
    });
    return parseJSONResponse(response);
  }), 3, 1000);

  return uniqueBy((data?.results || []).map(normalizeOpenAlexPaper), (paper) => paper.id)
    .filter((paper) => paper.title && paper.abstract);
}

function normalizePubMedSummary(summary) {
  const articleIds = Array.isArray(summary?.articleids) ? summary.articleids : [];
  const doi = articleIds.find((entry) => entry?.idtype === 'doi')?.value || null;
  const url = doi
    ? `https://doi.org/${doi}`
    : (summary?.uid ? `https://pubmed.ncbi.nlm.nih.gov/${summary.uid}/` : '');
  return {
    id: summary?.uid || doi || normalizeText(summary?.title),
    title: normalizeText(summary?.title),
    abstract: '',
    authors: Array.isArray(summary?.authors) ? summary.authors.map((author) => normalizeText(author?.name)).filter(Boolean) : [],
    year: Number(String(summary?.pubdate || '').slice(0, 4)) || null,
    doi,
    url,
    source: 'pubmed',
    citationCount: null
  };
}

async function fetchPubMed(keywords, limit, minYear) {
  const query = `${keywords.join(' ')} AND ${minYear}:3000[pdat]`;
  const searchParams = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(limit),
    retmode: 'json'
  });

  const searchData = await withRetry(() => schedule('pubmed', async () => {
    const response = await fetch(`${PUBMED_SEARCH_URL}?${searchParams.toString()}`, {
      headers: { 'User-Agent': 'CLASHD27/1.0' }
    });
    return parseJSONResponse(response);
  }), 2, 1000);

  const ids = searchData?.esearchresult?.idlist || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const summaryParams = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json'
  });

  const summaryData = await withRetry(() => schedule('pubmed', async () => {
    const response = await fetch(`${PUBMED_SUMMARY_URL}?${summaryParams.toString()}`, {
      headers: { 'User-Agent': 'CLASHD27/1.0' }
    });
    return parseJSONResponse(response);
  }), 2, 1000);

  return uniqueBy(
    (summaryData?.result?.uids || []).map((uid) => normalizePubMedSummary(summaryData.result[uid])),
    (paper) => paper.id
  ).filter((paper) => paper.title);
}

async function fetchFromSource(source, keywords, limit, minYear = 2020) {
  switch (source) {
    case 'semantic-scholar':
      return fetchSemanticScholar(keywords, limit, minYear);
    case 'openalex':
      return fetchOpenAlex(keywords, limit, minYear);
    case 'pubmed':
      return fetchPubMed(keywords, limit, minYear);
    default:
      return [];
  }
}

async function fetchPapers(keywords, options = {}) {
  const {
    limit = 20,
    minYear = 2020
  } = options;
  const normalizedKeywords = Array.from(new Set((keywords || []).map((keyword) => normalizeText(keyword)).filter(Boolean)));
  if (normalizedKeywords.length === 0) {
    return { papers: [], source: null };
  }

  for (const source of ['semantic-scholar', 'openalex', 'pubmed']) {
    try {
      const papers = await fetchFromSource(source, normalizedKeywords, limit, minYear);
      const filtered = papers
        .filter((paper) => (Number(paper.year) || 0) >= minYear)
        .filter((paper) => paper.title);
      if (filtered.length >= 3) {
        console.log(`[paper-fetcher] ${source}: ${filtered.length} papers`);
        return { papers: filtered, source };
      }
    } catch (err) {
      console.warn(`[paper-fetcher] ${source} failed: ${err.message}`);
      await sleep(2000);
      continue;
    }
  }

  throw new Error('Alle paper bronnen onbereikbaar');
}

module.exports = {
  fetchPapers,
  fetchFromSource,
  fetchSemanticScholar,
  fetchOpenAlex,
  fetchPubMed,
  withRetry
};
