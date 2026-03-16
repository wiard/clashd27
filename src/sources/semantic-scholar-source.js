'use strict';

const https = require('https');
const { extractPaperSignals, normalizeText } = require('./paper-signal-extractor');
const { TOPICS } = require('../queue/topics');

const S2_API = 'https://api.semanticscholar.org/graph/v1/paper/search';
const MAX_RESULTS = 20;

const QUERIES = [
  'AI consent architecture',
  'governed AI systems',
  'AI safety verification'
];

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

/**
 * Fetch papers from Semantic Scholar for a single query.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function fetchQuery(query) {
  const params = new URLSearchParams({
    query,
    limit: String(MAX_RESULTS),
    fields: 'title,abstract,year,authors,venue,paperId'
  });
  const url = `${S2_API}?${params}`;
  const data = await httpGet(url);
  const papers = (data && data.data) || [];
  return papers.flatMap(paperToSignal);
}

/**
 * Fetch papers from Semantic Scholar and push to queue.
 * Used as fallback when arXiv returns fewer than 5 results.
 * @param {import('../queue/signal-queue').SignalQueue} queue
 * @returns {Promise<{ fetched: number, queries: number }>}
 */
async function fetchSemanticScholarPapers(queue) {
  let totalFetched = 0;
  let emittedSignals = 0;
  let queriesRun = 0;

  for (const query of QUERIES) {
    try {
      const signals = await fetchQuery(query);
      const paperIds = new Set();
      for (const signal of signals) {
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

  return { fetched: totalFetched, emittedSignals, queries: queriesRun };
}

module.exports = {
  fetchSemanticScholarPapers,
  fetchQuery,
  paperToSignal,
  QUERIES
};
