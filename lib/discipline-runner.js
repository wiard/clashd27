'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const LEGACY_JS_LOADER = Module._extensions['.js'];
const LEGACY_MODULE_ROOTS = [path.join(__dirname, '..', 'src')];
Module._extensions['.js'] = function clashd27DisciplineLoader(moduleRef, filename) {
  if (LEGACY_MODULE_ROOTS.some((rootDir) => filename.startsWith(rootDir))) {
    const content = fs.readFileSync(filename, 'utf8');
    moduleRef._compile(content, filename);
    return;
  }
  return LEGACY_JS_LOADER(moduleRef, filename);
};

const { disciplines } = require('../src/disciplines/discipline-registry');
const { fetchPapers } = require('./paper-fetcher');
const { scoreGapCandidate } = require('../src/gap/gap-scorer');
const { runResearchSession, readFindings } = require('./researcher');
const { qualifiesForPublication } = require('./gap-publisher');
const { recordHeat, recordCharge, updateQueueSize } = require('./heat-charge-tracker');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DISCIPLINES_DIR = path.join(DATA_DIR, 'disciplines');
const DISCIPLINES_INDEX_FILE = path.join(DISCIPLINES_DIR, 'index.json');
const DEFAULT_SOURCES = ['semantic-scholar', 'openalex'];

process.on('uncaughtException', (err) => {
  console.error('[discipline-runner] uncaught:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[discipline-runner] unhandled rejection:', reason);
});

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function readJSON(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {
    return fallback;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function scoreToUnit(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 1) return clamp(numeric, 0, 1);
  return clamp(numeric / 100, 0, 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64) || 'gap';
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function summarizeAuthors(paper) {
  if (!Array.isArray(paper?.authors)) return [];
  return paper.authors
    .map((author) => typeof author === 'string' ? author : author?.name)
    .filter(Boolean)
    .slice(0, 5);
}

function titleFromFinding(finding) {
  const hypothesis = String(finding?.hypothesis || finding?.discovery || '').trim();
  if (!hypothesis) return 'Onderzoekskans';
  return hypothesis.split('.').shift().trim().slice(0, 120);
}

function disciplinePaths(disciplineId) {
  const root = path.join(DISCIPLINES_DIR, disciplineId);
  return {
    root,
    gapsDir: path.join(root, 'gaps'),
    runsDir: path.join(root, 'runs'),
    indexFile: path.join(root, 'index.json'),
    summaryFile: path.join(root, 'summary.json'),
    latestRunFile: path.join(root, 'latest-run.json'),
    failedKeywordsFile: path.join(root, 'failed-keywords.json')
  };
}

function readDisciplineIndex() {
  return readJSON(DISCIPLINES_INDEX_FILE, { disciplines: [], updatedAt: null });
}

function writeDisciplineIndex(index) {
  writeJSON(DISCIPLINES_INDEX_FILE, {
    ...index,
    updatedAt: new Date().toISOString()
  });
}

function readFailedKeywords(disciplineId) {
  return readJSON(disciplinePaths(disciplineId).failedKeywordsFile, { failedKeywords: [] });
}

function writeFailedKeywords(disciplineId, data) {
  writeJSON(disciplinePaths(disciplineId).failedKeywordsFile, data);
}

function readDisciplineGap(disciplineId, gapId) {
  const filePath = path.join(disciplinePaths(disciplineId).gapsDir, `${gapId}.json`);
  return readJSON(filePath, null);
}

function readDisciplineGaps(disciplineId) {
  const { gapsDir } = disciplinePaths(disciplineId);
  if (!fs.existsSync(gapsDir)) return [];
  return fs.readdirSync(gapsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readJSON(path.join(gapsDir, entry), null))
    .filter(Boolean)
    .sort((left, right) => {
      const scoreDelta = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDelta !== 0) return scoreDelta;
      return String(right.createdAtIso || '').localeCompare(String(left.createdAtIso || ''));
    });
}

function findPaperMatches(finding, papers, limit = 5) {
  const hypothesis = `${finding?.hypothesis || ''} ${(finding?.keywords || []).join(' ')}`.toLowerCase();
  const ranked = (papers || []).map((paper) => {
    const haystack = `${paper.title || ''} ${paper.abstract || ''}`.toLowerCase();
    const overlap = uniqueStrings(finding?.keywords || []).filter((keyword) => haystack.includes(String(keyword).toLowerCase())).length;
    const titleMatch = titleFromFinding(finding).toLowerCase().split(/\s+/).filter((token) => token.length > 5 && haystack.includes(token)).length;
    const hypothesisMatch = hypothesis ? Math.min(3, hypothesis.split(/\s+/).filter((token) => token.length > 5 && haystack.includes(token)).length) : 0;
    return {
      paper,
      score: overlap * 3 + titleMatch * 2 + hypothesisMatch + (Number(paper.citationCount) || 0) * 0.001
    };
  });

  return ranked
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => ({
      title: entry.paper.title || '',
      authors: summarizeAuthors(entry.paper),
      url: entry.paper.url || entry.paper.doiUrl || '',
      source: entry.paper.source || 'paper',
      year: entry.paper.year || null
    }));
}

