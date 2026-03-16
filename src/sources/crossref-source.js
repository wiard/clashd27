'use strict';

const https = require('https');

const { extractPaperSignals, normalizeText } = require('./paper-signal-extractor');
const { TOPICS } = require('../queue/topics');

const CROSSREF_API = 'https://api.crossref.org/works';
const MAX_RESULTS = 50;
const QUERIES = [
  'AI governance',
  'AI safety',
  'cybersecurity architecture',
  'complex systems',
  'multi-agent systems'
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000, headers: { 'User-Agent': 'clashd27-ingestion/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error(`Crossref JSON parse error: ${error.message}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function messageItemToSignals(item) {
  const title = Array.isArray(item.title) ? normalizeText(item.title[0]) : normalizeText(item.title);
  const abstract = stripTags(Array.isArray(item.abstract) ? item.abstract[0] : item.abstract);
  const keywords = Array.isArray(item.subject) ? item.subject.map((subject) => normalizeText(subject)) : [];
  const published = Array.isArray(item['published-print'] && item['published-print']['date-parts'])
    ? item['published-print']['date-parts'][0]
    : Array.isArray(item.created && item.created['date-parts'])
      ? item.created['date-parts'][0]
      : null;
  const publishedAt = Array.isArray(published) && published.length >= 1
    ? new Date(Date.UTC(published[0], Math.max(0, (published[1] || 1) - 1), published[2] || 1)).toISOString()
    : new Date().toISOString();

  return extractPaperSignals({
    title,
    abstract,
    authors: Array.isArray(item.author)
      ? item.author.map((author) => `${normalizeText(author.given)} ${normalizeText(author.family)}`.trim())
      : [],
    year: Number.isFinite(Number(item.issued && item.issued['date-parts'] && item.issued['date-parts'][0] && item.issued['date-parts'][0][0]))
      ? Number(item.issued['date-parts'][0][0])
      : null,
    publishedAt,
    citationCount: Number(item['is-referenced-by-count']) || 0,
    referenceCount: Number(item.reference && item.reference.length) || 0,
    paperId: normalizeText(item.DOI || item.URL || title),
    sourceUrl: normalizeText(item.URL || ''),
    venue: normalizeText(Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']) || 'Crossref',
    keywords,
    score: scoreByCrossref(item),
    domain: inferDomain(keywords, title)
  }, {
    sourceName: 'Crossref'
  });
}

function stripTags(value) {
  return normalizeText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function scoreByCrossref(item) {
  const cited = Math.max(0, Number(item['is-referenced-by-count']) || 0);
  return Math.max(0.35, Math.min(0.88, 0.56 + Math.min(0.18, Math.log10(cited + 1) * 0.08)));
}

function inferDomain(keywords, title) {
  const joined = `${keywords.join(' ')} ${title}`.toLowerCase();
  if (joined.includes('cyber')) return 'cybersecurity';
  if (joined.includes('architecture')) return 'software-architecture';
  if (joined.includes('distributed')) return 'distributed-systems';
  if (joined.includes('agent')) return 'multi-agent-systems';
  return 'ai-governance';
}

async function fetchQuery(query, opts = {}) {
  const params = new URLSearchParams({
    query,
    rows: String(Number.isFinite(opts.maxResults) ? opts.maxResults : MAX_RESULTS),
    sort: 'is-referenced-by-count',
    order: 'desc'
  });
  const data = await httpGet(`${CROSSREF_API}?${params.toString()}`);
  const items = Array.isArray(data && data.message && data.message.items) ? data.message.items : [];
  return items.flatMap(messageItemToSignals);
}

async function fetchCrossrefPapers(queue, opts = {}) {
  let fetched = 0;
  let emittedSignals = 0;
  let queries = 0;

  for (const query of (opts.queries || QUERIES)) {
    try {
      const signals = await fetchQuery(query, opts);
      const paperIds = new Set();
      for (const signal of signals) {
        queue.produce(TOPICS.RAW_SIGNALS, signal);
        emittedSignals += 1;
        paperIds.add(signal.paperId);
      }
      fetched += paperIds.size;
      queries += 1;
    } catch (error) {
      console.error(`[crossref-source] query "${query}" failed: ${error.message}`);
    }
  }

  return { fetched, emittedSignals, queries };
}

module.exports = {
  fetchCrossrefPapers,
  fetchQuery,
  messageItemToSignals
};
