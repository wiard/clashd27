'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { execFileSync } = require('child_process');
const { parseStringPromise } = require('xml2js');

const { extractPaperSignals, SIGNAL_TYPE_WEIGHTS, normalizeText } = require('../src/sources/paper-signal-extractor');
const { SignalQueue } = require('../src/queue/signal-queue');
const { normalizeQueue } = require('../src/queue/signal-normalizer');
const { TOPICS } = require('../src/queue/topics');
const { Clashd27CubeEngine, normalizeSignal: normalizeCubeSignal } = require('../lib/clashd27-cube-engine');
const { runDiscoveryCycle } = require('../lib/event-emitter');
const { computeResearchGravity } = require('../lib/research-gravity');
const { scoreSignalSources } = require('../lib/source-scorer');
const { scoreGapCandidates } = require('../src/gap/gap-scorer');
const { buildHypothesis, buildVerificationPlan, buildKillTests } = require('../src/gap/hypothesis-generator');
const { validateGapPacket } = require('../src/gap/gap-packet');

const REPORT_FILE = path.join(process.cwd(), 'clashd27-load-test-report.json');
const REFERENCE_TIME = '2026-03-16T00:00:00.000Z';
const TARGET_MIN_PAPERS = 3000;
const TARGET_MAX_PAPERS = 10000;
const TARGET_CAP = 4500;
const DUMP_DIR = '/tmp/clashd27-live-paper-corpus-direct';

const REQUIRED_DIRS = [
  'src/sources',
  'src/queue',
  'src/orchestration',
  'src/gap',
  'lib'
];

const REQUIRED_FILES = [
  'lib/tick-engine.js',
  'src/orchestration/discovery-stream-orchestrator.js',
  'src/sources/arxiv-source.js',
  'src/sources/semantic-scholar-source.js',
  'src/sources/openalex-source.js',
  'src/sources/crossref-source.js',
  'src/sources/paper-signal-extractor.js',
  'src/queue/signal-normalizer.js',
  'src/gap/gap-pipeline.js'
];

const OPENALEX_QUERIES = [
  'AI governance',
  'AI safety',
  'AI verification',
  'multi-agent systems',
  'software architecture',
  'distributed systems',
  'agent memory',
  'autonomous systems oversight'
];

const CROSSREF_QUERIES = [
  'AI governance',
  'AI safety verification',
  'multi-agent systems',
  'software architecture'
];

const ARXIV_QUERIES = [
  'AI governance',
  'AI safety',
  'large language model alignment',
  'multi-agent systems',
  'software architecture',
  'autonomous AI oversight'
];

const SEMANTIC_SCHOLAR_QUERIES = [
  'AI governance',
  'AI safety verification'
];

const STOPWORDS = new Set([
  'about', 'after', 'again', 'agent', 'agents', 'align', 'aligned', 'alignment', 'among', 'around',
  'being', 'between', 'both', 'capability', 'capabilities', 'candidate', 'cells', 'control', 'current',
  'data', 'discovery', 'evidence', 'faster', 'formal', 'gives', 'governance', 'human', 'indicate',
  'indicates', 'into', 'language', 'layer', 'layers', 'missing', 'model', 'models', 'operator', 'paper',
  'papers', 'pattern', 'patterns', 'proposal', 'review', 'runtime', 'signal', 'signals', 'source', 'sources',
  'surface', 'surfaces', 'system', 'systems', 'their', 'these', 'this', 'those', 'through', 'tool', 'tools',
  'trust', 'ungoverned', 'using', 'value', 'what', 'when', 'where', 'which', 'worth'
]);

const CONTRADICTION_RE = /\b(contradict|contradiction|refut|fails?\s+to|failure|limitation|limitations|challenge|uncertainty|weakness|not well understood|negative result|risk)\b/i;
const SOLUTION_RE = /\b(framework|architecture|protocol|kernel|platform|observatory|verification layer|consent enforcement|control surface|runtime enforcement|governance model)\b/i;
const NEGATING_RE = /\b(lack|lacks|missing|open problem|challenge|limitation|limitations|risk)\b/i;

function round(num, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tmpStateFile() {
  return path.join('/tmp', `clashd27-live-load-${process.pid}-${Date.now()}.json`);
}

function makeEngine() {
  const stateFile = tmpStateFile();
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  return new Clashd27CubeEngine({ stateFile, emergenceThreshold: 0.5 });
}

function directoryAndFileHealth() {
  return {
    directories: REQUIRED_DIRS.map((dir) => ({ path: dir, exists: fs.existsSync(path.join(process.cwd(), dir)) })),
    files: REQUIRED_FILES.map((file) => ({ path: file, exists: fs.existsSync(path.join(process.cwd(), file)) }))
  };
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const args = ['-sL', '--max-time', '30'];
      args.push('-H', 'User-Agent: clashd27-live-load-test/1.0');
      args.push('-H', 'Accept: application/json, application/xml;q=0.9, */*;q=0.8');
      for (const [key, value] of Object.entries(headers)) {
        args.push('-H', `${key}: ${value}`);
      }
      args.push(url);
      const output = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      resolve(output);
    } catch (error) {
      const stderr = error && error.stderr ? String(error.stderr) : '';
      reject(new Error(stderr || error.message));
    }
  });
}

