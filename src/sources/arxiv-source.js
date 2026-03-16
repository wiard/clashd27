'use strict';

const https = require('https');
const { parseStringPromise } = require('xml2js');
const { extractPaperSignals, normalizeText } = require('./paper-signal-extractor');
const { TOPICS } = require('../queue/topics');

const ARXIV_API = 'https://export.arxiv.org/api/query';
const MAX_RESULTS = 20;

const QUERIES = [
  'AI governance consent',
  'AI agent safety',
  'multi-agent systems security',
  'large language model alignment',
  'autonomous AI oversight'
];

const CATEGORY_MAP = {
  'cs.AI': 'ai-research',
  'cs.CR': 'ai-security',
  'cs.MA': 'ai-multiagent'
};

function mapDomain(categories) {
  if (!Array.isArray(categories)) return 'ai-general';
  for (const cat of categories) {
    const term = typeof cat === 'object' ? (cat.$ && cat.$.term) : String(cat);
    if (CATEGORY_MAP[term]) return CATEGORY_MAP[term];
  }
  return 'ai-general';
}

function scoreByRecency(publishedIso) {
  const now = Date.now();
  const pubMs = new Date(publishedIso).getTime();
  const daysDiff = (now - pubMs) / (1000 * 60 * 60 * 24);
  if (daysDiff <= 7) return 0.85;
  if (daysDiff <= 30) return 0.70;
  return 0.55;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function entryToSignal(entry) {
  const title = Array.isArray(entry.title) ? entry.title[0] : String(entry.title || '');
  const summary = Array.isArray(entry.summary) ? entry.summary[0] : String(entry.summary || '');
  const published = Array.isArray(entry.published) ? entry.published[0] : String(entry.published || '');
  const id = Array.isArray(entry.id) ? entry.id[0] : String(entry.id || '');
  const categories = entry['arxiv:primary_category']
    ? [entry['arxiv:primary_category'][0]]
    : (entry.category || []);
  const authors = (entry.author || []).map(a => {
    if (typeof a === 'string') return a;
    return Array.isArray(a.name) ? a.name[0] : String(a.name || '');
  });

  const signals = extractPaperSignals({
    title,
    abstract: summary,
    authors,
    publishedAt: published,
    paperId: `arxiv:${id.replace(/[^a-zA-Z0-9.]/g, '_')}`,
    sourceUrl: id,
    venue: 'arXiv',
    keywords: ['gap', ...normalizeText(title).toLowerCase().split(/\s+/).slice(0, 5)],
    score: scoreByRecency(published),
    domain: mapDomain(categories)
  }, {
    sourceName: 'arXiv'
  });
  return signals;
}

/**
 * Fetch recent papers from arXiv for a single query.
 * @param {string} query
 * @returns {Promise<object[]>} canonical signal objects
 */
async function fetchQuery(query) {
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(MAX_RESULTS),
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  const url = `${ARXIV_API}?${params}`;
  const xml = await httpGet(url);
  const parsed = await parseStringPromise(xml, { explicitArray: true });
  const feed = parsed.feed || {};
  const entries = feed.entry || [];
  return entries.flatMap(entryToSignal);
}

/**
 * Fetch papers from all configured arXiv queries and push to queue.
 * @param {import('../queue/signal-queue').SignalQueue} queue
 * @returns {Promise<{ fetched: number, queries: number }>}
 */
async function fetchArxivPapers(queue) {
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
      console.error(`[arxiv-source] query "${query}" failed: ${err.message}`);
    }
  }

  return { fetched: totalFetched, emittedSignals, queries: queriesRun };
}

module.exports = {
  fetchArxivPapers,
  fetchQuery,
  entryToSignal,
  mapDomain,
  scoreByRecency,
  QUERIES,
  CATEGORY_MAP
};