function buildSyntheticCandidate(finding, discipline, papers) {
  const researchScore = scoreToUnit(finding?.scores?.total || 0);
  const evidenceScore = clamp(((finding?.supporting_sources || []).length || 0) / 3, 0, 1);
  const noveltyScore = clamp((Number(finding?.scores?.novelty || 0) / 10), 0, 1);
  const sources = uniqueStrings((papers || []).map((paper) => paper.source || 'paper'));

  return {
    cells: [0, 1],
    sources,
    axes: [{ time: 'current' }, { time: 'emerging' }],
    domainDistance: discipline.id.includes('ai-') ? 0.24 : 0.18,
    label: titleFromFinding(finding),
    hypothesis: finding?.hypothesis || finding?.discovery || '',
    scoreSeed: researchScore,
    evidenceSeed: evidenceScore,
    noveltySeed: noveltyScore
  };
}

function buildSyntheticCubeState(finding, papers) {
  const evidenceScore = clamp(((finding?.supporting_sources || []).length || 0) / 3, 0, 1);
  const directScore = clamp((Number(finding?.scores?.evidence || 0) / 20), 0, 1);
  const baseScore = scoreToUnit(finding?.scores?.total || 0);
  const sourceTypes = uniqueStrings((papers || []).map((paper) => paper.source || 'paper'));
  return {
    cells: {
      '0': {
        axes: { time: 'current' },
        uniqueSourceTypes: sourceTypes,
        score: baseScore,
        formulaResidue: Number(finding?.scores?.bridge || 0),
        timeSpread: 3,
        evidenceScore,
        directScore,
        entropySeed: 1.25,
        ticks: [1, 2, 3]
      },
      '1': {
        axes: { time: 'emerging' },
        uniqueSourceTypes: sourceTypes,
        score: clamp(baseScore + 0.05, 0, 1),
        formulaResidue: Number(finding?.scores?.novelty || 0),
        timeSpread: 4,
        evidenceScore,
        directScore,
        entropySeed: 1.35,
        ticks: [1, 2, 3, 4]
      }
    }
  };
}

function buildSyntheticEmergence(finding) {
  const total = scoreToUnit(finding?.scores?.total || 0);
  return {
    collisions: [{
      cells: [0, 1],
      emergenceScore: total,
      domainDistance: 0.24,
      collisionType: 'far-field'
    }]
  };
}

function buildSourceScores(papers) {
  return uniqueStrings((papers || []).map((paper) => paper.source || 'paper')).map((source) => ({
    source,
    combinedScore: 0.75
  }));
}