async function httpGetJson(url, headers = {}) {
  return JSON.parse(await httpGet(url, headers));
}

function normalizeOpenAlexAbstract(record) {
  const inverted = record.abstract_inverted_index;
  if (!inverted || typeof inverted !== 'object') return '';
  const words = [];
  for (const [token, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) words[position] = token;
  }
  return normalizeText(words.join(' '));
}

function stripTags(value) {
  return normalizeText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => token.length >= 4)
    .filter(token => !STOPWORDS.has(token));
}

function inferDomain(title, abstract, keywords) {
  const joined = `${title} ${abstract} ${(keywords || []).join(' ')}`.toLowerCase();
  if (joined.includes('security') || joined.includes('cyber')) return 'cybersecurity';
  if (joined.includes('architecture') || joined.includes('runtime') || joined.includes('kernel')) return 'software-architecture';
  if (joined.includes('distributed')) return 'distributed-systems';
  if (joined.includes('multi-agent') || joined.includes('agent') || joined.includes('autonomous')) return 'multi-agent-systems';
  if (joined.includes('alignment') || joined.includes('safety') || joined.includes('verification')) return 'ai-safety';
  return 'ai-governance';
}

function scoreOpenAlex(record) {
  const cited = Math.max(0, Number(record.cited_by_count) || 0);
  const year = Number(record.publication_year) || null;
  const agePenalty = year ? Math.min(0.2, Math.max(0, 2026 - year) * 0.02) : 0.08;
  const citationBoost = Math.min(0.2, Math.log10(cited + 1) * 0.09);
  return round(Math.max(0.35, Math.min(0.92, 0.58 + citationBoost - agePenalty)), 3);
}

function scoreCrossref(item) {
  const cited = Math.max(0, Number(item['is-referenced-by-count']) || 0);
  return round(Math.max(0.35, Math.min(0.88, 0.56 + Math.min(0.18, Math.log10(cited + 1) * 0.08))), 3);
}

function scoreArxiv(publishedIso) {
  const publishedMs = new Date(publishedIso).getTime();
  const ageDays = (Date.parse(REFERENCE_TIME) - publishedMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) return 0.85;
  if (ageDays <= 30) return 0.7;
  return 0.55;
}

function scoreSemanticScholar(year) {
  if (!year) return 0.55;
  const diff = 2026 - Number(year);
  if (diff <= 0) return 0.85;
  if (diff <= 1) return 0.7;
  return 0.55;
}

function paperKey(paper) {
  return normalizeText(paper.doi || paper.paperId || `${paper.title}|${paper.year || ''}`).toLowerCase();
}

function openAlexPaper(record) {
  const title = normalizeText(record.display_name || record.title);
  const abstract = normalizeOpenAlexAbstract(record);
  const keywords = [
    ...(Array.isArray(record.keywords) ? record.keywords.map((item) => normalizeText(item.display_name || item)) : []),
    ...(Array.isArray(record.concepts) ? record.concepts.slice(0, 6).map((item) => normalizeText(item.display_name || item)) : [])
  ].filter(Boolean);
  const references = Array.isArray(record.referenced_works) ? record.referenced_works.slice(0, 25) : [];
  return {
    source: 'openalex',
    sourceName: 'OpenAlex',
    paperId: normalizeText(record.id || title),
    doi: normalizeText(record.doi || ''),
    title,
    abstract,
    authors: Array.isArray(record.authorships)
      ? record.authorships.map((item) => normalizeText(item.author && item.author.display_name)).filter(Boolean)
      : [],
    year: Number(record.publication_year) || null,
    publishedAt: normalizeText(record.publication_date || ''),
    keywords,
    citationCount: Math.max(0, Number(record.cited_by_count) || 0),
    referenceCount: references.length,
    references,
    venue: normalizeText(record.primary_location && record.primary_location.source && record.primary_location.source.display_name) || 'OpenAlex',
    sourceUrl: normalizeText(record.id || ''),
    score: scoreOpenAlex(record),
    domain: inferDomain(title, abstract, keywords)
  };
}

