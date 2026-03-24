'use strict';

const https = require('https');
const { extractPaperSignals, normalizeText } = require('./paper-signal-extractor');
const { createCanonicalPaper, getPaperQueries, getSourceLimit } = require('./paper-source-config');
const { TOPICS } = require('../queue/topics');

const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
const MAX_RESULTS = 50;

const QUERIES = getPaperQueries();

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`S2 JSON parse error: ${e.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function scoreByYear(year) {
  if (!year) return 0.55;
  const currentYear = new Date().getFullYear();
  const diff = currentYear - year;
  if (diff <= 0) return 0.85;
  if (diff <= 1) return 0.70;
  return 0.55;
}

function paperToSignal(paper) {
  const title = paper.title || '';
  const abstract = paper.abstract || paper.snippet || '';
  const year = paper.year || null;
  const paperId = paper.paperId || '';
  const authors = (paper.authors || []).map(a => a.name || '');

  return extractPaperSignals({
    title,
    abstract,
    year,
    publishedAt: year ? new Date(`${year}-01-01`).toISOString() : new Date().toISOString(),
    paperId: `s2:${paperId}`,
    sourceUrl: `https://api.semanticscholar.org/graph/v1/paper/${paperId}`,
    authors,
    venue: paper.venue || 'Semantic Scholar',
    keywords: ['gap', ...normalizeText(title).toLowerCase().split(/\s+/).slice(0, 5)],
    score: scoreByYear(year),
    domain: 'ai-general',
    citationCount: paper.citationCount || 0
  }, {
    sourceName: 'Semantic Scholar'
  });
}

function paperToRecord(paper) {
  const title = paper.title || '';
  const abstract = paper.abstract || paper.snippet || '';
  const year = paper.year || null;
  const paperId = paper.paperId || '';
  const authors = (paper.authors || []).map((author) => author.name || '');

  return createCanonicalPaper({
    paperId: `s2:${paperId}`,
    title,
    abstract,
    authors,
    year,
    keywords: normalizeText(title).toLowerCase().split(/\s+/).slice(0, 8),
    citationCount: paper.citationCount || 0,
    references: Array.isArray(paper.references) ? paper.references.map((reference) => reference.paperId || reference.title || '') : [],
    url: paper.url || `https://www.semanticscholar.org/paper/${paperId}`,
    source: 'Semantic Scholar',
    domain: 'ai-general'
  });
}

async function fetchQueryBundle(query, opts = {}) {
  const params = new URLSearchParams({
    query,
    limit: String(Number.isFinite(opts.maxResults) ? opts.maxResults : getSourceLimit('semanticScholar', MAX_RESULTS)),
    fields: 'title,abstract,year,authors,venue,paperId,citationCount,references,url'
  });
  const url = `${S2_API}?${params}`;
  const data = await httpGet(url);
  const papers = (data && data.data) || [];
  return {
    papers: papers.map(paperToRecord).filter((paper) => paper.title && paper.abstract),
    signals: papers.flatMap(paperToSignal)
  };
}

/**
 * Fetch papers from Semantic Scholar for a single query.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function fetchQuery(query) {
  const bundle = await fetchQueryBundle(query);
  return bundle.signals;
}

/**
 * Fetch papers from Semantic Scholar and push to queue.
 * Used as fallback when arXiv returns fewer than 5 results.
 * @param {import('../queue/signal-queue').SignalQueue} queue
 * @returns {Promise<{ fetched: number, queries: number }>}
 */
async function fetchSemanticScholarPapers(queue, opts = {}) {
  let totalFetched = 0;
  let emittedSignals = 0;
  let queriesRun = 0;
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
      totalFetched += paperIds.size;
      queriesRun += 1;
    } catch (err) {
      console.error(`[semantic-scholar-source] query "${query}" failed: ${err.message}`);
    }
  }

  return {
    fetched: totalFetched,
    emittedSignals,
    queries: queriesRun,
    papers: Array.from(papersById.values())
  };
}

module.exports = {
  fetchSemanticScholarPapers,
  fetchQuery,
  fetchQueryBundle,
  paperToSignal,
  paperToRecord,
  QUERIES
};