function computeDisciplineGapScore(finding, discipline, papers) {
  const researchScore = scoreToUnit(finding?.scores?.total || 0);
  const scored = scoreGapCandidate({
    candidate: buildSyntheticCandidate(finding, discipline, papers),
    cubeState: buildSyntheticCubeState(finding, papers),
    emergenceSummary: buildSyntheticEmergence(finding),
    gravityCells: [
      { cell: 0, gravityScore: clamp(researchScore + 0.1, 0, 1) },
      { cell: 1, gravityScore: clamp(researchScore + 0.05, 0, 1) }
    ],
    sourceScores: buildSourceScores(papers)
  });
  const gapScore = scoreToUnit(scored?.scores?.total || 0);
  const finalScore = round((researchScore * 0.65) + (gapScore * 0.35), 3);
  return {
    finalScore,
    researchScore: round(researchScore, 3),
    gapScore: round(gapScore, 3),
    scoringTrace: scored?.scoringTrace || null,
    componentScores: scored?.scores || null
  };
}

function buildStoredGap(finding, discipline, papers, runId) {
  const matchedPapers = findPaperMatches(finding, papers, 5);
  const disciplineScore = computeDisciplineGapScore(finding, discipline, matchedPapers);
  const hypothesis = String(finding?.hypothesis || finding?.discovery || '').trim();
  const title = titleFromFinding(finding);
  const slug = safeId(`${finding?.id || runId}-${title}`);
  return {
    id: slug,
    sourceFindingId: finding?.id || null,
    disciplineId: discipline.id,
    disciplineLabel: discipline.label,
    color: discipline.color,
    title,
    hypothesis,
    score: disciplineScore.finalScore,
    researchScore: disciplineScore.researchScore,
    gapScore: disciplineScore.gapScore,
    scoringTrace: disciplineScore.scoringTrace,
    componentScores: disciplineScore.componentScores,
    verdict: finding?.verdict?.verdict || finding?.verdict || null,
    createdAtIso: finding?.timestamp || new Date().toISOString(),
    keywords: uniqueStrings([...(finding?.keywords || []), ...discipline.keywords]).slice(0, 20),
    supportingSources: finding?.supporting_sources || [],
    limitingSources: finding?.limiting_sources || [],
    bridge: finding?.bridge || null,
    cheapestValidation: finding?.cheapest_validation || null,
    sourcePapers: matchedPapers,
    published: disciplineScore.finalScore >= Number(process.env.MIN_PUBLISH_SCORE || 0.8)
  };
}

function upsertDisciplineGap(discipline, gap) {
  const paths = disciplinePaths(discipline.id);
  ensureDir(path.join(paths.gapsDir, 'placeholder'));
  const filePath = path.join(paths.gapsDir, `${gap.id}.json`);
  writeJSON(filePath, gap);

  const index = readJSON(paths.indexFile, { discipline: discipline.id, gaps: [], updatedAt: null });
  const summary = {
    id: gap.id,
    title: gap.title,
    score: gap.score,
    createdAtIso: gap.createdAtIso,
    sourceFindingId: gap.sourceFindingId
  };
  const existingIndex = (index.gaps || []).findIndex((entry) => entry.id === gap.id);
  if (existingIndex >= 0) {
    index.gaps[existingIndex] = {
      ...index.gaps[existingIndex],
      ...summary
    };
  } else {
    index.gaps.push(summary);
  }
  index.gaps.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  writeJSON(paths.indexFile, {
    ...index,
    discipline: discipline.id,
    label: discipline.label,
    color: discipline.color,
    updatedAt: new Date().toISOString()
  });
}

function summarizeDiscipline(discipline, gaps, runMeta) {
  const totalGaps = gaps.length;
  const avgScore = totalGaps > 0
    ? round(gaps.reduce((sum, gap) => sum + Number(gap.score || 0), 0) / totalGaps, 3)
    : 0;
  const topGap = totalGaps > 0 ? gaps[0] : null;
  const topKeywords = uniqueStrings(gaps.flatMap((gap) => gap.keywords || [])).slice(0, 10);
  const trendingTopics = uniqueStrings(gaps.flatMap((gap) => (gap.sourcePapers || []).map((paper) => paper.title))).slice(0, 5);
  return {
    discipline: {
      id: discipline.id,
      label: discipline.label,
      color: discipline.color
    },
    totalGaps,
    avgScore,
    topGap,
    lastUpdated: runMeta.completedAtIso,
    topKeywords,
    trendingTopics
  };
}