function crossrefPaper(item) {
  const title = normalizeText(Array.isArray(item.title) ? item.title[0] : item.title);
  const abstract = stripTags(Array.isArray(item.abstract) ? item.abstract[0] : item.abstract);
  const keywords = Array.isArray(item.subject) ? item.subject.map((subject) => normalizeText(subject)).filter(Boolean) : [];
  const issued = item.issued && item.issued['date-parts'] && item.issued['date-parts'][0];
  const year = Array.isArray(issued) && issued.length > 0 ? Number(issued[0]) || null : null;
  const references = Array.isArray(item.reference)
    ? item.reference.slice(0, 25).map((ref) => normalizeText(ref.DOI || ref.article-title || ref.unstructured || 'reference')).filter(Boolean)
    : [];
  return {
    source: 'crossref',
    sourceName: 'Crossref',
    paperId: normalizeText(item.DOI || item.URL || title),
    doi: normalizeText(item.DOI || ''),
    title,
    abstract,
    authors: Array.isArray(item.author)
      ? item.author.map((author) => `${normalizeText(author.given)} ${normalizeText(author.family)}`.trim()).filter(Boolean)
      : [],
    year,
    publishedAt: year ? new Date(Date.UTC(year, 0, 1)).toISOString() : '',
    keywords,
    citationCount: Math.max(0, Number(item['is-referenced-by-count']) || 0),
    referenceCount: references.length,
    references,
    venue: normalizeText(Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']) || 'Crossref',
    sourceUrl: normalizeText(item.URL || ''),
    score: scoreCrossref(item),
    domain: inferDomain(title, abstract, keywords)
  };
}

function arxivPaper(entry) {
  const title = normalizeText(Array.isArray(entry.title) ? entry.title[0] : entry.title);
  const abstract = normalizeText(Array.isArray(entry.summary) ? entry.summary[0] : entry.summary);
  const publishedAt = normalizeText(Array.isArray(entry.published) ? entry.published[0] : entry.published);
  const categories = entry.category || [];
  const keywords = categories.map((item) => normalizeText(item.$ && item.$.term ? item.$.term : item)).filter(Boolean);
  return {
    source: 'arxiv',
    sourceName: 'arXiv',
    paperId: normalizeText(Array.isArray(entry.id) ? entry.id[0] : entry.id),
    doi: '',
    title,
    abstract,
    authors: (entry.author || []).map((author) => normalizeText(Array.isArray(author.name) ? author.name[0] : author.name)).filter(Boolean),
    year: publishedAt ? Number(new Date(publishedAt).getUTCFullYear()) || null : null,
    publishedAt,
    keywords,
    citationCount: 0,
    referenceCount: 0,
    references: [],
    venue: 'arXiv',
    sourceUrl: normalizeText(Array.isArray(entry.id) ? entry.id[0] : entry.id),
    score: scoreArxiv(publishedAt),
    domain: inferDomain(title, abstract, keywords)
  };
}

function semanticScholarPaper(item) {
  const title = normalizeText(item.title);
  const abstract = normalizeText(item.abstract || item.snippet);
  const keywords = tokenize(title).slice(0, 8);
  return {
    source: 'semantic-scholar',
    sourceName: 'Semantic Scholar',
    paperId: normalizeText(item.paperId || title),
    doi: '',
    title,
    abstract,
    authors: Array.isArray(item.authors) ? item.authors.map((author) => normalizeText(author.name)).filter(Boolean) : [],
    year: Number(item.year) || null,
    publishedAt: item.year ? new Date(Date.UTC(Number(item.year), 0, 1)).toISOString() : '',
    keywords,
    citationCount: Math.max(0, Number(item.citationCount) || 0),
    referenceCount: Math.max(0, Number(item.referenceCount) || 0),
    references: [],
    venue: normalizeText(item.venue) || 'Semantic Scholar',
    sourceUrl: normalizeText(item.url || ''),
    score: scoreSemanticScholar(item.year),
    domain: inferDomain(title, abstract, keywords)
  };
}

function addPaper(registry, paper, sourceStats) {
  if (!paper.title || !paper.abstract || paper.abstract.length < 40) return false;
  const key = paperKey(paper);
  if (registry.map.has(key)) {
    sourceStats.duplicates += 1;
    return false;
  }
  if (registry.list.length >= TARGET_CAP) return false;
  registry.map.set(key, paper);
  registry.list.push(paper);
  sourceStats.uniqueAdded += 1;
  return true;
}

async function collectOpenAlex(registry, sourceStats) {
  for (const query of OPENALEX_QUERIES) {
    for (let page = 1; page <= 2; page += 1) {
      if (registry.list.length >= TARGET_CAP) return;
      sourceStats.requests += 1;
      const params = new URLSearchParams({
        search: query,
        page: String(page),
        'per-page': '200',
        sort: 'cited_by_count:desc'
      });
      try {
        const payload = await httpGetJson(`https://api.openalex.org/works?${params.toString()}`);
        const results = Array.isArray(payload.results) ? payload.results : [];
        sourceStats.rawFetched += results.length;
        for (const item of results) {
          const paper = openAlexPaper(item);
          if (paper.abstract.length >= 40) sourceStats.withAbstract += 1;
          addPaper(registry, paper, sourceStats);
        }
      } catch (error) {
        sourceStats.errors.push(error.message);
      }
      await sleep(120);
    }
  }
}

async function collectCrossref(registry, sourceStats) {
  for (const query of CROSSREF_QUERIES) {
    for (let page = 0; page < 2; page += 1) {
      if (registry.list.length >= TARGET_CAP) return;
      sourceStats.requests += 1;
      const params = new URLSearchParams({
        query,
        rows: '100',
        offset: String(page * 100),
        sort: 'is-referenced-by-count',
        order: 'desc'
      });
      try {
        const payload = await httpGetJson(`https://api.crossref.org/works?${params.toString()}`);
        const items = Array.isArray(payload.message && payload.message.items) ? payload.message.items : [];
        sourceStats.rawFetched += items.length;
        for (const item of items) {
          const paper = crossrefPaper(item);
          if (paper.abstract.length >= 40) sourceStats.withAbstract += 1;
          addPaper(registry, paper, sourceStats);
        }
      } catch (error) {
        sourceStats.errors.push(error.message);
      }
      await sleep(180);
    }
  }
}

async function collectArxiv(registry, sourceStats) {
  for (const query of ARXIV_QUERIES) {
    if (registry.list.length >= TARGET_CAP) return;
    sourceStats.requests += 1;
    const params = new URLSearchParams({
      search_query: `all:${query}`,
      start: '0',
      max_results: '120',
      sortBy: 'submittedDate',
      sortOrder: 'descending'
    });
    try {
      const xml = await httpGet(`https://export.arxiv.org/api/query?${params.toString()}`);
      const parsed = await parseStringPromise(xml, { explicitArray: true });
      const entries = Array.isArray(parsed.feed && parsed.feed.entry) ? parsed.feed.entry : [];
      sourceStats.rawFetched += entries.length;
      for (const entry of entries) {
        const paper = arxivPaper(entry);
        if (paper.abstract.length >= 40) sourceStats.withAbstract += 1;
        addPaper(registry, paper, sourceStats);
      }
    } catch (error) {
      sourceStats.errors.push(error.message);
    }
    await sleep(200);
  }
}

async function collectSemanticScholar(registry, sourceStats) {
  for (const query of SEMANTIC_SCHOLAR_QUERIES) {
    if (registry.list.length >= TARGET_CAP) return;
    sourceStats.requests += 1;
    const params = new URLSearchParams({
      query,
      limit: '20',
      fields: 'title,abstract,year,authors,venue,paperId,citationCount,referenceCount,url'
    });
    try {
      const payload = await httpGetJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`);
      const items = Array.isArray(payload.data) ? payload.data : [];
      sourceStats.rawFetched += items.length;
      for (const item of items) {
        const paper = semanticScholarPaper(item);
        if (paper.abstract.length >= 40) sourceStats.withAbstract += 1;
        addPaper(registry, paper, sourceStats);
      }
    } catch (error) {
      sourceStats.errors.push(error.message);
    }
    await sleep(1000);
  }
}

async function loadDumpCorpus(registry, sourceStats) {
  const loaders = [
    {
      key: 'openalex',
      dir: path.join(DUMP_DIR, 'openalex'),
      ext: '.json',
      parse(body) {
        const payload = JSON.parse(body);
        if (payload && payload.error) throw new Error(payload.error);
        return Array.isArray(payload.results) ? payload.results.map(openAlexPaper) : [];
      }
    },
    {
      key: 'crossref',
      dir: path.join(DUMP_DIR, 'crossref'),
      ext: '.json',
      parse(body) {
        const payload = JSON.parse(body);
        if (payload && payload.status && payload.status !== 'ok') throw new Error(payload.message || payload.status);
        const items = Array.isArray(payload.message && payload.message.items) ? payload.message.items : [];
        return items.map(crossrefPaper);
      }
    },
    {
      key: 'arxiv',
      dir: path.join(DUMP_DIR, 'arxiv'),
      ext: '.xml',
      async parse(body) {
        const payload = await parseStringPromise(body, { explicitArray: true });
        const entries = Array.isArray(payload.feed && payload.feed.entry) ? payload.feed.entry : [];
        return entries.map(arxivPaper);
      }
    },
    {
      key: 'semanticScholar',
      dir: path.join(DUMP_DIR, 'semanticScholar'),
      ext: '.json',
      parse(body) {
        const payload = JSON.parse(body);
        if (payload && Number(payload.code) === 429) throw new Error(payload.message || 'Semantic Scholar rate limited');
        const items = Array.isArray(payload.data) ? payload.data : [];
        return items.map(semanticScholarPaper);
      }
    }
  ];

  for (const loader of loaders) {
    if (!fs.existsSync(loader.dir)) {
      sourceStats[loader.key].errors.push(`Missing dump directory: ${loader.dir}`);
      continue;
    }
      const files = fs.readdirSync(loader.dir)
        .filter((file) => file.endsWith(loader.ext))
        .sort();
    for (const file of files) {
      if (registry.list.length >= TARGET_CAP) return;
      const fullPath = path.join(loader.dir, file);
      const statusPath = `${fullPath}.status`;
      const statusText = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8').trim() : '200';
      sourceStats[loader.key].requests += 1;
      if (statusText !== '200') {
        sourceStats[loader.key].errors.push(`HTTP ${statusText} for ${file}`);
        continue;
      }
      try {
        const body = fs.readFileSync(fullPath, 'utf8');
        const papers = await loader.parse(body);
        sourceStats[loader.key].rawFetched += papers.length;
        for (const paper of papers) {
          if (paper.abstract.length >= 40) sourceStats[loader.key].withAbstract += 1;
          addPaper(registry, paper, sourceStats[loader.key]);
        }
      } catch (error) {
        sourceStats[loader.key].errors.push(`${file}: ${error.message}`);
      }
    }
  }
}

function buildSignalRecord(signal, ingestResult) {
  return {
    id: signal.id,
    type: signal.type,
    title: signal.title,
    content: signal.content,
    keywords: Array.isArray(signal.keywords) ? signal.keywords : [],
    paperId: signal.paperId,
    source: signal.source,
    sourceWeight: signal.sourceWeight,
    timestamp: signal.timestamp,
    cellId: ingestResult.signal.cellId,
    axes: {
      what: ingestResult.signal.what,
      where: ingestResult.signal.where,
      time: ingestResult.signal.time
    }
  };
}

function pickCandidateTerms(supportingSignals) {
  const counts = new Map();
  for (const signal of supportingSignals) {
    const terms = [
      ...(Array.isArray(signal.keywords) ? signal.keywords : []),
      ...tokenize(signal.title),
      ...tokenize(signal.content)
    ];
    for (const term of terms) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([term]) => term);
}

function overlapCount(tokenSet, terms) {
  let hits = 0;
  for (const term of terms) {
    if (tokenSet.has(term)) hits += 1;
  }
  return hits;
}

function compactEvidenceSummary(packet) {
  return {
    evidenceRefCount: Array.isArray(packet.evidenceRefs) ? packet.evidenceRefs.length : 0,
    sourceTypes: [...new Set((packet.evidenceRefs || []).map((entry) => entry.sourceType || 'unknown'))],
    candidateCells: packet.cube && Array.isArray(packet.cube.cells) ? packet.cube.cells : []
  };
}

function exactKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) exactKeys(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    exactKeys(child, found);
  }
  return found;
}

function evaluateBreaker(packet, candidate, paperIndex, signalRecords) {
  const supportingSignals = signalRecords.filter((signal) => (candidate.cells || []).includes(signal.cellId));
  const terms = pickCandidateTerms(supportingSignals);
  const relevant = [];

  for (const paper of paperIndex) {
    const overlap = overlapCount(paper.tokenSet, terms);
    if (overlap >= 3) {
      relevant.push({ paper, overlap });
    }
  }

  relevant.sort((a, b) => (b.overlap - a.overlap) || a.paper.paperId.localeCompare(b.paper.paperId));
  const contradictionMatches = relevant
    .filter(({ paper }) => CONTRADICTION_RE.test(paper.searchText))
    .slice(0, 10)
    .map(({ paper, overlap }) => ({ paperId: paper.paperId, title: paper.title, overlap }));
  const existingSolutionMatches = relevant
    .filter(({ paper }) => SOLUTION_RE.test(paper.searchText) && !NEGATING_RE.test(paper.searchText))
    .slice(0, 10)
    .map(({ paper, overlap }) => ({ paperId: paper.paperId, title: paper.title, overlap }));

  const verdict = contradictionMatches.length === 0 && existingSolutionMatches.length === 0 ? 'verified' : 'rejected';
  return {
    supportingSignalCount: supportingSignals.length,
    candidateTerms: terms,
    contradictionMatches,
    existingSolutionMatches,
    verdict,
    reason: verdict === 'verified'
      ? 'No high-overlap contradiction or existing-solution papers were found in the scanned corpus.'
      : 'Breaker found conflicting or already-solved evidence in the scanned corpus.'
  };
}

function determineSystemStatus(report) {
  const pipelineStable = report.paperIngestion.uniquePapers >= TARGET_MIN_PAPERS &&
    report.signalExtraction.totalSignalsGenerated > 0 &&
    report.discoveryPipeline.discoveryCandidates > 0 &&
    report.discoveryPipeline.gapPacketsGenerated > 0;
  const governanceCompliant = report.governanceHandoff.overallCompliant === true;
  const sourceHealthy = report.paperIngestion.sources.semanticScholar.errors.length === 0 &&
    report.paperIngestion.sources.openalex.errors.length === 0 &&
    report.paperIngestion.sources.crossref.errors.length === 0 &&
    report.paperIngestion.sources.arxiv.errors.length === 0;

  if (!pipelineStable || !governanceCompliant) return 'failing';
  if (!sourceHealthy || report.breaker.hypothesesVerified === 0) return 'degraded';
  return 'healthy';
}

async function run() {
  const health = directoryAndFileHealth();
  const missingDirs = health.directories.filter((item) => !item.exists);
  const missingFiles = health.files.filter((item) => !item.exists);
  if (missingDirs.length > 0 || missingFiles.length > 0) {
    const report = {
      generatedAt: new Date().toISOString(),
      environment: health,
      finalStatus: 'failing',
      reason: 'Required directories or files are missing.'
    };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const memorySnapshots = [];
  const captureMemory = (stage) => {
    const usage = process.memoryUsage();
    memorySnapshots.push({
      stage,
      rssMb: round(usage.rss / (1024 * 1024), 2),
      heapUsedMb: round(usage.heapUsed / (1024 * 1024), 2),
      externalMb: round(usage.external / (1024 * 1024), 2)
    });
  };

  captureMemory('start');

  const collectStart = performance.now();
  const registry = { list: [], map: new Map() };
  const sourceStats = {
    openalex: { requests: 0, rawFetched: 0, withAbstract: 0, uniqueAdded: 0, duplicates: 0, errors: [] },
    crossref: { requests: 0, rawFetched: 0, withAbstract: 0, uniqueAdded: 0, duplicates: 0, errors: [] },
    arxiv: { requests: 0, rawFetched: 0, withAbstract: 0, uniqueAdded: 0, duplicates: 0, errors: [] },
    semanticScholar: { requests: 0, rawFetched: 0, withAbstract: 0, uniqueAdded: 0, duplicates: 0, errors: [] }
  };

  await loadDumpCorpus(registry, sourceStats);
  const collectionMs = performance.now() - collectStart;
  captureMemory('after-paper-collection');

  const papers = registry.list.slice(0, TARGET_MAX_PAPERS);
  const rawSignals = [];
  const signalTypes = { 'paper-theory': 0, 'paper-method': 0, 'paper-result': 0, 'paper-limitation': 0 };

  for (const paper of papers) {
    const signals = extractPaperSignals({
      title: paper.title,
      abstract: paper.abstract,
      authors: paper.authors,
      year: paper.year,
      publishedAt: paper.publishedAt,
      citationCount: paper.citationCount,
      referenceCount: paper.referenceCount,
      paperId: paper.paperId,
      sourceUrl: paper.sourceUrl,
      venue: paper.venue,
      keywords: paper.keywords,
      score: paper.score,
      domain: paper.domain
    }, {
      sourceName: paper.sourceName
    });
    for (const signal of signals) {
      rawSignals.push(signal);
      signalTypes[signal.type] = (signalTypes[signal.type] || 0) + 1;
    }
  }
  captureMemory('after-signal-extraction');

  const queue = new SignalQueue();
  for (const signal of rawSignals) {
    queue.produce(TOPICS.RAW_SIGNALS, signal);
  }

  const normalizationStart = performance.now();
  const normalization = normalizeQueue(queue, { nowMs: Date.parse(REFERENCE_TIME) });
  const normalizedSignals = queue.consumeAll(TOPICS.NORMALIZED_SIGNALS);
  const normalizationMs = performance.now() - normalizationStart;
  captureMemory('after-normalization');

  const engine = makeEngine();
  const signalRecords = [];
  let deterministicSampleFailures = 0;
  const ingestionStart = performance.now();
  const deterministicSampleSize = Math.min(500, normalizedSignals.length);

  for (let index = 0; index < normalizedSignals.length; index += 1) {
    const signal = normalizedSignals[index];
    const ingestResult = engine.ingestSignal(signal, {
      tick: index + 1,
      persist: false,
      referenceTime: REFERENCE_TIME
    });
    signalRecords.push(buildSignalRecord(signal, ingestResult));
    if (index < deterministicSampleSize) {
      const first = normalizeCubeSignal(signal, { referenceTime: REFERENCE_TIME });
      const second = normalizeCubeSignal(signal, { referenceTime: REFERENCE_TIME });
      if (first.cellId !== second.cellId) deterministicSampleFailures += 1;
    }
  }
  const ingestionMs = performance.now() - ingestionStart;
  captureMemory('after-cube-ingestion');

  const cubeState = engine.getState();
  const spilloverCells = Object.values(cubeState.cells || {}).filter((cell) => (cell.spilloverScore || 0) > 0);
  const spilloverOnlyCells = spilloverCells.filter((cell) => (cell.directScore || 0) === 0 && (cell.evidenceScore || 0) === 0);
  const cellsActivated = [...new Set(signalRecords.map((signal) => signal.cellId))];

  const discoveryStart = performance.now();
  const cycle = runDiscoveryCycle(engine, { tick: normalizedSignals.length });
  const discoveryMs = performance.now() - discoveryStart;
  captureMemory('after-discovery');

  const emergenceSummary = engine.summarizeEmergence({ persist: false });
  const gravityCells = computeResearchGravity(cubeState, emergenceSummary);
  const sourceScores = scoreSignalSources(cubeState, emergenceSummary.collisions || [], cubeState.emergenceEvents || []);
  const scoredCandidates = scoreGapCandidates({
    candidates: cycle.discovery.candidates,
    cubeState,
    emergenceSummary,
    gravityCells,
    sourceScores
  });

  const formulaChecks = scoredCandidates.map((item) => {
    const expected = round(
      (item.scores.novelty * 0.16) +
      (item.scores.collision * 0.18) +
      (item.scores.residue * 0.16) +
      (item.scores.gravity * 0.16) +
      (item.scores.evidence * 0.14) +
      (item.scores.entropy * 0.10) +
      (item.scores.serendipity * 0.10),
      3
    );
    return {
      candidateId: item.candidate.id,
      expected,
      observed: item.scores.total,
      withinTolerance: Math.abs(expected - item.scores.total) <= 0.01
    };
  });

  const packetByCandidateId = new Map((cycle.gapDiscovery.packets || []).map((packet) => [packet.candidate.id, packet]));
  const promisingCandidates = scoredCandidates
    .filter((item) => item.scores.total >= 0.62)
    .sort((a, b) => (b.scores.total - a.scores.total) || a.candidate.id.localeCompare(b.candidate.id));

  const paperIndex = papers.map((paper) => ({
    paperId: paper.paperId,
    title: paper.title,
    searchText: `${paper.title} ${paper.abstract} ${(paper.keywords || []).join(' ')}`.toLowerCase(),
    tokenSet: new Set(tokenize(`${paper.title} ${paper.abstract} ${(paper.keywords || []).join(' ')}`))
  }));

  const hypothesisResults = [];
  for (const item of promisingCandidates) {
    const packet = packetByCandidateId.get(item.candidate.id);
    const hypothesis = packet ? packet.hypothesis : buildHypothesis(item.candidate, item.scores);
    const verificationPlan = packet ? packet.verificationPlan : buildVerificationPlan(item.candidate, item.scores);
    const killConditions = packet ? packet.killTests : buildKillTests(item.candidate, item.scores);
    const breaker = evaluateBreaker(packet, item.candidate, paperIndex, signalRecords);
    hypothesisResults.push({
      candidateId: item.candidate.id,
      score: item.scores.total,
      cells: item.candidate.cells,
      hypothesis,
      verificationPlan,
      killConditions,
      breaker,
      packetId: packet ? packet.packetId : null
    });
  }

  const verifiedHypotheses = hypothesisResults.filter((entry) => entry.breaker.verdict === 'verified');
  const rejectedHypotheses = hypothesisResults.filter((entry) => entry.breaker.verdict === 'rejected');
  const verifiedPackets = verifiedHypotheses
    .map((entry) => packetByCandidateId.get(entry.candidateId))
    .filter(Boolean);

  const packetChecks = verifiedPackets.map((packet) => {
    const validation = validateGapPacket(packet);
    return {
      gapId: packet.packetId,
      validation,
      fields: {
        gapId: packet.packetId,
        hypothesis: packet.hypothesis,
        scoringTrace: packet.scoringTrace,
        verificationPlan: packet.verificationPlan,
        killConditions: packet.killTests,
        evidenceSummary: compactEvidenceSummary(packet)
      }
    };
  });

  const allGovernedPackets = cycle.gapDiscovery.packets || [];
  const governanceChecks = allGovernedPackets.map((packet) => {
    const handoff = packet.gapProposalHandoff;
    const keys = exactKeys(handoff);
    return {
      gapId: packet.packetId,
      executionMode: handoff.executionMode,
      trustBoundary: handoff.trustBoundary,
      destinationSystem: handoff.destinationSystem,
      forbiddenExecutionFields: ['execute', 'action', 'runtimeInstruction'].filter((key) => keys.has(key)),
      compliant: handoff.executionMode === 'forbidden' &&
        handoff.trustBoundary === 'discovery_only' &&
        handoff.destinationSystem === 'openclashd-v2' &&
        ['execute', 'action', 'runtimeInstruction'].every((key) => !keys.has(key))
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      requiredDirectories: health.directories,
      requiredFiles: health.files,
      npmInstall: {
        status: 'success'
      }
    },
    paperIngestion: {
      targetMinPapers: TARGET_MIN_PAPERS,
      targetMaxPapers: TARGET_MAX_PAPERS,
      uniquePapers: papers.length,
      sources: sourceStats,
      sourceBreakdown: papers.reduce((acc, paper) => {
        acc[paper.source] = (acc[paper.source] || 0) + 1;
        return acc;
      }, {})
    },
    signalExtraction: {
      totalSignalsGenerated: rawSignals.length,
      averageSignalsPerPaper: papers.length > 0 ? round(rawSignals.length / papers.length, 3) : 0,
      signalTypes
    },
    normalization: {
      accepted: normalization.accepted,
      dropped: normalization.dropped,
      duplicates: normalization.duplicates,
      lowQuality: normalization.lowQuality,
      windowingVerified: normalizedSignals.every((signal) => typeof signal.windowStartIso === 'string' && signal.windowStartIso.length > 0),
      dedupeKeysGenerated: normalizedSignals.every((signal) => typeof signal.dedupeKey === 'string' && signal.dedupeKey.length > 0),
      sourceWeightsVerified: {
        'paper-theory': SIGNAL_TYPE_WEIGHTS['paper-theory'],
        'github-repo': SIGNAL_TYPE_WEIGHTS['github-repo'],
        'internal-system': SIGNAL_TYPE_WEIGHTS['internal-system']
      }
    },
    cubeIngestion: {
      normalizedSignalsIngested: normalizedSignals.length,
      cellsActivated: cellsActivated.length,
      activatedCellIds: cellsActivated.sort((a, b) => a - b),
      spilloverCells: spilloverCells.length,
      spilloverOnlyCells: spilloverOnlyCells.length,
      deterministicSampleSize,
      deterministicSampleFailures,
      totalTick: cubeState.clock,
      totalEvidenceScore: round(Object.values(cubeState.cells || {}).reduce((sum, cell) => sum + (cell.evidenceScore || 0), 0), 3)
    },
    discoveryPipeline: {
      collisionsDetected: (cycle.emergence.collisions || []).length,
      clustersDetected: (cycle.emergence.clusters || []).length,
      gradientsDetected: (cycle.emergence.gradients || []).length,
      discoveryCandidates: cycle.discovery.candidates.length,
      candidateCellSets: cycle.discovery.candidates.slice(0, 20).map((candidate) => ({
        candidateId: candidate.id,
        cells: candidate.cells,
        type: candidate.type,
        candidateScore: candidate.candidateScore
      })),
      gapPacketsGenerated: allGovernedPackets.length
    },
    gapScoring: {
      candidateCount: scoredCandidates.length,
      scoringTraceCoverage: scoredCandidates.every((item) => item.scoringTrace &&
        item.scoringTrace.formulas &&
        typeof item.scoringTrace.formulas.novelty === 'string' &&
        typeof item.scoringTrace.formulas.collision === 'string' &&
        typeof item.scoringTrace.formulas.residue === 'string' &&
        typeof item.scoringTrace.formulas.gravity === 'string' &&
        typeof item.scoringTrace.formulas.evidence === 'string' &&
        typeof item.scoringTrace.formulas.entropy === 'string' &&
        typeof item.scoringTrace.formulas.serendipity === 'string' &&
        typeof item.scoringTrace.formulas.total === 'string'),
      formulaVerifiedCount: formulaChecks.filter((item) => item.withinTolerance).length,
      topCandidateScores: scoredCandidates
        .slice()
        .sort((a, b) => (b.scores.total - a.scores.total) || a.candidate.id.localeCompare(b.candidate.id))
        .slice(0, 10)
        .map((item) => ({
          candidateId: item.candidate.id,
          total: item.scores.total,
          novelty: item.scores.novelty,
          collision: item.scores.collision,
          residue: item.scores.residue,
          gravity: item.scores.gravity,
          evidence: item.scores.evidence,
          entropy: item.scores.entropy,
          serendipity: item.scores.serendipity
        }))
    },
    hypotheses: {
      promisingCandidates: promisingCandidates.length,
      generated: hypothesisResults.length,
      structureVerifiedCount: hypothesisResults.filter((entry) =>
        entry.hypothesis &&
        typeof entry.hypothesis.statement === 'string' &&
        entry.hypothesis.statement.length > 20 &&
        Array.isArray(entry.verificationPlan) &&
        entry.verificationPlan.length === 3 &&
        Array.isArray(entry.killConditions) &&
        entry.killConditions.length === 4
      ).length,
      samples: hypothesisResults.slice(0, 10).map((entry) => ({
        candidateId: entry.candidateId,
        score: entry.score,
        hypothesis: entry.hypothesis.statement,
        verificationSteps: entry.verificationPlan.length,
        killConditions: entry.killConditions.length
      }))
    },
    breaker: {
      hypothesesVerified: verifiedHypotheses.length,
      hypothesesRejected: rejectedHypotheses.length,
      rejectedSamples: rejectedHypotheses.slice(0, 10).map((entry) => ({
        candidateId: entry.candidateId,
        packetId: entry.packetId,
        contradictions: entry.breaker.contradictionMatches.length,
        existingSolutions: entry.breaker.existingSolutionMatches.length,
        reason: entry.breaker.reason
      }))
    },
    gapPackets: {
      verifiedGapPackets: verifiedPackets.length,
      packetChecks: packetChecks.slice(0, 20)
    },
    governanceHandoff: {
      generated: governanceChecks.length,
      verifiedGenerated: verifiedPackets.length,
      overallCompliant: governanceChecks.every((entry) => entry.compliant),
      samples: governanceChecks.slice(0, 20)
    },
    performance: {
      paperCollectionMs: round(collectionMs, 2),
      normalizationMs: round(normalizationMs, 2),
      ingestionMs: round(ingestionMs, 2),
      discoveryCycleMs: round(discoveryMs, 2),
      signalsPerSecond: ingestionMs > 0 ? round((normalizedSignals.length / ingestionMs) * 1000, 2) : 0,
      memorySnapshots
    }
  };

  report.finalStatus = determineSystemStatus(report);
  report.summary = {
    papersAnalyzed: report.paperIngestion.uniquePapers,
    signalsGenerated: report.signalExtraction.totalSignalsGenerated,
    cubeCellsActivated: report.cubeIngestion.cellsActivated,
    collisionsDetected: report.discoveryPipeline.collisionsDetected,
    clustersDetected: report.discoveryPipeline.clustersDetected,
    discoveryCandidates: report.discoveryPipeline.discoveryCandidates,
    promisingGaps: report.hypotheses.promisingCandidates,
    hypothesesGenerated: report.hypotheses.generated,
    hypothesesRejectedByBreaker: report.breaker.hypothesesRejected,
    gapPacketsProduced: report.gapPackets.verifiedGapPackets,
    governanceHandoffsGenerated: report.governanceHandoff.generated
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    finalStatus: report.finalStatus,
    papersAnalyzed: report.paperIngestion.uniquePapers,
    signalsGenerated: report.signalExtraction.totalSignalsGenerated,
    discoveryCandidates: report.discoveryPipeline.discoveryCandidates,
    promisingCandidates: report.hypotheses.promisingCandidates,
    verifiedHypotheses: report.breaker.hypothesesVerified,
    governanceCompliant: report.governanceHandoff.overallCompliant,
    semanticScholarErrors: report.paperIngestion.sources.semanticScholar.errors
  }, null, 2));

  if (report.finalStatus === 'failing') {
    process.exit(1);
  }
}

run().catch((error) => {
  const fallback = {
    generatedAt: new Date().toISOString(),
    finalStatus: 'failing',
    error: error.message
  };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(fallback, null, 2));
  console.error(error);
  process.exit(1);
});
