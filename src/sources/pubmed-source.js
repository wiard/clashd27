'use strict';

const https = require('https');
const { parseStringPromise } = require('xml2js');

const { extractPaperSignals, normalizeText } = require('./paper-signal-extractor');
const { createCanonicalPaper, getPaperQueries, getSourceLimit } = require('./paper-source-config');
const { TOPICS } = require('../queue/topics');

const PUBMED_SEARCH_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH_API = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const PUBMED_DELAY_MS = 340;
const MAX_RESULTS = 50;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000, headers: { 'User-Agent': 'clashd27-pubmed/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function searchPubMed(query, opts = {}) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(Number.isFinite(opts.maxResults) ? opts.maxResults : getSourceLimit('pubmed', MAX_RESULTS)),
    retmode: 'json',
    sort: 'pub date'
  });
  const text = await httpGetText(`${PUBMED_SEARCH_API}?${params.toString()}`);
  const json = JSON.parse(text);
  await sleep(PUBMED_DELAY_MS);
  return Array.isArray(json && json.esearchresult && json.esearchresult.idlist)
    ? json.esearchresult.idlist
    : [];
}

async function fetchPubMedXml(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const params = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'xml'
  });
  const xml = await httpGetText(`${PUBMED_FETCH_API}?${params.toString()}`);
  await sleep(PUBMED_DELAY_MS);
  return parseStringPromise(xml, { explicitArray: true });
}

function scoreByRecency(year) {
  const currentYear = new Date().getUTCFullYear();
  const parsedYear = Number(year) || currentYear;
  const age = Math.max(0, currentYear - parsedYear);
  if (age <= 1) return 0.84;
  if (age <= 3) return 0.72;
  if (age <= 5) return 0.62;
  return 0.54;
}

function textArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return normalizeText(item);
      if (item && typeof item === 'object' && typeof item._ === 'string') return normalizeText(item._);
      return '';
    }).filter(Boolean);
  }
  return [];
}

function deriveDomain(meshTerms, fallback = 'healthcare-ai') {
  const joined = (meshTerms || []).join(' ').toLowerCase();
  if (joined.includes('diagnostic') || joined.includes('clinical') || joined.includes('radiology') || joined.includes('patient')) {
    return 'healthcare-ai';
  }
  return fallback;
}

function extractAbstract(article) {
  const abstractText = article && article.MedlineCitation && article.MedlineCitation[0]
    && article.MedlineCitation[0].Article && article.MedlineCitation[0].Article[0]
    && article.MedlineCitation[0].Article[0].Abstract && article.MedlineCitation[0].Article[0].Abstract[0]
    && article.MedlineCitation[0].Article[0].Abstract[0].AbstractText;

  if (!Array.isArray(abstractText)) return '';
  return normalizeText(abstractText.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry._ === 'string') return entry._;
    return '';
  }).join(' '));
}

function articleToPaper(article, fallbackDomain = 'healthcare-ai') {
  const citation = article && article.MedlineCitation && article.MedlineCitation[0];
  const articleNode = citation && citation.Article && citation.Article[0];
  const pmid = citation && citation.PMID && citation.PMID[0];
  const title = normalizeText(articleNode && articleNode.ArticleTitle && articleNode.ArticleTitle[0]);
  const abstract = extractAbstract(article);
  const authors = Array.isArray(articleNode && articleNode.AuthorList && articleNode.AuthorList[0] && articleNode.AuthorList[0].Author)
    ? articleNode.AuthorList[0].Author.map((author) => {
      const fore = normalizeText(author.ForeName && author.ForeName[0]);
      const last = normalizeText(author.LastName && author.LastName[0]);
      return normalizeText(`${fore} ${last}`);
    }).filter(Boolean)
    : [];
  const journal = normalizeText(articleNode && articleNode.Journal && articleNode.Journal[0]
    && articleNode.Journal[0].Title && articleNode.Journal[0].Title[0]) || 'PubMed';
  const year = Number(
    articleNode && articleNode.Journal && articleNode.Journal[0]
      && articleNode.Journal[0].JournalIssue && articleNode.Journal[0].JournalIssue[0]
      && articleNode.Journal[0].JournalIssue[0].PubDate && articleNode.Journal[0].JournalIssue[0].PubDate[0]
      && articleNode.Journal[0].JournalIssue[0].PubDate[0].Year && articleNode.Journal[0].JournalIssue[0].PubDate[0].Year[0]
  ) || null;
  const meshTerms = textArray(citation && citation.MeshHeadingList && citation.MeshHeadingList[0]
    && citation.MeshHeadingList[0].MeshHeading
      ? citation.MeshHeadingList[0].MeshHeading.flatMap((heading) => textArray(heading.DescriptorName))
      : []);

  return createCanonicalPaper({
    paperId: `pubmed:${normalizeText(pmid)}`,
    title,
    abstract,
    authors,
    year,
    keywords: meshTerms,
    citationCount: 0,
    references: [],
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '',
    source: 'PubMed',
    domain: deriveDomain(meshTerms, fallbackDomain)
  });
}

function paperToSignals(paper) {
  return extractPaperSignals({
    ...paper,
    score: scoreByRecency(paper.year)
  }, {
    sourceName: 'PubMed',
    domain: paper.domain || 'healthcare-ai'
  });
}

async function fetchQueryBundle(query, opts = {}) {
  const ids = await searchPubMed(query, opts);
  if (ids.length === 0) {
    return { papers: [], signals: [] };
  }

  const parsed = await fetchPubMedXml(ids);
  const articles = parsed && parsed.PubmedArticleSet && parsed.PubmedArticleSet.PubmedArticle
    ? parsed.PubmedArticleSet.PubmedArticle
    : [];

  const papers = articles
    .map((article) => articleToPaper(article, opts.domain || 'healthcare-ai'))
    .filter((paper) => paper.title && paper.abstract);
  const signals = papers.flatMap(paperToSignals);

  return { papers, signals };
}

async function fetchQuery(query, opts = {}) {
  const bundle = await fetchQueryBundle(query, opts);
  return bundle.signals;
}

async function fetchPubMedPapers(queue, opts = {}) {
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
      console.error(`[pubmed-source] query "${query}" failed: ${error.message}`);
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
  articleToPaper,
  fetchPubMedPapers,
  fetchQuery,
  fetchQueryBundle,
  scoreByRecency,
  searchPubMed
};
