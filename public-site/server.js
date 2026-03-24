/**
 * CLASHD27 — Public Site Server
 * Serves the public-facing gap catalogus on port 3028
 * Reads the same data/*.json files as the dashboard
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getDomainById, listDomains, toRunnerDomain } from '../src/domains/domain-registry.js';

const require = createRequire(import.meta.url);
const path = require('path');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const express = require('express');
const fs = require('fs');
const Module = require('module');
const { exportGapToPDF } = require('../lib/pdf-exporter');
let dotenv = null;
const LEGACY_JS_LOADER = Module._extensions['.js'];
const LEGACY_MODULE_ROOTS = [];
try { dotenv = require('dotenv'); } catch (_) { dotenv = null; }

const DEFAULT_SERVER_ENV_PATHS = [
  '/home/greenbanaanas/.secrets/clashd27.env',
  '/root/.secrets/clashd27.env',
  path.join(__dirname, '..', '.env')
];

function bootstrapPublicSiteEntrypoint() {
  for (const envPath of DEFAULT_SERVER_ENV_PATHS) {
    if (!envPath || !fs.existsSync(envPath) || !dotenv?.config) continue;
    dotenv.config({ path: envPath, override: true });
    console.log('[BOOT] entrypoint=public-site-server');
    console.log('[BOOT] canonical_runtime=canonical-runtime');
    console.log(`[BOOT] env_source=${envPath}`);
    return;
  }

  console.log('[BOOT] entrypoint=public-site-server');
  console.log('[BOOT] canonical_runtime=canonical-runtime');
}

function startClashd27SupportServer(app, options) {
  const port = Number(options.port);
  const label = String(options.label || 'PUBLIC').trim() || 'PUBLIC';
  const host = String(options.host || 'localhost').trim() || 'localhost';
  return app.listen(port, () => {
    console.log(`[${label}] Running on http://${host}:${port}`);
  });
}

bootstrapPublicSiteEntrypoint();

const app = express();
const PORT = process.env.PUBLIC_PORT || 3028;

const DATA_DIR = path.join(__dirname, '..', 'data');
const PACKS_DIR = path.join(__dirname, '..', 'packs');
LEGACY_MODULE_ROOTS.push(path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'lib'));
Module._extensions['.js'] = function clashd27LegacyLoader(moduleRef, filename) {
  if (LEGACY_MODULE_ROOTS.some((rootDir) => filename.startsWith(rootDir))) {
    const content = fs.readFileSync(filename, 'utf8');
    moduleRef._compile(content, filename);
    return;
  }
  return LEGACY_JS_LOADER(moduleRef, filename);
};
const { runDomainCycle } = require('../src/domains/domain-runner');
const { fetchPapers: fetchPapersForDomain } = require('../src/sources/paper-fetcher');
const { normalizeQueue } = require('../src/queue/signal-normalizer');
const { runDiscoveryCycle } = require('../lib/event-emitter');
const { GapLibrary } = require('../src/library/gap-library');
const { Clashd27CubeEngine } = require('../lib/clashd27-cube-engine');
const { getMetrics } = require('../lib/heat-charge-tracker');
const {
  disciplines,
  getDisciplineById,
  readDisciplineGap,
  readDisciplineGaps,
  readDisciplineIndex,
  readDisciplineSummary
} = require('../lib/discipline-runner');
const { PROPERTIES, getPropertyDescription } = require('../src/properties/property-classifier');

const OPENCLASHD_CORS_ORIGINS = new Set([
  'https://openclashd.com',
  'http://openclashd.com',
  'http://localhost:19001',
  'http://localhost:3028'
]);
const GAPS_DIR = path.join(DATA_DIR, 'gaps');
const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
const RESEARCH_JOB_STATE = new Map();

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function scoreToPercent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric <= 1) return Math.round(clamp(numeric, 0, 1) * 100);
  return Math.round(clamp(numeric, 0, 100));
}

function normalizePropertyName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ');
}

function matchPropertyName(name) {
  const normalized = normalizePropertyName(name);
  return Object.values(PROPERTIES).find((property) => normalizePropertyName(property.name) === normalized) || null;
}

function gapHasProperty(gap, propertyName) {
  if (!gap || !propertyName) return false;
  if (gap.property && normalizePropertyName(gap.property.name) === normalizePropertyName(propertyName)) {
    return true;
  }
  if (gap.dominantProperty && typeof gap.dominantProperty === 'object' && Number(gap.dominantProperty[propertyName] || 0) > 0) {
    return true;
  }
  if (Array.isArray(gap.paperProperties)) {
    return gap.paperProperties.some((paper) => normalizePropertyName(paper?.property?.name) === normalizePropertyName(propertyName));
  }
  return false;
}

function propertyCountsForGaps(gaps) {
  const counts = Object.fromEntries(Object.values(PROPERTIES).map((property) => [property.name, 0]));
  for (const gap of gaps || []) {
    for (const property of Object.values(PROPERTIES)) {
      if (gapHasProperty(gap, property.name)) {
        counts[property.name] += 1;
      }
    }
  }
  return counts;
}

function createJobState(domain) {
  const nowIso = new Date().toISOString();
  const jobId = `research-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const job = {
    jobId,
    domainId: domain.id,
    status: 'running',
    progress: 0,
    gapsFound: 0,
    currentPhase: 'queued',
    startedAt: nowIso,
    updatedAt: nowIso,
    error: null,
    result: null
  };
  RESEARCH_JOB_STATE.set(jobId, job);
  return job;
}

function updateJob(jobId, patch) {
  const job = RESEARCH_JOB_STATE.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, {
    updatedAt: new Date().toISOString()
  });
  RESEARCH_JOB_STATE.set(jobId, job);
  return job;
}

function readMutableGapIndex() {
  const index = readGapIndex();
  if (!Array.isArray(index.gaps)) {
    index.gaps = [];
  }
  return index;
}

function writeGapIndex(index) {
  writeJSON(path.join(GAPS_DIR, 'index.json'), {
    ...index,
    total: Array.isArray(index.gaps) ? index.gaps.length : 0,
    date: new Date().toISOString()
  });
}

function selectScoringTrace(packet) {
  if (!packet || typeof packet !== 'object') return null;
  return packet.scoringTrace || packet.scoreTrace || packet.scores || packet.candidate?.scoringTrace || null;
}

function toReferenceList(entry) {
  return (entry.papers || []).slice(0, 10).map((paper) => {
    const title = String(paper.title || '').trim();
    const source = String(paper.source || '').trim();
    const url = String(paper.url || '').trim();
    return [title, source ? `(${source})` : '', url].filter(Boolean).join(' — ');
  });
}

function toEvidenceList(entry) {
  return (entry.papers || []).slice(0, 5).map((paper) => {
    const title = String(paper.title || '').trim();
    const authors = Array.isArray(paper.authors) && paper.authors.length > 0
      ? paper.authors.slice(0, 3).join(', ')
      : null;
    return [title, authors].filter(Boolean).join(' — ');
  });
}

function buildPublicGapDetail(entry, packet, domain, existingGap) {
  const finalScore = scoreToPercent(entry.score);
  const hypothesis = String(entry.hypothesis || entry.title || '').trim();
  const tags = uniqueStrings([
    ...(existingGap && Array.isArray(existingGap.tags) ? existingGap.tags : []),
    ...(entry.tags || []),
    domain.id
  ]);

  return {
    id: entry.gapId,
    title: entry.title,
    claim: hypothesis,
    hypothesis,
    score: finalScore,
    domainId: domain.id,
    domainLabel: domain.label,
    corridor: (entry.domains || []).join(' × ') || domain.label,
    date: String(entry.lastSeenAtIso || entry.discoveredAtIso || new Date().toISOString()).slice(0, 10),
    discoveredAtIso: entry.discoveredAtIso || null,
    lastSeenAtIso: entry.lastSeenAtIso || null,
    status: entry.status || 'open',
    tags,
    cells: entry.cells || [],
    cubeConfig: domain.cubeConfig,
    sourcePapers: (entry.papers || []).slice(0, 10),
    evidence: toEvidenceList(entry),
    references: toReferenceList(entry),
    proposed_experiment: packet && Array.isArray(packet.verificationPlan)
      ? packet.verificationPlan.map((step) => String(step || '').trim()).filter(Boolean).join(' ')
      : null,
    risks: packet && Array.isArray(packet.killConditions)
      ? packet.killConditions.map((risk) => String(risk || '').trim()).filter(Boolean)
      : [],
    scoring: {
      finalScore,
      total: Number(entry.score || 0),
      rawScore: Number(entry.score || 0),
      trace: selectScoringTrace(packet)
    },
    operatorTune: existingGap && existingGap.operatorTune ? existingGap.operatorTune : null
  };
}

function upsertPublicGap(detail) {
  const filePath = path.join(GAPS_DIR, `${detail.id}.json`);
  const existingGap = readJSON(filePath) || null;
  const nextGap = {
    ...(existingGap || {}),
    ...detail,
    operatorTune: detail.operatorTune || (existingGap && existingGap.operatorTune) || null,
    updatedAtIso: new Date().toISOString()
  };

  writeJSON(filePath, nextGap);

  const index = readMutableGapIndex();
  const summary = {
    id: nextGap.id,
    title: nextGap.title,
    claim: nextGap.claim,
    score: nextGap.score,
    corridor: nextGap.corridor,
    domainId: nextGap.domainId,
    domainLabel: nextGap.domainLabel,
    date: nextGap.date,
    status: nextGap.status,
    tags: nextGap.tags || []
  };
  const existingIndex = index.gaps.findIndex((gap) => gap.id === nextGap.id);
  if (existingIndex >= 0) {
    index.gaps[existingIndex] = {
      ...index.gaps[existingIndex],
      ...summary
    };
  } else {
    index.gaps.push(summary);
  }
  index.gaps.sort((left, right) => (right.score || 0) - (left.score || 0));
  writeGapIndex(index);
  return nextGap;
}

function persistDomainRunGaps(result, domain) {
  const packetLookup = new Map();
  for (const packet of result.packets || []) {
    if (packet && packet.packetId) packetLookup.set(packet.packetId, packet);
    if (packet && packet.gapId) packetLookup.set(packet.gapId, packet);
  }

  const stored = [];
  for (const update of result.packetUpdates || []) {
    if (!update || !update.entry) continue;
    const entry = update.entry;
    const existingGap = readGapById(entry.gapId);
    const sourceIds = Array.isArray(entry.sourcePacketIds) ? entry.sourcePacketIds : [];
    const packet = packetLookup.get(entry.gapId) || sourceIds.map((id) => packetLookup.get(id)).find(Boolean) || null;
    const detail = buildPublicGapDetail(entry, packet, domain, existingGap);
    stored.push(upsertPublicGap(detail));
  }
  return stored;
}

function sanitizeTunePayload(body = {}) {
  const adjustedScore = body.adjustedScore;
  return {
    adjustedScore: Number.isFinite(Number(adjustedScore)) ? Number(adjustedScore) : null,
    notes: String(body.notes || '').trim(),
    tags: Array.isArray(body.tags) ? uniqueStrings(body.tags) : [],
    priority: ['high', 'medium', 'low'].includes(body.priority) ? body.priority : 'medium',
    updatedAtIso: new Date().toISOString()
  };
}

async function runResearchJob(job, domain) {
  try {
    updateJob(job.jobId, {
      currentPhase: 'initializing',
      progress: 0.05
    });

    const runnerDomain = toRunnerDomain(domain);
    const library = new GapLibrary();
    const cubeEngine = new Clashd27CubeEngine({
      persist: false
    });

    const result = await runDomainCycle(runnerDomain, cubeEngine, {
      runId: job.jobId,
      library,
      papersPerQuery: runnerDomain.cubeConfig.depth === 'high' ? 50 : 30,
      fetchPapers: async (fetchOptions) => {
        updateJob(job.jobId, {
          currentPhase: 'fetching_papers',
          progress: 0.2
        });
        const papers = await fetchPapersForDomain(fetchOptions);
        updateJob(job.jobId, {
          currentPhase: 'extracting_signals',
          progress: 0.45
        });
        return papers;
      },
      normalizeQueue: (queue, options) => {
        updateJob(job.jobId, {
          currentPhase: 'normalizing_signals',
          progress: 0.65
        });
        return normalizeQueue(queue, options);
      },
      runDiscoveryCycle: (engine, options) => {
        updateJob(job.jobId, {
          currentPhase: 'discovering_gaps',
          progress: 0.85
        });
        return runDiscoveryCycle(engine, options);
      },
      log: () => {}
    });

    const storedGaps = persistDomainRunGaps(result, domain);
    updateJob(job.jobId, {
      status: 'completed',
      currentPhase: 'completed',
      progress: 1,
      gapsFound: storedGaps.length,
      result: {
        papersAnalyzed: result.papersAnalyzed,
        signalsGenerated: result.signalsGenerated,
        normalizedSignals: result.normalizedSignals,
        gapsFound: storedGaps.length
      }
    });
  } catch (error) {
    updateJob(job.jobId, {
      status: 'failed',
      currentPhase: 'failed',
      progress: 1,
      error: error.message
    });
  }
}

// --- Data Readers ---
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error(`[PUBLIC] Read failed ${filePath}: ${e.message}`);
  }
  return null;
}

function readFindings() {
  const data = readJSON(path.join(DATA_DIR, 'findings.json'));
  return (data && data.findings) || [];
}

function readDeepDives() {
  const data = readJSON(path.join(DATA_DIR, 'deep-dives.json'));
  return (data && data.dives) || [];
}

function readVerifications() {
  const data = readJSON(path.join(DATA_DIR, 'verifications.json'));
  return (data && data.verifications) || [];
}

function readValidations() {
  const data = readJSON(path.join(DATA_DIR, 'validations.json'));
  return (data && data.validations) || [];
}

function readMetrics() {
  return readJSON(path.join(DATA_DIR, 'metrics.json')) || {};
}

function readState() {
  return readJSON(path.join(DATA_DIR, 'state.json'));
}

function readCube() {
  return readJSON(path.join(DATA_DIR, 'cube.json'));
}

function readGapIndex() {
  return readJSON(path.join(DATA_DIR, 'gaps', 'index.json')) || { gaps: [], total: 0, date: null };
}

function readGapById(id) {
  return readJSON(path.join(DATA_DIR, 'gaps', `${id}.json`));
}

function readAnyGapById(id) {
  const directGap = readGapById(id);
  if (directGap) return directGap;
  for (const discipline of disciplines) {
    const gap = readDisciplineGap(discipline.id, id);
    if (gap) return gap;
  }
  return null;
}

function filterDisciplineGaps(gaps, options = {}) {
  const minScore = Number(options.minScore || 0.8);
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 10, 1), 100);
  const sort = String(options.sort || 'score');
  let filtered = (gaps || []).filter((gap) => Number(gap.score || 0) >= minScore);
  if (sort === 'date') {
    filtered = filtered.sort((left, right) => String(right.createdAtIso || '').localeCompare(String(left.createdAtIso || '')));
  } else {
    filtered = filtered.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  }
  return filtered.slice(0, limit);
}

function renderDisciplineGapPrintPage(discipline, gap) {
  const references = (gap.sourcePapers || []).map((paper) =>
    `<li>${paper.title}${paper.source ? ` <span>(${paper.source})</span>` : ''}</li>`
  ).join('');
  const scoringTrace = gap.scoringTrace
    ? `<pre>${JSON.stringify(gap.scoringTrace, null, 2)}</pre>`
    : '<p>Geen scoring trace beschikbaar.</p>';
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <title>${gap.title}</title>
  <style>
    :root { color-scheme: light; --ink: #122033; --muted: #617086; --line: #dce3ec; --card: #ffffff; --accent: ${discipline.color}; }
    body { font-family: "Avenir Next", "Segoe UI", sans-serif; background: #f5f7fb; color: var(--ink); margin: 0; padding: 32px; }
    main { max-width: 820px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 24px; padding: 32px; box-shadow: 0 14px 40px rgba(18,32,51,0.08); }
    h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.1; }
    p, li { font-size: 16px; line-height: 1.6; }
    .meta { color: var(--muted); margin-bottom: 24px; }
    .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(0,0,0,0.05); margin-right: 8px; }
    .score { background: ${discipline.color}; color: #fff; }
    section { margin-top: 28px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f0f4fa; padding: 16px; border-radius: 16px; overflow: hidden; }
    ul { padding-left: 20px; }
  </style>
</head>
<body>
  <main>
    <div class="badge score">Score ${Number(gap.score || 0).toFixed(3)}</div>
    <div class="badge">${discipline.label}</div>
    <h1>${gap.title}</h1>
    <p class="meta">${gap.createdAtIso || ''}</p>
    <section>
      <h2>Hypothese</h2>
      <p>${gap.hypothesis || ''}</p>
    </section>
    <section>
      <h2>Bridge</h2>
      <p>${gap.bridge && gap.bridge.claim ? gap.bridge.claim : 'Geen bridge claim beschikbaar.'}</p>
    </section>
    <section>
      <h2>Validation path</h2>
      <p>${gap.cheapestValidation && gap.cheapestValidation.method ? gap.cheapestValidation.method : 'Niet beschikbaar.'}</p>
    </section>
    <section>
      <h2>Bronpapers</h2>
      <ul>${references || '<li>Geen bronpapers beschikbaar.</li>'}</ul>
    </section>
    <section>
      <h2>Scoring trace</h2>
      ${scoringTrace}
    </section>
  </main>
</body>
</html>`;
}

function readSurpriseDist() {
  return readJSON(path.join(DATA_DIR, 'surprise-dist.json')) || { days: {} };
}

function listPacks() {
  try {
    return fs.readdirSync(PACKS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
          return { id: pack.id, name: pack.name, description: pack.description };
        } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) { return []; }
}

// --- Enrich findings with verification/validation data ---
function enrichDiscoveries(findings) {
  const dives = readDeepDives();
  const verifications = readVerifications();
  const validations = readValidations();

  const diveMap = {};
  for (const d of dives) diveMap[d.discovery_id] = d;
  const verMap = {};
  for (const v of verifications) verMap[v.discovery_id] = v;
  const valMap = {};
  for (const v of validations) valMap[v.discovery_id] = v;

  return findings.map(f => {
    const dive = diveMap[f.id];
    const ver = verMap[f.id];
    const val = valMap[f.id];

    const enriched = { ...f };

    if (dive) {
      enriched.deepDive = dive;
      enriched.diveScore = dive.scores?.total || 0;
    }
    if (ver) {
      enriched.verification = ver;
      enriched.gptVerdict = ver.gpt_verdict || ver.verdict || null;
    }
    if (val) {
      enriched.validation = val;
      enriched.nihFunding = val.nih_funding || null;
      enriched.euFunding = val.eu_funding || null;
      enriched.feasibility = val.overall_feasibility || null;
    }

    // Compute gap quality score
    let gapQuality = 0;
    let checks = 0;
    if (f.abc_chain && f.abc_chain.length >= 2) { gapQuality += 15; checks++; }
    if (f.bridge && f.bridge.claim) { gapQuality += 15; checks++; }
    if (f.kill_test) { gapQuality += 15; checks++; }
    if (f.supporting_sources && f.supporting_sources.length > 0) { gapQuality += 10; checks++; }
    if (f.clinical_relevance) { gapQuality += 10; checks++; }
    if (dive && dive.scores?.total >= 70) { gapQuality += 15; checks++; }
    if (ver && (ver.gpt_verdict === 'CONFIRMED' || ver.verdict === 'CONFIRMED')) { gapQuality += 20; checks++; }

    enriched.gapQualityScore = Math.min(100, gapQuality);

    // Source credibility from dive
    enriched.sourceCredibilityScore = dive?.scores?.total || 0;

    // Research-ready badge
    enriched.researchReady = enriched.gapQualityScore >= 70 && enriched.sourceCredibilityScore >= 70;

    return enriched;
  });
}

function getValidatedGaps() {
  const idx = readGapIndex();
  return idx.gaps || [];
}

// --- In-memory cache (30s TTL) ---
const _cache = {};
function cached(key, ttlMs, fn) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  try {
    const data = fn();
    _cache[key] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    return entry ? entry.data : null;
  }
}

function applyOpenclashdCors(req, res) {
  const origin = req.get('Origin');
  if (origin && OPENCLASHD_CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
}

// --- Public API endpoints (read-only, safe) ---
app.get('/api/public/summary', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const result = cached('summary', 30000, () => {
      const gaps = getValidatedGaps();
      const metrics = readMetrics();
      const state = readState();
      const dist = readSurpriseDist();
      const dayKeys = Object.keys(dist.days || {}).sort().slice(-7);
      const papers7d = dayKeys.reduce((sum, k) => {
        const d = dist.days[k];
        return sum + ((d?.y0 || 0) + (d?.y1 || 0) + (d?.y2 || 0));
      }, 0);
      const corridors = new Set(gaps.map(g => g.corridor || 'unknown'));
      const today = new Date().toISOString().slice(0, 10);
      const gaps7d = gaps.filter(g => {
        if (!g.date) return false;
        const diff = (new Date(today) - new Date(g.date)) / 86400000;
        return diff >= 0 && diff < 7;
      }).length;
      const lastGap = gaps.length > 0
        ? gaps.reduce((latest, g) => (!latest || (g.date || '') > (latest.date || '')) ? g : latest).date || null
        : null;
      return {
        totalGaps: gaps.length,
        gaps7d,
        papers7d: papers7d || null,
        corridorsCount: corridors.size,
        lastGapDate: lastGap,
        lastUpdated: new Date().toISOString(),
        tick: state?.tick || 0
      };
    });
    res.json(result || { totalGaps: 0, gaps7d: 0, papers7d: null, corridorsCount: 0, lastGapDate: null, lastUpdated: new Date().toISOString(), tick: 0 });
  } catch (e) {
    res.json({ totalGaps: 0, gaps7d: 0, papers7d: null, corridorsCount: 0, lastGapDate: null, lastUpdated: new Date().toISOString(), tick: 0 });
  }
});

app.get('/api/public/latest', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = cached('latest_' + limit, 30000, () => {
      const gaps = getValidatedGaps();
      const sorted = [...gaps].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return sorted.slice(0, limit).map(g => ({
        id: g.id,
        date: g.date || null,
        corridor: g.corridor || 'Cross-domain',
        score: g.score || 0,
        claim: g.claim || ''
      }));
    });
    res.json(result || []);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/public/featured', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const result = cached('featured', 30000, () => {
      const gaps = getValidatedGaps();
      if (gaps.length === 0) return null;
      const today = new Date().toISOString().slice(0, 10);
      const todayGaps = gaps.filter(g => g.date === today);
      const pool = todayGaps.length > 0 ? todayGaps : gaps;
      const best = pool.reduce((top, g) => (!top || (g.score || 0) > (top.score || 0)) ? g : top, null);
      if (!best) return null;
      const detail = readGapById(best.id);
      return {
        id: best.id,
        date: best.date || null,
        corridor: best.corridor || 'Cross-domain',
        score: best.score || 0,
        claim: best.claim || '',
        evidence: (detail?.evidence || []).slice(0, 3),
        proposed_experiment: detail?.proposed_experiment || null,
        scoring: detail?.scoring || null
      };
    });
    res.json(result || { id: null });
  } catch (e) {
    res.json({ id: null });
  }
});

app.get('/api/public/leaderboard', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const result = cached('leaderboard_' + limit, 30000, () => {
      const gaps = getValidatedGaps();
      const agg = {};
      for (const gap of gaps) {
        const repos = Array.isArray(gap.repos) ? gap.repos : [];
        for (const repo of repos) {
          const key = (repo.repo || '').toLowerCase();
          if (!key) continue;
          if (!agg[key]) agg[key] = { repo: key, gapCount: 0, open: 0, responded: 0, resolved: 0 };
          agg[key].gapCount++;
          if (gap.status === 'resolved') agg[key].resolved++;
          else if (gap.status === 'responded') agg[key].responded++;
          else agg[key].open++;
        }
      }
      return Object.values(agg)
        .sort((a, b) => b.gapCount - a.gapCount)
        .slice(0, limit);
    });
    res.json(result || []);
  } catch (e) {
    res.json([]);
  }
});

app.use(express.json());

app.get('/api/health/charge-ratio', (req, res) => {
  applyOpenclashdCors(req, res);
  res.set('Cache-Control', 'public, max-age=30');
  const metrics = getMetrics();
  res.json({
    ok: true,
    chargeRatio: Number(metrics.chargeRatio || 0),
    status: metrics.status || 'ALARM',
    heat: Number(metrics.heat || 0),
    charge: Number(metrics.charge || 0),
    publishedGaps: Number(metrics.publishedGaps || 0),
    approvedProposals: Number(metrics.approvedProposals || 0),
    totalRuns: Number(metrics.totalRuns || 0),
    queueSize: Number(metrics.queueSize || 0),
    queueAlarm: Boolean(metrics.queueAlarm),
    lastUpdated: metrics.lastUpdated || null,
    recommendation:
      Number(metrics.chargeRatio || 0) < 0.05
        ? 'Verhoog publicatiedrempel'
        : Number(metrics.chargeRatio || 0) > 0.30
          ? 'Systeem convergeert goed'
          : 'Normaal — blijf monitoren'
  });
});

app.get('/api/research/domains', (req, res) => {
  res.json({
    domains: listDomains()
  });
});

app.post('/api/research/start', (req, res) => {
  const domainId = String(req.body?.domainId || '').trim();
  const domain = getDomainById(domainId);

  if (!domain) {
    return res.status(404).json({ error: 'Unknown domainId' });
  }

  const job = createJobState(domain);
  runResearchJob(job, domain);

  return res.status(202).json({
    jobId: job.jobId,
    domainId: domain.id,
    status: job.status,
    startedAt: job.startedAt
  });
});

app.get('/api/research/status/:jobId', (req, res) => {
  const job = RESEARCH_JOB_STATE.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json({
    status: job.status,
    progress: job.progress,
    gapsFound: job.gapsFound,
    currentPhase: job.currentPhase,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    error: job.error
  });
});

app.get('/api/disciplines', (req, res) => {
  const index = readDisciplineIndex();
  const records = Array.isArray(index.disciplines) ? index.disciplines : [];
  const result = disciplines.map((discipline) => {
    const record = records.find((entry) => entry.id === discipline.id) || {};
    return {
      id: discipline.id,
      label: discipline.label,
      color: discipline.color,
      gapCount: Number(record.gapCount || 0),
      lastRun: record.lastRun || null,
      topScore: Number(record.topScore || 0)
    };
  });
  res.json(result);
});

app.get('/api/disciplines/:id/gaps', (req, res) => {
  const discipline = getDisciplineById(req.params.id);
  if (!discipline) {
    return res.status(404).json({ error: 'Discipline not found' });
  }
  const gaps = readDisciplineGaps(discipline.id);
  return res.json(filterDisciplineGaps(gaps, req.query));
});

app.get('/api/disciplines/:id/gaps/:gapId', (req, res) => {
  const discipline = getDisciplineById(req.params.id);
  if (!discipline) {
    return res.status(404).json({ error: 'Discipline not found' });
  }
  const gap = readDisciplineGap(discipline.id, req.params.gapId);
  if (!gap) {
    return res.status(404).json({ error: 'Gap not found' });
  }
  return res.json(gap);
});

app.get('/disciplines/:id/gaps/:gapId/print', (req, res) => {
  const discipline = getDisciplineById(req.params.id);
  if (!discipline) {
    return res.status(404).send('Discipline not found');
  }
  const gap = readDisciplineGap(discipline.id, req.params.gapId);
  if (!gap) {
    return res.status(404).send('Gap not found');
  }
  return res.type('html').send(renderDisciplineGapPrintPage(discipline, gap));
});

app.get('/api/disciplines/:id/gaps/:gapId/pdf', async (req, res) => {
  const discipline = getDisciplineById(req.params.id);
  if (!discipline) {
    return res.status(404).json({ error: 'Discipline not found' });
  }
  const gap = readDisciplineGap(discipline.id, req.params.gapId);
  if (!gap) {
    return res.status(404).json({ error: 'Gap not found' });
  }
  const outputPath = path.join(EXPORTS_DIR, `${discipline.id}-${gap.id}.pdf`);
  try {
    await exportGapToPDF(gap.id, outputPath, {
      port: PORT,
      routePath: `/disciplines/${encodeURIComponent(discipline.id)}/gaps/${encodeURIComponent(gap.id)}/print`
    });
    res.setHeader('Content-Type', 'application/pdf');
    return res.download(outputPath, `${discipline.id}-${gap.id}.pdf`);
  } catch (error) {
    return res.status(500).json({ error: 'PDF export failed', details: error.message });
  }
});

app.get('/api/disciplines/:id/summary', (req, res) => {
  const discipline = getDisciplineById(req.params.id);
  if (!discipline) {
    return res.status(404).json({ error: 'Discipline not found' });
  }
  const summary = readDisciplineSummary(discipline.id);
  if (!summary) {
    return res.json({
      discipline,
      totalGaps: 0,
      avgScore: 0,
      topGap: null,
      lastUpdated: null,
      topKeywords: [],
      trendingTopics: []
    });
  }
  return res.json(summary);
});

app.post('/api/public/subscribe', (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const subsFile = path.join(DATA_DIR, 'subscribers.json');
    let subs = [];
    try {
      if (fs.existsSync(subsFile)) {
        subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
      }
    } catch (e) { subs = []; }
    if (!Array.isArray(subs)) subs = [];
    if (subs.some(s => s.email === email)) {
      return res.json({ ok: true, message: 'Already subscribed' });
    }
    if (subs.length > 10000) {
      return res.status(429).json({ error: 'Subscriber limit reached' });
    }
    subs.push({ email, subscribedAt: new Date().toISOString(), ip: req.ip });
    const tmp = subsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(subs, null, 2));
    fs.renameSync(tmp, subsFile);
    res.json({ ok: true, message: 'Subscribed' });
  } catch (e) {
    res.status(500).json({ error: 'Subscribe failed' });
  }
});

// --- Static files ---
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));

// --- HTML Pages ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/gaps', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gaps.html'));
});

app.get('/gaps/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gap.html'));
});

app.get('/disciplines', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'disciplines.html'));
});

app.get('/gap-summary/:disciplineId/:gapId', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gap-summary.html'));
});

app.get('/audit/:name/pdf', (req, res) => {
  const slug = String(req.params.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const pdfPath = path.join(DATA_DIR, 'audit', `CLASHD27-Audit-${slug}.pdf`);
  if (!fs.existsSync(pdfPath)) {
    res.status(404).json({ error: 'Audit PDF not found.' });
    return;
  }
  res.download(pdfPath, path.basename(pdfPath));
});

app.get('/audit/:name', (req, res) => {
  const slug = String(req.params.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const viewPath = path.join(__dirname, 'views', `audit-${slug}.html`);
  if (!fs.existsSync(viewPath)) {
    res.status(404).send('Audit not found.');
    return;
  }
  res.sendFile(viewPath);
});

app.get('/gaps/domain/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gaps.html'));
});

app.get('/method', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'method.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'leaderboard.html'));
});

app.get('/properties', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'properties.html'));
});

// --- JSON API ---
app.get('/api/gaps', (req, res) => {
  applyOpenclashdCors(req, res);
  res.set('Cache-Control', 'public, max-age=60');
  const domain = req.query.domain || null;
  const method = req.query.method || null;
  const surprise = req.query.surprise || null;
  const source = req.query.source || null;
  const sort = req.query.sort || 'score';
  const days = parseInt(req.query.days, 10) || null;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = (req.query.search || '').toLowerCase();

  let gaps = getValidatedGaps();

  if (domain) {
    gaps = gaps.filter(g => (g.corridor || '').toLowerCase().includes(domain.toLowerCase()));
  }
  if (method) {
    gaps = gaps.filter(g => (g.methodAxis || '') === method);
  }
  if (surprise) {
    gaps = gaps.filter(g => (g.surpriseBucket || '') === surprise);
  }
  if (source) {
    gaps = gaps.filter(g => (g.sources || []).includes(source));
  }
  if (search) {
    gaps = gaps.filter(g => {
      const text = `${g.claim || ''} ${g.corridor || ''}`.toLowerCase();
      return text.includes(search);
    });
  }
  if (days && days > 0) {
    const cutoff = Date.now() - (days * 86400000);
    gaps = gaps.filter(g => {
      const stamp = g.discoveredAtIso || g.lastSeenAtIso || g.date;
      if (!stamp) return false;
      const time = new Date(stamp).getTime();
      return Number.isFinite(time) && time >= cutoff;
    });
  }

  if (sort === 'date') {
    gaps.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  } else if (sort === 'domain') {
    gaps.sort((a, b) => (a.corridor || '').localeCompare(b.corridor || ''));
  }
  // default: already sorted by score

  const total = gaps.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paged = gaps.slice(start, start + limit);

  res.json({ gaps: paged, total, page, totalPages });
});

app.get('/api/properties', (req, res) => {
  applyOpenclashdCors(req, res);
  const gaps = getValidatedGaps()
    .map((summary) => readAnyGapById(summary.id) || summary);
  const counts = propertyCountsForGaps(gaps);
  const properties = Object.values(PROPERTIES).map((property) => ({
    ...property,
    description: getPropertyDescription(property.name),
    gapCount: counts[property.name] || 0
  }));
  res.json(properties);
});

app.get('/api/properties/:name/description', (req, res) => {
  applyOpenclashdCors(req, res);
  const property = matchPropertyName(req.params.name);
  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }
  res.json({
    ...property,
    description: getPropertyDescription(property.name)
  });
});

app.get('/api/gaps/by-property/:propertyName', (req, res) => {
  applyOpenclashdCors(req, res);
  const property = matchPropertyName(req.params.propertyName);
  if (!property) {
    return res.status(404).json({ error: 'Property not found' });
  }

  const gaps = getValidatedGaps()
    .map((summary) => readAnyGapById(summary.id) || summary)
    .filter((gap) => gapHasProperty(gap, property.name))
    .sort((left, right) => Number((right.scoring && right.scoring.finalScore) || right.score || 0) - Number((left.scoring && left.scoring.finalScore) || left.score || 0));

  res.json(gaps);
});

app.get('/api/gaps/:id', (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const id = req.params.id;
  const gap = readAnyGapById(id);
  if (!gap) return res.status(404).json({ error: 'Gap not found' });
  res.json(gap);
});

app.post('/api/gaps/:id/tune', (req, res) => {
  const id = req.params.id;
  const gap = readGapById(id);
  if (!gap) {
    return res.status(404).json({ error: 'Gap not found' });
  }

  const operatorTune = sanitizeTunePayload(req.body);
  const updatedGap = {
    ...gap,
    operatorTune
  };
  writeJSON(path.join(GAPS_DIR, `${id}.json`), updatedGap);

  const index = readMutableGapIndex();
  const gapIndex = index.gaps.findIndex((entry) => entry.id === id);
  if (gapIndex >= 0) {
    index.gaps[gapIndex] = {
      ...index.gaps[gapIndex],
      tags: uniqueStrings([...(index.gaps[gapIndex].tags || []), ...operatorTune.tags])
    };
    writeGapIndex(index);
  }

  return res.json(updatedGap);
});

app.get('/api/gaps/:id/pdf', async (req, res) => {
  const id = req.params.id;
  const gap = readGapById(id);
  if (!gap) {
    return res.status(404).json({ error: 'Gap not found' });
  }

  const outputPath = path.join(EXPORTS_DIR, `${id}.pdf`);
  try {
    await exportGapToPDF(id, outputPath, {
      port: PORT
    });
    res.setHeader('Content-Type', 'application/pdf');
    return res.download(outputPath, `${id}.pdf`);
  } catch (error) {
    return res.status(500).json({
      error: 'PDF export failed',
      details: error.message
    });
  }
});

app.get('/api/stats', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  const gaps = getValidatedGaps();
  const metrics = readMetrics();
  const state = readState();
  const cube = readCube();
  const packs = listPacks();
  const dist = readSurpriseDist();
  const dayKeys = Object.keys(dist.days || {}).sort().slice(-7);
  const papers7d = dayKeys.reduce((sum, k) => {
    const d = dist.days[k];
    return sum + ((d?.y0 || 0) + (d?.y1 || 0) + (d?.y2 || 0));
  }, 0);
  const corridorsCovered = new Set(gaps.map(g => g.corridor || 'unknown')).size;

  const byDomain = {};
  for (const g of gaps) {
    const domain = g.corridor || 'unknown';
    byDomain[domain] = (byDomain[domain] || 0) + 1;
  }

  const avgScore = gaps.length > 0
    ? Math.round(gaps.reduce((s, g) => s + (g.score || 0), 0) / gaps.length)
    : 0;

  res.json({
    totalGaps: gaps.length,
    domains: packs.length,
    byDomain,
    avgGapQuality: avgScore,
    papers7d,
    corridorsCovered,
    tick: state?.tick || 0,
    cubePapers: cube?.totalPapers || 0,
    cubeGeneration: cube?.generation || 0,
    highValue: metrics.total_high_value || 0,
    totalDiscoveries: metrics.total_discoveries || 0,
    topGaps: gaps.slice(0, 3)
  });
});

// --- Start ---
startClashd27SupportServer(app, {
  label: 'PUBLIC',
  port: PORT
});
