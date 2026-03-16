'use strict';

const https = require('https');

const { extractPaperSignals, normalizeText } = require('./paper-signal-extractor');
const { createCanonicalPaper, getPaperQueries, getSourceLimit } = require('./paper-source-config');
const { TOPICS } = require('../queue/topics');

const OPENALEX_API = 'https://api.openalex.org/works';
const MAX_RESULTS = 100;
const QUERIES = getPaperQueries();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error(`OpenAlex JSON parse error: ${error.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function scoreByOpenAlex(record) {
  const cited = Math.max(0, Number(record.cited_by_count) || 0);
  const publicationYear = Number(record.publication_year) || null;
  const currentYear = new Date().getFullYear();
  const agePenalty = publicationYear ? Math.min(0.2, Math.max(0, currentYear - publicationYear) * 0.02) : 0.08;
  const citationBoost = Math.min(0.2, Math.log10(cited + 1) * 0.09);
  return Math.max(0.35, Math.min(0.92, 0.58 + citationBoost - agePenalty));
}

function workToSignals(work) {
  const title = normalizeText(work.display_name);
  const abstract = normalizeAbstract(work);
  const keywords = Array.isArray(work.keywords)
    ? work.keywords.map((keyword) => normalizeText(keyword.display_name || keyword))
    : [];
  return extractPaperSignals({
    title,
    abstract,
    authors: Array.isArray(work.authorships)
      ? work.authorships.map((entry) => normalizeText(entry.author && entry.author.display_name))
      : [],
    year: work.publication_year || null,
    publishedAt: work.publication_date || null,
    citationCount: work.cited_by_count || 0,
    referenceCount: Array.isArray(work.referenced_works) ? work.referenced_works.length : 0,
    paperId: normalizeText(work.id || title),
    sourceUrl: normalizeText(work.id || ''),
    venue: normalizeText(work.primary_location && work.primary_location.source && work.primary_location.source.display_name) || 'OpenAlex',
    keywords,
    score: scoreByOpenAlex(work),
    domain: inferDomain(work, keywords)
  }, {
    sourceName: 'OpenAlex'
  });
}

function workToPaper(work) {
  const keywords = Array.isArray(work.keywords)
    ? work.keywords.map((keyword) => normalizeText(keyword.display_name || keyword))
    : [];
  return createCanonicalPaper({
    paperId: normalizeText(work.id || work.doi || work.display_name),
    title: normalizeText(work.display_name),
    abstract: normalizeAbstract(work),
    authors: Array.isArray(work.authorships)
      ? work.authorships.map((entry) => normalizeText(entry.author && entry.author.display_name))
      : [],
    year: work.publication_year || null,
    keywords,
    citationCount: work.cited_by_count || 0,
    references: Array.isArray(work.referenced_works) ? work.referenced_works : [],
    url: normalizeText(work.id || ''),
    source: 'OpenAlex',
    domain: inferDomain(work, keywords)
  });
}

function normalizeAbstract(work) {
  if (typeof work.abstract === 'string') {
    return normalizeText(work.abstract);
  }
  const inverted = work.abstract_inverted_index;
  if (!inverted || typeof inverted !== 'object') {
    return '';
  }
  const words = [];
  for (const [token, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      words[position] = token;
    }
  }
  return normalizeText(words.join(' '));
}

function inferDomain(work, keywords) {
  const concept = Array.isArray(work.concepts) ? work.concepts[0] : null;
  const label = normalizeText(concept && concept.display_name).toLowerCase();
  const joined = keywords.join(' ').toLowerCase();
  if (label.includes('security') || joined.includes('security')) return 'cybersecurity';
  if (label.includes('software') || joined.includes('architecture')) return 'software-architecture';
  if (label.includes('distributed') || joined.includes('distributed')) return 'distributed-systems';
  if (label.includes('agent') || joined.includes('multi-agent')) return 'multi-agent-systems';
  return 'ai-governance';
}

async function fetchQuery(query, opts = {}) {
  const bundle = await fetchQueryBundle(query, opts);
  return bundle.signals;
}

async function fetchQueryBundle(query, opts = {}) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(Number.isFinite(opts.maxResults) ? opts.maxResults : getSourceLimit('openAlex', MAX_RESULTS)),
    sort: 'cited_by_count:desc'
  });
  const data = await httpGet(`${OPENALEX_API}?${params.toString()}`);
  const works = Array.isArray(data && data.results) ? data.results : [];
  return {
    papers: works.map(workToPaper).filter((paper) => paper.title && paper.abstract),
    signals: works.flatMap(workToSignals)
  };
}

async function fetchOpenAlexPapers(queue, opts = {}) {
  let fetched = 0;
  let emittedSignals = 0;
  let queries = 0;
  const papersById = new Map();

  for (const query of getPaperQueries(opts)) {
    try {
      const bundle = await fetchQueryBundle(query, opts);
      const paperIds = new Set();
      for (const paper of bundle.papers) {
        if (paper.paperId && !papersById.has(paper.paperId)) {
          papersById.set(paper.paperId, paper);
        }
      }
      for (const signal of bundle.signals) {
        queue.produce(TOPICS.RAW_SIGNALS, signal);
        emittedSignals += 1;
        paperIds.add(signal.paperId);
      }
      fetched += paperIds.size;
      queries += 1;
    } catch (error) {
      console.error(`[openalex-source] query "${query}" failed: ${error.message}`);
    }
  }

  return {
    fetched,
    emittedSignals,
    queries,
    papers: Array.from(papersById.values())
  };
}

module.exports = {
  fetchOpenAlexPapers,
  fetchQuery,
  fetchQueryBundle,
  workToPaper,
  workToSignals
};
