'use strict';

const path = require('path');

const config = require(path.join(__dirname, '..', '..', 'config', 'nightly-reader.json'));

const QUERY_GROUPS = Object.freeze(config.paperQueries || {});
const DEFAULT_QUERIES = Object.freeze(
  Object.values(QUERY_GROUPS)
    .flat()
    .map((query) => String(query || '').trim())
    .filter(Boolean)
    .filter((query, index, list) => list.indexOf(query) === index)
);

const SOURCE_LIMITS = Object.freeze(config.sourceLimits || {});

function getPaperQueries(opts = {}) {
  if (Array.isArray(opts.queries) && opts.queries.length > 0) {
    return opts.queries.map((query) => String(query || '').trim()).filter(Boolean);
  }
  return DEFAULT_QUERIES.slice();
}

function getSourceLimit(name, fallback) {
  const configured = Number(SOURCE_LIMITS[name]);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return fallback;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors.map((author) => normalizeText(author)).filter(Boolean);
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords.map((keyword) => normalizeText(keyword).toLowerCase()).filter(Boolean);
}

function createCanonicalPaper(input = {}) {
  const title = normalizeText(input.title);
  const abstract = normalizeText(input.abstract || input.summary || input.snippet);
  const paperId = normalizeText(input.paperId || input.id || input.url || title.toLowerCase());
  const source = normalizeText(input.source || input.venue || 'paper');
  const url = normalizeText(input.url || input.sourceUrl || '');
  const references = Array.isArray(input.references)
    ? input.references.map((reference) => normalizeText(reference)).filter(Boolean)
    : [];

  return {
    paperId,
    title,
    abstract,
    authors: normalizeAuthors(input.authors),
    year: Number.isFinite(Number(input.year)) ? Number(input.year) : null,
    keywords: normalizeKeywords(input.keywords),
    citationCount: Math.max(0, Number(input.citationCount) || 0),
    references,
    url,
    source,
    domain: normalizeText(input.domain || 'ai-general').toLowerCase()
  };
}

module.exports = {
  DEFAULT_QUERIES,
  QUERY_GROUPS,
  SOURCE_LIMITS,
  createCanonicalPaper,
  getPaperQueries,
  getSourceLimit
};