function updateGlobalDisciplineIndex(discipline, summary, runMeta) {
  const index = readDisciplineIndex();
  if (!Array.isArray(index.disciplines)) {
    index.disciplines = [];
  }

  const record = {
    id: discipline.id,
    label: discipline.label,
    color: discipline.color,
    gapCount: summary.totalGaps,
    lastRun: runMeta.completedAtIso,
    topScore: summary.topGap ? summary.topGap.score : 0,
    lastRunId: runMeta.runId
  };
  const existingIndex = index.disciplines.findIndex((entry) => entry.id === discipline.id);
  if (existingIndex >= 0) {
    index.disciplines[existingIndex] = {
      ...index.disciplines[existingIndex],
      ...record
    };
  } else {
    index.disciplines.push(record);
  }
  index.disciplines.sort((left, right) => String(left.label || '').localeCompare(String(right.label || '')));
  writeDisciplineIndex(index);
}

function initializeDisciplineStorage(discipline, runMeta) {
  const paths = disciplinePaths(discipline.id);
  ensureDir(path.join(paths.gapsDir, 'placeholder'));
  ensureDir(path.join(paths.runsDir, 'placeholder'));
  if (!fs.existsSync(paths.indexFile)) {
    writeJSON(paths.indexFile, {
      discipline: discipline.id,
      label: discipline.label,
      color: discipline.color,
      gaps: [],
      updatedAt: new Date().toISOString()
    });
  }
  if (!fs.existsSync(paths.summaryFile)) {
    writeJSON(paths.summaryFile, {
      discipline: {
        id: discipline.id,
        label: discipline.label,
        color: discipline.color
      },
      totalGaps: 0,
      avgScore: 0,
      topGap: null,
      lastUpdated: runMeta.startedAtIso,
      topKeywords: discipline.keywords.slice(0, 5),
      trendingTopics: []
    });
  }
  if (!fs.existsSync(paths.failedKeywordsFile)) {
    writeJSON(paths.failedKeywordsFile, {
      failedKeywords: []
    });
  }
  writeJSON(paths.latestRunFile, {
    ...runMeta,
    status: 'running'
  });
  const existingSummary = readDisciplineSummary(discipline.id) || {
    discipline: {
      id: discipline.id,
      label: discipline.label,
      color: discipline.color
    },
    totalGaps: 0,
    avgScore: 0,
    topGap: null
  };
  updateGlobalDisciplineIndex(discipline, existingSummary, runMeta);
}

