'use strict';

const { fetchQueryBundle: fetchArxivBundle } = require('./arxiv-source');
const { fetchQueryBundle: fetchSemanticScholarBundle } = require('./semantic-scholar-source');
const { fetchQueryBundle: fetchOpenAlexBundle } = require('./openalex-source');
const { fetchQueryBundle: fetchCrossrefBundle } = require('./crossref-source');
const { fetchQueryBundle: fetchPubMedBundle } = require('./pubmed-source');

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function mergePaper(existing, incoming, domainId) {
  return {
    ...(existing || {}),
    ...incoming,
    domain: incoming.domain || existing.domain || domainId || 'ai-general',
    title: incoming.title || existing.title || '',
    abstract: incoming.abstract || existing.abstract || '',
    citationCount: Math.max(Number(existing && existing.citationCount) || 0, Number(incoming && incoming.citationCount) || 0)
  };
}

async function fetchPapers({ queries, sources, limit = 100, domainId } = {}) {
  const results = [];
  const seen = new Map();
  const safeQueries = Array.isArray(queries) ? queries : [];
  const safeSources = Array.isArray(sources) ? sources : [];

  for (const source of safeSources) {
    for (const query of safeQueries) {
      const papers = await fetchFromSource(source, query, limit);
      for (const paper of papers) {
        const key = normalizeTitle(paper && paper.title);
        if (!key) continue;
        if (!seen.has(key)) {
          const normalized = mergePaper(null, paper, domainId);
          seen.set(key, normalized);
          results.push(normalized);
          continue;
        }

        const merged = mergePaper(seen.get(key), paper, domainId);
        seen.set(key, merged);
        const index = results.findIndex((entry) => normalizeTitle(entry.title) === key);
        if (index >= 0) results[index] = merged;
      }
    }
  }

  return results.filter((paper) => paper.title && paper.abstract);
}

async function fetchFromSource(source, query, limit) {
  const opts = { maxResults: limit };

  switch (source) {
    case 'arxiv':
      return (await fetchArxivBundle(query, opts)).papers;
    case 'semantic-scholar':
      return (await fetchSemanticScholarBundle(query, opts)).papers;
    case 'openalex':
      return (await fetchOpenAlexBundle(query, opts)).papers;
    case 'crossref':
      return (await fetchCrossrefBundle(query, opts)).papers;
    case 'pubmed':
      return (await fetchPubMedBundle(query, opts)).papers;
    default:
      return [];
  }
}

module.exports = {
  fetchFromSource,
  fetchPapers
};
