'use strict';

const METHOD_KEYWORDS = [
  'method',
  'approach',
  'framework',
  'architecture',
  'pipeline',
  'algorithm',
  'protocol'
];

const RESULT_KEYWORDS = [
  'result',
  'results',
  'outperform',
  'improve',
  'accuracy',
  'benchmark',
  'evaluation',
  'experiment'
];

const LIMITATION_KEYWORDS = [
  'limitation',
  'limitations',
  'open problem',
  'future work',
  'challenge',
  'risk',
  'weakness',
  'constraint'
];

const SIGNAL_TYPE_WEIGHTS = Object.freeze({
  'paper-theory': 1.5,
  'paper-method': 1.45,
  'paper-result': 1.4,
  'paper-limitation': 1.35,
  'github-repo': 1.2,
  'internal-system': 0.7
});

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKeywords(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    const normalized = normalizeText(item).toLowerCase();
    if (!normalized) continue;
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function hasUsableAbstract(value) {
  return normalizeText(value).length >= 40;
}

function inferSignalKinds(abstract, explicitKinds) {
  const kinds = Array.isArray(explicitKinds) && explicitKinds.length > 0
    ? explicitKinds.slice()
    : ['paper-theory'];
  const normalized = abstract.toLowerCase();

  if (!kinds.includes('paper-method') && METHOD_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    kinds.push('paper-method');
  }
  if (!kinds.includes('paper-result') && RESULT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    kinds.push('paper-result');
  }
  if (!kinds.includes('paper-limitation') && LIMITATION_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    kinds.push('paper-limitation');
  }

  return kinds;
}

function typeLabel(type) {
  return String(type || '').replace(/-/g, ' ');
}

function computeScore(input) {
  const base = clamp(Number(input.baseScore) || 0.5, 0, 1);
  const citationCount = Math.max(0, Number(input.citationCount) || 0);
  const citationBoost = Math.min(0.12, Math.log10(citationCount + 1) * 0.05);
  const significanceBoost = clamp(Number(input.significanceBoost) || 0, 0, 0.1);
  return clamp(base + citationBoost + significanceBoost, 0, 1);
}

function extractPaperSignals(paper, opts = {}) {
  const title = normalizeText(paper.title);
  const content = normalizeText(paper.abstract || paper.summary || paper.snippet);
  if (!title || !hasUsableAbstract(content)) {
    return [];
  }

  const authors = Array.isArray(paper.authors) ? paper.authors.map((author) => normalizeText(author)).filter(Boolean) : [];
  const keywords = normalizeKeywords(paper.keywords);
  const sourceName = normalizeText(opts.sourceName || paper.venue || paper.source || 'paper');
  const sourceUrl = normalizeText(paper.sourceUrl || paper.url);
  const paperId = normalizeText(paper.paperId || paper.id || sourceUrl || title.toLowerCase());
  const domain = normalizeText(opts.domain || paper.domain || 'ai-general').toLowerCase();
  const explicitTimestamp = normalizeText(paper.timestamp);
  const publishedAtIso = normalizeText(paper.publishedAt);
  const yearIso = Number.isFinite(Number(paper.year)) ? new Date(`${paper.year}-01-01`).toISOString() : '';
  const timestamp = explicitTimestamp || publishedAtIso || yearIso || new Date().toISOString();
  const signalKinds = inferSignalKinds(content, opts.signalKinds);
  const baseScore = computeScore({
    baseScore: opts.baseScore ?? paper.score,
    citationCount: paper.citationCount,
    significanceBoost: opts.significanceBoost
  });

  return signalKinds.map((type, index) => ({
    type,
    domain,
    title,
    content,
    score: clamp(baseScore - (index * 0.03), 0, 1),
    source: typeLabel(type),
    sourceWeight: SIGNAL_TYPE_WEIGHTS[type] ?? 1,
    timestamp,
    sourceUrl,
    authors,
    venue: sourceName,
    keywords,
    paperId,
    citationCount: Math.max(0, Number(paper.citationCount) || 0),
    referenceCount: Math.max(0, Number(paper.referenceCount) || 0),
    year: Number.isFinite(Number(paper.year)) ? Number(paper.year) : null,
    id: `${sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${paperId}:${type}`,
    paperSource: sourceName
  }));
}

module.exports = {
  SIGNAL_TYPE_WEIGHTS,
  extractPaperSignals,
  hasUsableAbstract,
  normalizeKeywords,
  normalizeText
};