async function runDisciplineTick(discipline, options = {}) {
  recordHeat('discipline-tick');
  const now = new Date();
  const runId = options.runId || `${discipline.id}-${now.getTime()}`;
  const paths = disciplinePaths(discipline.id);
  const maxFindings = Math.max(1, Math.min(
    Number(options.maxFindings || process.env.MAX_GAPS_PER_DISCIPLINE || 20),
    20
  ));
  const minPublishScore = Number(options.minPublishScore || process.env.MIN_PUBLISH_SCORE || 0.8);
  const papersPerQuery = Math.max(10, Number(options.papersPerQuery || 25));
  const log = options.log || console.log;
  const minPaperCount = Math.max(5, Number(options.minPaperCount || 5));
  const startedAtIso = now.toISOString();
  const runMeta = {
    runId,
    disciplineId: discipline.id,
    startedAtIso,
    completedAtIso: null,
    papersFetched: 0,
    session: null,
    publishedCount: 0
  };

  initializeDisciplineStorage(discipline, runMeta);
  const failedKeywordState = readFailedKeywords(discipline.id);
  const retryKeywords = uniqueStrings((failedKeywordState.failedKeywords || []).map((entry) => entry.keyword));
  const activeKeywords = uniqueStrings([...retryKeywords, ...discipline.keywords]);

  log(`[DISCIPLINE] ${discipline.id}: fetching papers`);
  let fetchResult = { papers: [], source: null };
  try {
    fetchResult = await fetchPapers(activeKeywords, {
      limit: papersPerQuery,
      minYear: Number(options.minYear || process.env.MIN_PAPER_YEAR || 2020)
    });
  } catch (error) {
    log(`[DISCIPLINE] ${discipline.id}: fetch warning — ${error.message}`);
    writeFailedKeywords(discipline.id, {
      failedKeywords: activeKeywords.map((keyword) => ({
        keyword,
        reason: error.message,
        lastFailedAtIso: new Date().toISOString()
      }))
    });
    runMeta.completedAtIso = new Date().toISOString();
    runMeta.session = null;
    runMeta.papersFetched = 0;
    runMeta.publishedCount = 0;
    runMeta.source = null;
    writeJSON(paths.latestRunFile, {
      ...runMeta,
      status: 'skipped',
      reason: 'paper_fetch_failed'
    });
    const summary = summarizeDiscipline(discipline, readDisciplineGaps(discipline.id), runMeta);
    writeJSON(paths.summaryFile, summary);
    updateGlobalDisciplineIndex(discipline, summary, runMeta);
    return {
      discipline,
      runId,
      papersFetched: 0,
      findingsCreated: 0,
      discoveries: 0,
      published: 0,
      skipped: true,
      skipReason: error.message,
      source: null,
      summary,
      publishedGaps: []
    };
  }
  const papers = fetchResult.papers || [];
  const paperSource = fetchResult.source || null;
  if (papers.length < minPaperCount) {
    const reason = `minimum_${minPaperCount}_papers_required`;
    log(`[DISCIPLINE] ${discipline.id}: skip — ${papers.length} papers gevonden, minimum ${minPaperCount}`);
    writeFailedKeywords(discipline.id, {
      failedKeywords: activeKeywords.map((keyword) => ({
        keyword,
        reason,
        lastFailedAtIso: new Date().toISOString()
      }))
    });
    runMeta.completedAtIso = new Date().toISOString();
    runMeta.session = null;
    runMeta.papersFetched = papers.length;
    runMeta.publishedCount = 0;
    runMeta.source = paperSource;
    writeJSON(paths.latestRunFile, {
      ...runMeta,
      status: 'skipped',
      reason
    });
    const summary = summarizeDiscipline(discipline, readDisciplineGaps(discipline.id), runMeta);
    writeJSON(paths.summaryFile, summary);
    updateGlobalDisciplineIndex(discipline, summary, runMeta);
    return {
      discipline,
      runId,
      papersFetched: papers.length,
      findingsCreated: 0,
      discoveries: 0,
      published: 0,
      skipped: true,
      skipReason: reason,
      source: paperSource,
      summary,
      publishedGaps: []
    };
  }
  writeFailedKeywords(discipline.id, { failedKeywords: [] });

  log(`[DISCIPLINE] ${discipline.id}: running researcher session`);
  const session = await runResearchSession({
    domain: discipline.id,
    maxFindings,
    keywords: activeKeywords
  });

  const findingData = readFindings();
  const findingsList = Array.isArray(findingData?.findings) ? findingData.findings : [];
  const findingsMap = new Map(
    findingsList
      .filter(Boolean)
      .map((finding) => [finding.id, finding])
  );

  const sourceFindings = (session.findingIds || [])
    .map((id) => findingsMap.get(id))
    .filter(Boolean)
    .filter((finding) => finding.type === 'discovery');

  const scored = sourceFindings.map((finding) => {
    const stored = buildStoredGap(finding, discipline, papers, runId);
    const quality = qualifiesForPublication(finding, {
      minPublishScore
    });
    return {
      stored,
      quality
    };
  });

  const published = scored
    .filter((entry) => entry.stored.score >= minPublishScore && entry.quality.ok)
    .sort((left, right) => Number(right.stored.score || 0) - Number(left.stored.score || 0))
    .slice(0, maxFindings)
    .map((entry) => entry.stored);

  for (const gap of published) {
    upsertDisciplineGap(discipline, gap);
    recordCharge('gap');
  }

  const completedAtIso = new Date().toISOString();
  runMeta.completedAtIso = completedAtIso;
  runMeta.papersFetched = papers.length;
  runMeta.session = session;
  runMeta.publishedCount = published.length;
  runMeta.source = paperSource;
  writeJSON(path.join(paths.runsDir, `${runId}.json`), {
    ...runMeta,
    papers,
    published
  });
  writeJSON(paths.latestRunFile, runMeta);

  const allGaps = readDisciplineGaps(discipline.id);
  const summary = summarizeDiscipline(discipline, allGaps, runMeta);
  writeJSON(paths.summaryFile, summary);
  updateGlobalDisciplineIndex(discipline, summary, runMeta);
  const globalIndex = readDisciplineIndex();
  const queueSize = Array.isArray(globalIndex.disciplines)
    ? globalIndex.disciplines.reduce((sum, entry) => sum + Math.max(0, Number(entry.gapCount || 0)), 0)
    : 0;
  updateQueueSize(queueSize);

  return {
    discipline,
    runId,
    papersFetched: papers.length,
    findingsCreated: session.findingsCreated,
    discoveries: session.discoveries,
    published: published.length,
    source: paperSource,
    summary,
    publishedGaps: published
  };
}

async function runAllDisciplines(options = {}) {
  const selected = options.disciplineId
    ? disciplines.filter((discipline) => discipline.id === options.disciplineId)
    : disciplines.slice();
  const runResults = [];
  for (let index = 0; index < selected.length; index += 1) {
    const discipline = selected[index];
    try {
      runResults.push(await runDisciplineTick(discipline, options));
    } catch (error) {
      const message = error?.message || String(error);
      console.error(`[DISCIPLINE-RUNNER] ${discipline.id}: tick failed — ${message}`);
      runResults.push({
        discipline,
        runId: `${discipline.id}-${Date.now()}`,
        papersFetched: 0,
        findingsCreated: 0,
        discoveries: 0,
        published: 0,
        skipped: true,
        skipReason: message,
        source: null,
        summary: readDisciplineSummary(discipline.id),
        publishedGaps: []
      });
    }
    if (index < selected.length - 1) {
      await sleep(Number(options.interDisciplineDelayMs || 30000));
    }
  }
  return runResults;
}

function getDisciplineById(disciplineId) {
  return disciplines.find((discipline) => discipline.id === disciplineId) || null;
}

function readDisciplineSummary(disciplineId) {
  return readJSON(disciplinePaths(disciplineId).summaryFile, null);
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const disciplineIndex = args.indexOf('--discipline');
  const disciplineId = disciplineIndex !== -1 ? args[disciplineIndex + 1] : null;
  const intervalMs = Number(process.env.TICK_INTERVAL_MS || 600000);

  if (disciplineId && !getDisciplineById(disciplineId)) {
    throw new Error(`Unknown discipline: ${disciplineId}`);
  }

  do {
    try {
      const results = await runAllDisciplines({
        once,
        disciplineId,
        maxFindings: Number(process.env.MAX_GAPS_PER_DISCIPLINE || 20)
      });
      console.log(JSON.stringify({
        ok: true,
        disciplines: results.map((result) => ({
          id: result.discipline.id,
          papersFetched: result.papersFetched,
          discoveries: result.discoveries,
          published: result.published
        }))
      }, null, 2));
    } catch (error) {
      console.error(`[DISCIPLINE-RUNNER] loop failed — ${error?.message || error}`);
    }
    if (once) break;
    await sleep(intervalMs);
  } while (true);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[DISCIPLINE-RUNNER] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  disciplines,
  getDisciplineById,
  readDisciplineGap,
  readDisciplineGaps,
  readDisciplineIndex,
  readDisciplineSummary,
  runAllDisciplines,
  runDisciplineTick
};
