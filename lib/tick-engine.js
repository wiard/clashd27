/**
 * CLASHD-27 — Tick Engine
 * EventEmitter-based tick pipeline extracted from bot.js.
 * Both bot.js (Discord) and engine.js (headless) consume this as thin wrappers.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { ENERGY, getActivePack, getCellLabel } = require('./state');
const {
  cellLabel, cellLabelShort, getLayerForCell, isCrossLayer,
} = require('./cube');
const {
  investigateCell, investigateBond, investigateDiscovery, investigateVerification,
  readFindings, queueFollowUps, isCircuitOpen, circuitBreakerWarn,
} = require('./researcher');
const { deepDive, readDeepDives, saveDeepDive } = require('./deep-dive');
const { verifyGap } = require('./verifier');
const { validateGap } = require('./validator');
const { checkSaturation } = require('./saturation');
const { screenCollision } = require('./screener');
const budget = require('./budget');
const { recordDailyCandidate, shouldQueueDeepDive, publishDailyGapsIfNeeded } = require('./gap-publisher');
const { recordGap } = require('./gap-index');

// ---------------------------------------------------------------------------
// Config constants (overridable via env)
// ---------------------------------------------------------------------------
const MIN_COLLISION_SCORE  = parseFloat(process.env.MIN_COLLISION_SCORE || '0.3');
const DEEP_DIVE_THRESHOLD  = parseInt(process.env.DEEP_DIVE_THRESHOLD || '75', 10);
const MAX_DEEP_DIVES_PER_DAY = parseInt(process.env.MAX_DEEP_DIVES_PER_DAY || '5', 10);
const VERIFIER_MIN_SCORE   = parseInt(process.env.VERIFIER_MIN_SCORE || '70', 10);
const QUEUE_TIMEOUT_MS     = 90_000;
const TICK_TIME_BUDGET_MS  = 240_000;
const SCORING_VERSION = 'v3';
const RUBRIC_VERSION = 'v1';
const CACHE_TTL_LOW_MS = 72 * 60 * 60 * 1000;
const CACHE_TTL_HIGH_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// File paths
// ---------------------------------------------------------------------------
const DATA_DIR         = path.join(__dirname, '..', 'data');
const QUEUES_FILE      = path.join(DATA_DIR, 'queues.json');
const TICK_LOCK_FILE   = path.join(DATA_DIR, '.tick.lock');
const METRICS_FILE     = path.join(DATA_DIR, 'metrics.json');
const FINDINGS_FILE    = path.join(DATA_DIR, 'findings.json');
const TICK_LOCK_STALE_MS = 10 * 60 * 1000;
const COLLISION_CACHE_FILE = path.join(DATA_DIR, 'collision-cache.json');

// ---------------------------------------------------------------------------
// Atomic findings helpers
// ---------------------------------------------------------------------------
function saveFindingsAtomic(data) {
  if (Array.isArray(data.findings) && data.findings.length > 1000) {
    data.findings = data.findings.slice(-1000);
  }
  const tmp = FINDINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FINDINGS_FILE);
}

function appendFinding(record) {
  const data = readFindings();
  data.findings.push(record);
  if (data.findings.length > 1000) data.findings = data.findings.slice(-1000);
  saveFindingsAtomic(data);
}

function updateFindingById(id, patch) {
  const data = readFindings();
  const idx = data.findings.findIndex(f => f.id === id);
  if (idx === -1) return;
  Object.assign(data.findings[idx], patch);
  saveFindingsAtomic(data);
}

// ---------------------------------------------------------------------------
// Review Pack Builder
// ---------------------------------------------------------------------------
function buildReviewPack(discovery) {
  const hypo = discovery.finding || discovery.hypothesis || discovery.discovery || '';
  const chain = (discovery.abc_chain || []).map(link => ({
    claim: link.claim || link.link || '',
    source: link.source || ''
  }));
  const bridge = discovery.bridge || {};
  const sat = discovery.saturation || {};
  const adj = discovery.adversarial_adjustment || {};
  const sources = chain.map(l => l.source).filter(Boolean);
  if (bridge.source) sources.push(bridge.source);
  return {
    title: hypo.length > 80 ? hypo.substring(0, 77) + '...' : hypo,
    one_sentence_hypothesis: hypo,
    abc_chain: chain.map(l => ({ claim: l.claim, source: l.source })),
    bridge: { claim: bridge.claim || '', source: bridge.source || '' },
    kill_test: discovery.kill_test || '',
    cheapest_validation: discovery.cheapest_validation || '',
    confounders: (discovery.confounders || []).slice(0, 2),
    saturation_summary: {
      paper_count_5y: sat.paper_estimate_5y || null,
      trial_count: typeof sat.trial_count === 'number' ? sat.trial_count : null,
      field_name_found: sat.established_field_name || null,
      saturation_score: typeof sat.field_saturation_score === 'number' ? sat.field_saturation_score : null
    },
    gpt_verdict_summary: adj.final_verdict || null,
    links: [...new Set(sources)]
  };
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------
function readMetrics() {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      return JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function isLegacyDiscovery(f) {
  if (f.type !== 'discovery') return false;
  return !f.abc_chain || !f.kill_test || !f.scores;
}

// ---------------------------------------------------------------------------
// Deterministic pairing + cache helpers
// ---------------------------------------------------------------------------
const RUBRICS = [
  { id: 'eval', label: 'Evaluation Gap', prompt: 'Focus on missing benchmarks, leakage, and metric mismatch.' },
  { id: 'robust', label: 'Robustness/OOD', prompt: 'Look for distribution shift, OOD fragility, adversarial failures.' },
  { id: 'safety', label: 'Safety/Alignment', prompt: 'Focus on jailbreaks, reward hacking, unintended behaviors.' },
  { id: 'data', label: 'Data/Contamination', prompt: 'Focus on data bias, contamination, synthetic data artifacts.' },
  { id: 'eff', label: 'Efficiency/Scaling', prompt: 'Focus on compute/memory bottlenecks and scaling laws.' },
  { id: 'systems', label: 'Systems/Deployment', prompt: 'Focus on latency, serving, tool use, integration gaps.' }
];

function daySeed() {
  return new Date().toISOString().slice(0, 10);
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleDeterministic(arr, seed) {
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function readCollisionCache() {
  try {
    if (fs.existsSync(COLLISION_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(COLLISION_CACHE_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return { entries: {} };
}

function writeCollisionCache(cache) {
  const tmp = COLLISION_CACHE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, COLLISION_CACHE_FILE);
}

function cacheKey(aId, bId, rubricId) {
  return `${aId}::${bId}::r${rubricId}::s${SCORING_VERSION}`;
}

function recomputeMetricsFromFindings(emitLog, emitError) {
  try {
    if (!fs.existsSync(FINDINGS_FILE)) return;
    const data = readFindings();
    const findings = data.findings || [];
    if (findings.length === 0) return;

    const countCell = findings.filter(f => f.type === 'cell').length;
    const allDiscoveries = findings.filter(f => f.type === 'discovery');
    const countDiscovery = allDiscoveries.length;
    const countDraft = findings.filter(f => f.type === 'draft').length;
    const countDup = findings.filter(f => f.type === 'duplicate').length;

    const attempts = findings.filter(f => f.type === 'attempt');
    const countAttempts = attempts.length;
    const countNoGap = attempts.filter(a => a.result && a.result.outcome === 'no_gap').length;
    const countErrors = attempts.filter(a => a.result && a.result.outcome === 'error').length;

    const legacyDiscoveries = allDiscoveries.filter(isLegacyDiscovery);
    const strictDiscoveries = allDiscoveries.filter(f => !isLegacyDiscovery(f));

    // Mark legacy discoveries in-place (one-time)
    let legacyUpdated = false;
    for (const f of allDiscoveries) {
      if (isLegacyDiscovery(f) && !f.legacy_format) {
        f.legacy_format = true;
        legacyUpdated = true;
      }
    }
    // Backfill attempt records for discoveries missing a linked attempt
    const attemptedDiscoveryIds = new Set(attempts.map(a => a.result && a.result.discovery_id).filter(Boolean));
    let attemptsBackfilled = 0;
    for (const d of allDiscoveries) {
      if (attemptedDiscoveryIds.has(d.id)) continue;
      const vFinal = (d.verdict && d.verdict.verdict) || d.verdict || '';
      const outcomeMap = { 'HIGH-VALUE GAP': 'high_value', 'CONFIRMED DIRECTION': 'confirmed_direction', 'NEEDS WORK': 'needs_work', 'LOW PRIORITY': 'low_priority' };
      const attemptId = `att-bf-${d.id}`;
      findings.push({
        id: attemptId,
        type: 'attempt',
        timestamp: d.timestamp || new Date().toISOString(),
        tick: d.tick || null,
        pair: { a: (d.agents && d.agents[0]) || 'unknown', b: (d.agents && d.agents[1]) || 'unknown' },
        domains: { domain_a: (d.cellLabels && d.cellLabels[0]) || '', domain_b: (d.cellLabels && d.cellLabels[1]) || '', meeting_cell: d.cellLabel || '' },
        result: { outcome: outcomeMap[vFinal] || 'discovery', reason: vFinal || 'discovery', discovery_id: d.id },
        backfilled: true
      });
      attemptedDiscoveryIds.add(d.id);
      attemptsBackfilled++;
    }

    if (legacyUpdated || attemptsBackfilled > 0) {
      saveFindingsAtomic(data);
      if (attemptsBackfilled > 0 && emitLog) emitLog('info', `[METRICS] Backfilled ${attemptsBackfilled} attempt records`);
    }

    // Verdict counts (all discoveries)
    let countHighValue = 0, countConfirmed = 0, countNeedsWork = 0, countLowPriority = 0;
    for (const d of allDiscoveries) {
      const vStr = (d.verdict && d.verdict.verdict) || d.verdict || '';
      if (vStr === 'HIGH-VALUE GAP') countHighValue++;
      else if (vStr === 'CONFIRMED DIRECTION') countConfirmed++;
      else if (vStr === 'NEEDS WORK') countNeedsWork++;
      else if (vStr === 'LOW PRIORITY') countLowPriority++;
    }

    // Strict averages
    let scoreSum = 0, bridgeSum = 0, specSum = 0, strictCount = 0;
    for (const d of strictDiscoveries) {
      if (d.scores && typeof d.scores.total === 'number') {
        scoreSum += d.scores.total;
        bridgeSum += d.scores.bridge || 0;
        strictCount++;
      }
      if (d.speculation_index && typeof d.speculation_index.leaps === 'number') {
        specSum += d.speculation_index.leaps;
      }
    }

    // GPT verification counts from verifications.json
    let gptReviewed = 0, gptConfirmed = 0, gptWeakened = 0, gptKilled = 0;
    try {
      const vFile = path.join(DATA_DIR, 'verifications.json');
      if (fs.existsSync(vFile)) {
        const vData = JSON.parse(fs.readFileSync(vFile, 'utf8'));
        const verifs = vData.verifications || [];
        gptReviewed = verifs.length;
        for (const v of verifs) {
          const gv = (v.gpt_verdict || '').toUpperCase();
          if (gv === 'CONFIRMED') gptConfirmed++;
          else if (gv === 'WEAKENED') gptWeakened++;
          else if (gv === 'KILLED') gptKilled++;
        }
      }
    } catch (e) { /* non-fatal */ }

    const m = readMetrics();
    const next = { ...m };
    next.total_cell_findings = countCell;
    next.total_discovery_attempts = countAttempts;
    next.total_no_gap = countNoGap;
    next.total_attempt_errors = countErrors;
    next.total_drafts = countDraft;
    next.total_duplicates = countDup;
    next.total_discoveries = countDiscovery;
    next.total_high_value = countHighValue;
    next.total_confirmed_direction = countConfirmed;
    next.total_needs_work = countNeedsWork;
    next.total_low_priority = countLowPriority;
    next.legacy_discoveries_count = legacyDiscoveries.length;
    next.strict_discoveries_count = strictDiscoveries.length;

    if (strictCount > 0) {
      next.avg_score = Math.round(scoreSum / strictCount);
      next.avg_bridge_score = Math.round(bridgeSum / strictCount);
      next.avg_speculation_leaps = Math.round((specSum / strictCount) * 10) / 10;
    } else {
      next.avg_score = 0;
      next.avg_bridge_score = 0;
      next.avg_speculation_leaps = 0;
    }

    if (countAttempts > 0) {
      next.gap_rate = Math.round((countDiscovery / countAttempts) * 1000) / 10;
      next.rejection_rate = Math.round(((countNoGap + countDraft + countDup) / countAttempts) * 1000) / 10;
      next.high_value_rate = Math.round((countHighValue / countAttempts) * 1000) / 10;
      next.strict_gap_rate = Math.round((strictDiscoveries.length / countAttempts) * 1000) / 10;
    } else {
      next.gap_rate = 0;
      next.rejection_rate = 0;
      next.high_value_rate = 0;
      next.strict_gap_rate = 0;
    }

    // Clamp rates to [0, 100]
    for (const k of ['gap_rate', 'rejection_rate', 'high_value_rate', 'strict_gap_rate']) {
      if (typeof next[k] === 'number') {
        next[k] = Math.max(0, Math.min(100, next[k]));
      }
    }

    next.gpt_reviewed = gptReviewed;
    next.gpt_confirmed = gptConfirmed;
    next.gpt_weakened = gptWeakened;
    next.gpt_killed = gptKilled;
    next.last_updated = new Date().toISOString();

    const changed = JSON.stringify(m) !== JSON.stringify(next);
    if (changed) {
      const tmpFile = METRICS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2));
      fs.renameSync(tmpFile, METRICS_FILE);
      if (emitLog) emitLog('info', `[METRICS] Recomputed from findings: att=${countAttempts} disc=${countDiscovery} no_gap=${countNoGap} strict=${strictDiscoveries.length} legacy=${legacyDiscoveries.length}`);
    }
  } catch (e) {
    if (emitError) emitError('metrics', e);
  }
}

function updateMetrics(updates, emitError) {
  try {
    const m = readMetrics();

    // Midnight UTC cost reset
    const todayKey = new Date().toISOString().slice(0, 10);
    if (m._cost_date && m._cost_date !== todayKey) {
      m.api_calls_today = 0;
      m.estimated_cost_today = 0;
      m._cost_date = todayKey;
    }

    for (const [key, val] of Object.entries(updates)) {
      if (typeof val === 'number' && (key.startsWith('total_') || key.startsWith('gpt_') || key.startsWith('validated') || key.startsWith('ready_') || key.startsWith('needs_') || key.startsWith('blocked') || key.startsWith('saturation_') || key.startsWith('labeled_') || key.startsWith('_'))) {
        m[key] = (m[key] || 0) + val;
      } else {
        m[key] = val;
      }
    }

    // Recalculate averages
    if (m._score_count > 0) m.avg_score = Math.round(m._score_sum / m._score_count);
    if (m._bridge_count > 0) m.avg_bridge_score = Math.round(m._bridge_sum / m._bridge_count);
    if (m._spec_count > 0) m.avg_speculation_leaps = Math.round((m._spec_sum / m._spec_count) * 10) / 10;

    // Calculated rates
    const att = m.total_discovery_attempts || 0;
    if (att > 0) {
      m.gap_rate = Math.round(((m.total_discoveries || 0) / att) * 1000) / 10;
      m.rejection_rate = Math.round((((m.total_no_gap || 0) + (m.total_drafts || 0) + (m.total_duplicates || 0)) / att) * 1000) / 10;
      m.high_value_rate = Math.round(((m.total_high_value || 0) / att) * 1000) / 10;
      const strictDisc = (m.strict_discoveries_count || 0);
      m.strict_gap_rate = Math.round((strictDisc / att) * 1000) / 10;
    }
    delete m.survival_rate;
    delete m.red_flag_rate;

    // GPT survival rate
    if ((m.gpt_reviewed || 0) > 0) {
      m.gpt_survival_rate = Math.round(((m.gpt_confirmed || 0) / m.gpt_reviewed) * 1000) / 10;
    } else {
      m.gpt_survival_rate = 0;
    }

    // Precision@k
    const lt = m.labeled_total || 0;
    if (lt < 5) { m.precision_at_5 = null; m.precision_at_5_status = 'INSUFFICIENT_LABELS'; }
    else { delete m.precision_at_5_status; }
    if (lt < 10) { m.precision_at_10 = null; m.precision_at_10_status = 'INSUFFICIENT_LABELS'; }
    else { delete m.precision_at_10_status; }

    m.last_updated = new Date().toISOString();

    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = METRICS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(m, null, 2));
    fs.renameSync(tmpFile, METRICS_FILE);
    return m;
  } catch (e) {
    if (emitError) emitError('metrics', e);
    return {};
  }
}

function logMetrics(tickNum, emitLog) {
  if (tickNum % 10 !== 0) return;
  const m = readMetrics();
  const attempts = m.total_discovery_attempts || 0;
  const gaps = m.total_discoveries || 0;
  const pct = m.gap_rate || 0;
  const hv = m.total_high_value || 0;
  const reject = m.rejection_rate || 0;
  if (emitLog) emitLog('info', `[METRICS] attempts=${attempts} gaps=${gaps} (${pct}%) HV=${hv} reject=${reject}% cost_today=$${(m.estimated_cost_today || 0).toFixed(2)}`);
  if ((m.estimated_cost_today || 0) > 0 && emitLog) {
    emitLog('info', `[COST] Today: $${(m.estimated_cost_today || 0).toFixed(2)} (${m.api_calls_today || 0} calls) | Total: $${(m.estimated_cost_total || 0).toFixed(2)} (${m.api_calls_total || 0} calls)`);
  }
}

function recomputeMetricsNow(reason, emitLog, emitError) {
  try {
    recomputeMetricsFromFindings(emitLog, emitError);
    if (reason && emitLog) emitLog('info', `[METRICS] Recompute triggered: ${reason}`);
  } catch (e) {
    if (emitError) emitError('metrics', e);
  }
}

function safeMetricCategory(cat) {
  return String(cat || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

// ---------------------------------------------------------------------------
// Agent keyword / research-field helpers
// ---------------------------------------------------------------------------
function getAgentKeywords(agent) {
  return agent.keywords || [];
}

function updateAgentKeywords(agent, newKeywords) {
  if (!agent.lastCellKeywords) agent.lastCellKeywords = [];
  agent.lastCellKeywords.push(newKeywords);
  if (agent.lastCellKeywords.length > 5) {
    agent.lastCellKeywords = agent.lastCellKeywords.slice(-5);
  }
  const all = new Set();
  for (const kwSet of agent.lastCellKeywords) {
    for (const kw of kwSet) all.add(kw);
  }
  agent.keywords = [...all].slice(0, 25);
}

function ensureResearchFields(agent) {
  if (agent.keywords === undefined) agent.keywords = [];
  if (agent.lastCellKeywords === undefined) agent.lastCellKeywords = [];
  if (agent.lastCells === undefined) agent.lastCells = [];
  if (agent.findingsCount === undefined) agent.findingsCount = 0;
  if (agent.bondsWithFindings === undefined) agent.bondsWithFindings = 0;
  if (agent.discoveriesCount === undefined) agent.discoveriesCount = 0;
}

function trackCellVisit(agent, cell) {
  if (!agent.lastCells) agent.lastCells = [];
  if (agent.lastCells[agent.lastCells.length - 1] !== cell) {
    agent.lastCells.push(cell);
    if (agent.lastCells.length > 10) {
      agent.lastCells = agent.lastCells.slice(-10);
    }
  }
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------
function normalizeDeepDiveQueue(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (item && item.discovery) {
      return { discovery: item.discovery, attempts: item.attempts || 0, last_error: item.last_error || null };
    }
    return { discovery: item, attempts: 0, last_error: null };
  }).filter(item => item && item.discovery);
}

function loadQueues() {
  try {
    const raw = fs.readFileSync(QUEUES_FILE, 'utf8');
    const q = JSON.parse(raw);
    return {
      deepDive: normalizeDeepDiveQueue(q.deepDive),
      verification: Array.isArray(q.verification) ? q.verification : [],
      validation: Array.isArray(q.validation) ? q.validation : [],
    };
  } catch { return { deepDive: [], verification: [], validation: [] }; }
}

// ---------------------------------------------------------------------------
// Tick lock helpers
// ---------------------------------------------------------------------------
function acquireTickLock(emitLog, emitError) {
  try {
    const dir = path.dirname(TICK_LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(TICK_LOCK_FILE)) {
      try {
        const raw = fs.readFileSync(TICK_LOCK_FILE, 'utf8');
        const lock = JSON.parse(raw);
        const ageMs = Date.now() - (lock.ts || 0);
        if (ageMs < TICK_LOCK_STALE_MS) {
          if (emitLog) emitLog('warn', `[LOCK] Tick lock present (${Math.round(ageMs / 1000)}s old) — skipping tick`);
          return false;
        }
        if (emitLog) emitLog('warn', `[LOCK] Stale tick lock detected (${Math.round(ageMs / 1000)}s old) — overwriting`);
      } catch (e) {
        if (emitLog) emitLog('warn', '[LOCK] Corrupt tick lock — overwriting');
      }
    }
    const tmp = TICK_LOCK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.renameSync(tmp, TICK_LOCK_FILE);
    return true;
  } catch (e) {
    if (emitError) emitError('lock', e);
    return false;
  }
}

function releaseTickLock(emitError) {
  try {
    if (fs.existsSync(TICK_LOCK_FILE)) fs.unlinkSync(TICK_LOCK_FILE);
  } catch (e) {
    if (emitError) emitError('lock', e);
  }
}

// ---------------------------------------------------------------------------
// Prior discovery / claim helpers
// ---------------------------------------------------------------------------
function getPriorDiscoveries(label1, label2) {
  const data = readFindings();
  const sorted = [label1, label2].sort();
  return (data.findings || []).filter(f => {
    if (f.type !== 'discovery') return false;
    const labels = (f.cellLabels || []).slice().sort();
    return labels[0] === sorted[0] && labels[1] === sorted[1];
  });
}

function getUnverifiedClaim() {
  const ddData = readDeepDives();
  if (!ddData.dives || ddData.dives.length === 0) return null;

  const sorted = [...ddData.dives].sort((a, b) => (b.scores?.total || 0) - (a.scores?.total || 0));
  const bestDive = sorted[0];
  if (!bestDive) return null;

  const findings = readFindings();
  const discovery = (findings.findings || []).find(f => f.id === bestDive.discovery_id);
  if (!discovery) return null;

  const claims = [];
  if (discovery.discovery) claims.push(discovery.discovery);
  if (discovery.gap) claims.push(discovery.gap);
  if (discovery.proposed_experiment) claims.push(discovery.proposed_experiment);

  const verified = (bestDive.verifications || []).map(v => v.claim);
  for (const claim of claims) {
    if (!verified.includes(claim)) {
      return { dive: bestDive, discovery, claim };
    }
  }
  for (const dive of sorted.slice(1)) {
    const disc = (findings.findings || []).find(f => f.id === dive.discovery_id);
    if (!disc) continue;
    const dClaims = [disc.discovery, disc.gap, disc.proposed_experiment].filter(Boolean);
    const dVerified = (dive.verifications || []).map(v => v.claim);
    for (const claim of dClaims) {
      if (!dVerified.includes(claim)) {
        return { dive, discovery: disc, claim };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label} (${ms}ms)`)), ms))
  ]);
}

// ---------------------------------------------------------------------------
// Epoch init
// ---------------------------------------------------------------------------
function initEpoch(state, emitLog, emitError) {
  try {
    const m = readMetrics();
    if (!m.epoch_started_at) {
      const { execSync } = require('child_process');
      let gitHash = 'unknown';
      try { gitHash = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch (e) { /* ignore */ }
      m.epoch_started_at = new Date().toISOString();
      m.epoch_git_commit = gitHash;
      m.epoch_tick_start = state.tick;
      const tmpFile = METRICS_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(m, null, 2));
      fs.renameSync(tmpFile, METRICS_FILE);
      if (emitLog) emitLog('info', `[EPOCH] Initialized: commit=${gitHash} tick=${state.tick}`);
    }
  } catch (e) {
    if (emitError) emitError('epoch', e);
  }
}

// ===========================================================================
// TickEngine class
// ===========================================================================
class TickEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./state').State} opts.state
   * @param {number}  [opts.tickInterval]  ms between ticks (default from env)
   * @param {boolean} [opts.useCube]       enable Anomaly Magnet cube (default from env)
   */
  constructor({ state, tickInterval, useCube } = {}) {
    super();
    this.state = state;
    this.tickInterval = tickInterval ?? parseInt(process.env.TICK_INTERVAL || '300', 10) * 1000;
    this.useCube = useCube ?? (process.env.USE_CUBE === 'true');

    // Overlap guard
    this._tickRunning = false;
    this._tickStartedAt = 0;
    this._timer = null;

    // Queues (persisted)
    const saved = loadQueues();
    this.deepDiveQueue = saved.deepDive;
    this.verificationQueue = saved.verification;
    this.validationQueue = saved.validation;
    if (this.deepDiveQueue.length || this.verificationQueue.length || this.validationQueue.length) {
      this._log('info', `[QUEUES] Restored: deepDive=${this.deepDiveQueue.length}, verification=${this.verificationQueue.length}, validation=${this.validationQueue.length}`);
    }


    // Screening metrics
    this._screenMetrics = { screened_count: 0, passed_count: 0, rejected_count: 0 };

    // Boot-time init
    recomputeMetricsFromFindings(this._log.bind(this), this._emitError.bind(this));
    initEpoch(state, this._log.bind(this), this._emitError.bind(this));

    // Init research fields for existing agents
    for (const agent of Object.values(state.agents)) {
      ensureResearchFields(agent);
    }
    state.save();
  }

  /** Emit a log event instead of writing to stdout directly. */
  _log(level, msg, ctx) {
    this.emit('log', { level, msg, ctx });
  }

  _emitError(phase, error, ctx) {
    this.emit('error', { phase, error, ctx });
  }

  /** Start the tick interval. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.tickInterval);
    this._log('info', `[ENGINE] Tick engine started (interval=${this.tickInterval / 1000}s)`);
  }

  /** Stop the tick interval and save state. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.state.save();
    this._saveQueues();
    this._log('info', `[ENGINE] Tick engine stopped, state saved.`);
  }

  // -----------------------------------------------------------------------
  // Queue persistence
  // -----------------------------------------------------------------------
  _saveQueues() {
    try {
      const dir = path.dirname(QUEUES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = QUEUES_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        deepDive: this.deepDiveQueue,
        verification: this.verificationQueue,
        validation: this.validationQueue
      }, null, 2));
      fs.renameSync(tmp, QUEUES_FILE);
    } catch (e) {
      this._log('error', `[QUEUES] Save failed: ${e.message}`);
    }
  }

  _recordDeepDiveFailure(item, message) {
    item.attempts = (item.attempts || 0) + 1;
    item.last_error = message || 'unknown';
    if (item.attempts >= 3) {
      this._log('warn', `[DEEP-DIVE] Dropping ${item.discovery.id} after ${item.attempts} failures: ${item.last_error}`);
      this.deepDiveQueue.shift();
    } else {
      this._log('warn', `[DEEP-DIVE] Will retry ${item.discovery.id} (${item.attempts}/3): ${item.last_error}`);
    }
    this._saveQueues();
  }

  // -----------------------------------------------------------------------
  // Tick entry point (overlap guard + lock)
  // -----------------------------------------------------------------------
  async _tick() {
    if (this._tickRunning) { this._log('info', '[TICK] SKIP overlap'); return; }
    if (!acquireTickLock(this._log.bind(this), this._emitError.bind(this))) return;
    this._tickRunning = true;
    this._tickStartedAt = Date.now();
    try {
      await this._tickInner();
    } catch (err) {
      this._emitError('tick', err, { tick: this.state.tick });
    } finally {
      this._tickRunning = false;
      releaseTickLock(this._emitError.bind(this));
    }
  }

  // -----------------------------------------------------------------------
  // Full tick pipeline
  // -----------------------------------------------------------------------
  async _tickInner() {
    const state = this.state;
    const result = state.processTick();
    const { tick: tickNum, activeCell, cycle, events, isCycleEnd } = result;
    this._log('info', `[TICK] ${tickNum} | cell=${activeCell} (${cellLabelShort(activeCell)}) | events=${events.length}`);
    logMetrics(tickNum, this._log.bind(this));
    if (tickNum % 10 === 0) recomputeMetricsFromFindings(this._log.bind(this), this._emitError.bind(this));

    // Emit tick event
    this.emit('tick', { tickNum, activeCell, cycle, events, isCycleEnd });

    if (isCycleEnd) {
      const summary = state.getCycleSummary();
      summary.screening = { ...this._screenMetrics };
      this.emit('cycleEnd', { summary });
    }

    // === COST GUARD ===
    const costMetrics = readMetrics();
    const lowSpendMode = (costMetrics.estimated_cost_today || 0) > 5.00;
    if (lowSpendMode && tickNum % 50 === 0) {
      this._log('info', `[COST] WARNING $${(costMetrics.estimated_cost_today || 0).toFixed(2)} today — low-spend mode active (skipping deep-dive/verification)`);
    }

    const budgetStatus = budget.getStatus();
    const budgetPaused = budgetStatus.overBudget || !budget.canAffordCall('claude-haiku-4-5-20251001', 2000);
    if (budgetPaused) {
      this._log('info', `[BUDGET] Daily limit reached ($${budgetStatus.todaySpent.toFixed(2)}). Pausing research until midnight UTC.`);
      this.emit('budgetPaused', { todaySpent: budgetStatus.todaySpent });
      state.save();
    }

    // === CUBE SHUFFLE (Anomaly Magnet v2.0) ===
    if (this.useCube && !budgetPaused) {
      try {
        const { shouldShuffle, shuffle, readCube } = require('./shuffler');
        const cube = readCube();
        const lastShuffle = cube ? cube.createdAtTick : null;

        if (shouldShuffle(tickNum, lastShuffle) && !global._shuffleInProgress) {
          global._shuffleInProgress = true;
          const gen = cube ? cube.generation : 0;
          this._log('info', `[SHUFFLE] Triggering cube shuffle at tick ${tickNum} (generation ${gen} → ${gen + 1})`);

          shuffle(tickNum, gen, (fetched, total) => {
            if (fetched % 100 === 0) this._log('info', `[SHUFFLE] Progress: ${fetched}/${total} papers`);
          }).then(newCube => {
            this._log('info', `[SHUFFLE] Complete: generation ${newCube.generation}, ${newCube.totalPapers} papers (${newCube.shuffleDurationMs}ms)`);
            global._shuffleInProgress = false;
            appendFinding({
              id: `shuffle-${tickNum}`,
              type: 'shuffle',
              timestamp: new Date().toISOString(),
              tick: tickNum,
              generation: newCube.generation,
              totalPapers: newCube.totalPapers,
              distribution: newCube.distribution,
              durationMs: newCube.shuffleDurationMs
            });
            updateMetrics({
              cubeGeneration: newCube.generation,
              lastShuffleAtTick: tickNum,
              cubeTotalPapers: newCube.totalPapers
            }, this._emitError.bind(this));
            this.emit('shuffle', { generation: newCube.generation, totalPapers: newCube.totalPapers, durationMs: newCube.shuffleDurationMs });
          }).catch(err => {
            this._log('error', `[SHUFFLE] Failed: ${err.message}`);
            this._emitError('shuffle', err);
            global._shuffleInProgress = false;
          });
        }
      } catch (err) {
        this._log('error', `[SHUFFLE] Init error: ${err.message}`);
        this._emitError('shuffle', err);
        global._shuffleInProgress = false;
      }
    }

    // Move all alive agents to active cell
    for (const agent of Object.values(state.agents)) {
      if (agent.alive && agent.currentCell !== activeCell) {
        agent.currentCell = activeCell;
      }
    }
    state.save();

    // === ACTIVE RESEARCH (max 1 API call per tick) ===
    const agentsHere = [];
    for (const [, a] of state.agents) {
      if (a.alive && a.currentCell === activeCell) agentsHere.push(a);
    }
    const pack = getActivePack();
    const packLabel = getCellLabel(activeCell);
    const cubeLabel = cellLabelShort(activeCell);
    const label = packLabel !== `Cell ${activeCell}` ? packLabel : cubeLabel;
    const packName = pack ? pack.name : 'Research';

    if (agentsHere.length > 0 && pack && !budgetPaused) {
      for (const agent of agentsHere) {
        ensureResearchFields(agent);
        trackCellVisit(agent, activeCell);
      }

      let apiUsed = false;

      // Circuit breaker
      const researchSuppressed = isCircuitOpen();
      if (researchSuppressed) {
        circuitBreakerWarn(tickNum);
      }

      if (!researchSuppressed) {
        // Deterministic randomized cross-layer pairing based on tick + day seed
        const seed = hashSeed(`${daySeed()}:${tickNum}`);
        const rng = mulberry32(seed);
        const allAgents = agentsHere;
        const candidates = [];
        for (let i = 0; i < allAgents.length; i++) {
          for (let j = i + 1; j < allAgents.length; j++) {
            if (isCrossLayer(allAgents[i].homeCell, allAgents[j].homeCell)) {
              candidates.push([allAgents[i], allAgents[j]]);
            }
          }
        }
        shuffleDeterministic(candidates, seed);
        const pair = candidates[0] || null;
        let agent1 = pair ? pair[0] : null;
        let agent2 = pair ? pair[1] : null;
        const rubric = RUBRICS[Math.floor(rng() * RUBRICS.length)];

        if (agent1 && agent2 && agent1.homeCell !== agent2.homeCell) {
          const a1Label = getCellLabel(agent1.homeCell);
          const a2Label = getCellLabel(agent2.homeCell);
          const crossLayer = isCrossLayer(agent1.homeCell, agent2.homeCell);

          if (crossLayer) {
          // Check if this cell-label combo already has 2+ discoveries
          const priorDiscoveries = getPriorDiscoveries(a1Label, a2Label);
          if (priorDiscoveries.length >= 2) {
            this._log('info', `[RESEARCH] SKIP discovery: ${a1Label} × ${a2Label} already has ${priorDiscoveries.length} discoveries`);
            // Deepen: verify a claim from the best deep dive
            const claimData = getUnverifiedClaim();
            if (claimData && !isLegacyDiscovery(claimData.discovery)) {
              const leadAgent = agentsHere[0];
              try {
                const vResult = await withTimeout(investigateVerification({
                  tick: tickNum,
                  agentName: leadAgent.displayName,
                  cell: activeCell,
                  cellLabel: label,
                  packName,
                  claim: claimData.claim,
                  discoveryId: claimData.discovery.id
                }), QUEUE_TIMEOUT_MS, 'claim-verify');
                if (vResult) {
                  updateAgentKeywords(leadAgent, vResult.keywords || []);
                  leadAgent.findingsCount = (leadAgent.findingsCount || 0) + 1;
                  this._log('info', `[RESEARCH] ${vResult.id} | VERIFY | ${claimData.discovery.id} | verified=${vResult.verified} confidence=${vResult.confidence}`);
                  if (!claimData.dive.verifications) claimData.dive.verifications = [];
                  claimData.dive.verifications.push({
                    claim: claimData.claim,
                    verified: vResult.verified,
                    confidence: vResult.confidence,
                    source: vResult.source || '',
                    finding_id: vResult.id
                  });
                  if (vResult.verified) {
                    claimData.dive.scores.total = Math.min(100, claimData.dive.scores.total + 5);
                  } else {
                    claimData.dive.scores.total = Math.max(0, claimData.dive.scores.total - 10);
                  }
                  saveDeepDive(claimData.dive);
                }
                apiUsed = true;
              } catch (err) {
                this._log('error', `[RESEARCH] Verification error: ${err.message}`);
                this._emitError('claim-verify', err);
              }
            }
          } else {
            // Cross-layer: discovery investigation
            const layer1 = getLayerForCell(agent1.homeCell);
            const layer2 = getLayerForCell(agent2.homeCell);
            const dataAgent = layer1 <= layer2 ? agent1 : agent2;
            const hypoAgent = dataAgent === agent1 ? agent2 : agent1;
            const dataLabel = getCellLabel(dataAgent.homeCell);
            const hypoLabel = getCellLabel(hypoAgent.homeCell);
            const pairId = `${dataLabel.replace(/\s+/g, '')}_${hypoLabel.replace(/\s+/g, '')}`;
            const attemptId = `att-${tickNum}-${pairId}`;

            // --- Golden collision scoring + cache ---
            let goldenMeta = null;
            let dataCubeDesc = null;
            let hypoCubeDesc = null;
            let skipResearch = false;
            const cubeMode = this.useCube;

            try {
              const { goldenCollisionScore, getCubeDescription } = require('./shuffler');

              goldenMeta = goldenCollisionScore(dataAgent.homeCell, hypoAgent.homeCell);
              if (cubeMode) {
                dataCubeDesc = getCubeDescription(dataAgent.homeCell);
                hypoCubeDesc = getCubeDescription(hypoAgent.homeCell);
              }

              // TTL cache with rubric + scoring version
              const cache = readCollisionCache();
              const aId = dataCubeDesc?.topPapers?.[0]?.paperId || `cell${dataAgent.homeCell}`;
              const bId = hypoCubeDesc?.topPapers?.[0]?.paperId || `cell${hypoAgent.homeCell}`;
              const cKey = cacheKey(aId, bId, rubric.id);
              const now = Date.now();
              const cached = cache.entries?.[cKey];
              if (cached && cached.expiresAt > now) {
                this._log('info', `[CACHE] Collision ${cKey} cached (TTL) — skipping`);
                appendFinding({
                  id: attemptId,
                  type: 'attempt',
                  timestamp: new Date().toISOString(),
                  tick: tickNum,
                  pair: { a: dataAgent.displayName, b: hypoAgent.displayName },
                  domains: { domain_a: dataLabel, domain_b: hypoLabel, meeting_cell: label },
                  goldenCollision: goldenMeta,
                  result: { outcome: 'skipped', reason: 'collision_cached', discovery_id: null },
                  completed_at: new Date().toISOString()
                });
                recomputeMetricsNow('collision_skipped_cached', this._log.bind(this), this._emitError.bind(this));
                skipResearch = true;
              } else {
                const ttlBase = (goldenMeta && goldenMeta.score >= 0.65) ? CACHE_TTL_HIGH_MS : CACHE_TTL_LOW_MS;
                const jitter = 0.85 + (rng() * 0.3);
                cache.entries[cKey] = {
                  createdAt: now,
                  expiresAt: now + Math.floor(ttlBase * jitter),
                  score: goldenMeta?.score || 0,
                  rubricId: rubric.id,
                  scoringVersion: SCORING_VERSION
                };
                writeCollisionCache(cache);
              }

              if (goldenMeta && goldenMeta.golden) {
                this._log('info', `[GOLDEN] Score ${goldenMeta.score} | ${goldenMeta.cellA.method} x ${goldenMeta.cellB.method} | surprise: ${goldenMeta.cellA.surprise} x ${goldenMeta.cellB.surprise}`);
              }

              if (goldenMeta && typeof goldenMeta.score === 'number' && !goldenMeta.reason && goldenMeta.score < MIN_COLLISION_SCORE) {
                this._log('info', `[SKIP] Collision score ${goldenMeta.score.toFixed(2)} below threshold ${MIN_COLLISION_SCORE} — skipping Claude API call`);
                appendFinding({
                  id: attemptId,
                  type: 'attempt',
                  timestamp: new Date().toISOString(),
                  tick: tickNum,
                  pair: { a: dataAgent.displayName, b: hypoAgent.displayName },
                  domains: { domain_a: dataLabel, domain_b: hypoLabel, meeting_cell: label },
                  goldenCollision: goldenMeta,
                  result: { outcome: 'skipped', reason: 'collision_score_below_threshold', discovery_id: null },
                  completed_at: new Date().toISOString()
                });
                recomputeMetricsNow('collision_skipped_score', this._log.bind(this), this._emitError.bind(this));
                skipResearch = true;
              }

              // Safety: fall back to pack mode if cube cells are too thin
              if (dataCubeDesc && dataCubeDesc.paperCount < 3) {
                this._log('info', `[CUBE] Cell ${dataAgent.homeCell} too thin (${dataCubeDesc.paperCount} papers) — falling back to pack labels`);
                dataCubeDesc = null;
                hypoCubeDesc = null;
              }
              if (hypoCubeDesc && hypoCubeDesc.paperCount < 3) {
                this._log('info', `[CUBE] Cell ${hypoAgent.homeCell} too thin (${hypoCubeDesc.paperCount} papers) — falling back to pack labels`);
                dataCubeDesc = null;
                hypoCubeDesc = null;
              }
            } catch (e) {
              this._log('error', `[CUBE] Golden scoring error: ${e.message}`);
              this._emitError('golden-scoring', e);
            }

            if (!skipResearch) {
            // --- Haiku screening gate ---
            try {
              const screenResult = await screenCollision(
                { label: dataLabel, keywords: getAgentKeywords(dataAgent) },
                { label: hypoLabel, keywords: getAgentKeywords(hypoAgent) },
                (goldenMeta && typeof goldenMeta.score === 'number') ? goldenMeta.score : 0.5
              );
              this._screenMetrics.screened_count++;
              if (!screenResult.pass) {
                this._screenMetrics.rejected_count++;
                this._log('info', `[SCREEN] REJECT ${dataLabel} x ${hypoLabel}: ${screenResult.reason}`);
                this.emit('screenReject', {
                  tick: tickNum,
                  agents: [dataAgent.displayName, hypoAgent.displayName],
                  domains: [dataLabel, hypoLabel],
                  reason: screenResult.reason,
                  goldenScore: goldenMeta?.score || null
                });
                appendFinding({
                  id: attemptId,
                  type: 'attempt',
                  timestamp: new Date().toISOString(),
                  tick: tickNum,
                  pair: { a: dataAgent.displayName, b: hypoAgent.displayName },
                  domains: { domain_a: dataLabel, domain_b: hypoLabel, meeting_cell: label },
                  goldenCollision: goldenMeta,
                  result: { outcome: 'screen_rejected', reason: screenResult.reason, discovery_id: null },
                  completed_at: new Date().toISOString()
                });
                recomputeMetricsNow('screen_rejected', this._log.bind(this), this._emitError.bind(this));
                skipResearch = true;
              } else {
                this._screenMetrics.passed_count++;
                this._log('info', `[SCREEN] PASS ${dataLabel} x ${hypoLabel}: ${screenResult.reason}`);
              }
            } catch (screenErr) {
              this._log('error', `[SCREEN] Error (non-blocking): ${screenErr.message}`);
              // On error, proceed with investigation (don't block)
            }
            }

            if (!skipResearch) {
            // Build prior summary for the prompt
            const priorSummary = priorDiscoveries.length > 0
              ? priorDiscoveries.map(d => d.discovery || d.gap || '').filter(Boolean).join('; ')
              : '';
            const meetingPointLabel = label;

            // Persist attempt before API call
            const attemptRecord = {
              id: attemptId,
              type: 'attempt',
              timestamp: new Date().toISOString(),
              tick: tickNum,
              pair: { a: dataAgent.displayName, b: hypoAgent.displayName },
              domains: { domain_a: dataLabel, domain_b: hypoLabel, meeting_cell: meetingPointLabel },
              goldenCollision: goldenMeta,
              rubric: rubric ? { id: rubric.id, label: rubric.label, version: RUBRIC_VERSION } : null,
              result: { outcome: 'pending', reason: '', discovery_id: null }
            };
            appendFinding(attemptRecord);
            recomputeMetricsNow('attempt_recorded', this._log.bind(this), this._emitError.bind(this));

            try {
              const discovery = await withTimeout(investigateDiscovery({
                tick: tickNum,
                cell: activeCell,
                cellLabel: meetingPointLabel,
                agent1Name: dataAgent.displayName,
                agent2Name: hypoAgent.displayName,
                layer0Cell: (cubeMode && dataCubeDesc) ? dataCubeDesc : dataLabel,
                layer2Cell: (cubeMode && hypoCubeDesc) ? hypoCubeDesc : hypoLabel,
                packName,
                dataKeywords: getAgentKeywords(dataAgent),
                hypothesisKeywords: getAgentKeywords(hypoAgent),
                priorSummary,
                meetingPoint: meetingPointLabel,
                cubeMode: cubeMode && !!dataCubeDesc,
                goldenCollision: goldenMeta,
                rubric,
                scoringVersion: SCORING_VERSION
              }), QUEUE_TIMEOUT_MS, 'investigateDiscovery');

              // Attach golden collision metadata
              if (discovery && goldenMeta) {
                discovery.goldenCollision = goldenMeta;
                if (goldenMeta.golden) {
                  updateMetrics({ total_golden_collisions: 1 }, this._emitError.bind(this));
                }
              }

              if (discovery) {
                if (discovery.type === 'no_gap') {
                  updateFindingById(attemptId, { result: { outcome: 'no_gap', reason: discovery.reason || 'insufficient evidence', discovery_id: null }, completed_at: new Date().toISOString() });
                  recomputeMetricsNow('no_gap_recorded', this._log.bind(this), this._emitError.bind(this));
                } else {
                  if (discovery.type === 'discovery') {
                    dataAgent.discoveriesCount = (dataAgent.discoveriesCount || 0) + 1;
                    hypoAgent.discoveriesCount = (hypoAgent.discoveriesCount || 0) + 1;
                  }
                  dataAgent.bondsWithFindings = (dataAgent.bondsWithFindings || 0) + 1;
                  hypoAgent.bondsWithFindings = (hypoAgent.bondsWithFindings || 0) + 1;
                  this._log('info', `[RESEARCH] ${discovery.id} | ${(discovery.type || 'discovery').toUpperCase()} | ${dataLabel} x ${hypoLabel} | verdict=${discovery.verdict?.verdict || discovery.verdict || 'none'}`);

                  if (discovery.s2_metadata) {
                    const s2 = discovery.s2_metadata;
                    this._log('info', `[S2] ${discovery.id} | prefetched=${s2.papers_prefetched} verified=${s2.sources_verified}/${s2.sources_total} (${s2.verification_rate}%)`);
                  }

                  // Finalize attempt
                  const vFinal = (discovery.verdict && discovery.verdict.verdict) || discovery.verdict || '';
                  const outcomeMap = { 'HIGH-VALUE GAP': 'high_value', 'CONFIRMED DIRECTION': 'confirmed_direction', 'NEEDS WORK': 'needs_work', 'LOW PRIORITY': 'low_priority' };
                  updateFindingById(attemptId, { result: { outcome: outcomeMap[vFinal] || 'discovery', reason: vFinal, discovery_id: discovery.id }, completed_at: new Date().toISOString() });
                  recomputeMetricsNow('discovery_recorded', this._log.bind(this), this._emitError.bind(this));

                  // Queue follow-ups
                  if (discovery.type === 'discovery') {
                    const queued = queueFollowUps(discovery);
                    if (queued.length > 0) {
                      this._log('info', `[FOLLOW-UP] Queued ${queued.length} follow-ups from ${discovery.id}: ${queued.map(q => q.id).join(', ')}`);
                    }
                  }

                  // Emit research event
                  this.emit('research', {
                    type: discovery.type,
                    id: discovery.id,
                    finding: discovery,
                    agents: [dataAgent.displayName, hypoAgent.displayName],
                    label: `${dataLabel} x ${hypoLabel}`
                  });

                  // --- Field Saturation Check (HIGH-VALUE GAP only) ---
                  let verdictStr = (discovery.verdict && discovery.verdict.verdict) || discovery.verdict || '';
                  if (discovery.type === 'discovery' && verdictStr === 'HIGH-VALUE GAP') {
                    try {
                      const satResult = await checkSaturation(
                        discovery.finding || discovery.hypothesis || '',
                        discovery.abc_chain || [],
                        discovery.bridge || {}
                      );
                      if (satResult) {
                        discovery.saturation = satResult;
                        updateMetrics({ saturation_checks: 1 }, this._emitError.bind(this));
                        this._log('info', `[SATURATION] ${discovery.id} | score=${satResult.field_saturation_score} | papers=${satResult.paper_estimate_5y} | trials=${satResult.trial_count} | field=${satResult.established_field_name || 'none'}`);

                        if (satResult.field_saturation_score >= 60) {
                          discovery.verdict = { verdict: 'CONFIRMED DIRECTION', reason: `Saturation downgrade (score ${satResult.field_saturation_score}): ${satResult.reasoning}` };
                          verdictStr = 'CONFIRMED DIRECTION';
                          updateMetrics({ saturation_downgrades: 1 }, this._emitError.bind(this));
                          this._log('info', `[SATURATION] ${discovery.id} DOWNGRADED to CONFIRMED DIRECTION (saturation=${satResult.field_saturation_score})`);
                        } else if (satResult.field_saturation_score >= 40) {
                          if (discovery.scores && typeof discovery.scores.novelty === 'number') {
                            discovery.scores.novelty = Math.max(0, discovery.scores.novelty - 5);
                            discovery.scores.total = Math.max(0, (discovery.scores.total || 0) - 5);
                          }
                          updateMetrics({ saturation_penalties: 1 }, this._emitError.bind(this));
                          this._log('info', `[SATURATION] ${discovery.id} novelty penalized -5 (saturation=${satResult.field_saturation_score})`);
                        } else {
                          updateMetrics({ saturation_passed: 1 }, this._emitError.bind(this));
                          this._log('info', `[SATURATION] ${discovery.id} PASSED saturation check (score=${satResult.field_saturation_score})`);
                        }
                      }
                    } catch (satErr) {
                      this._log('error', `[SATURATION] Check failed for ${discovery.id}: ${satErr.message}`);
                      this._emitError('saturation', satErr, { discoveryId: discovery.id });
                    }
                  }

                  // Build review pack
                  if (discovery.type === 'discovery' && (verdictStr === 'HIGH-VALUE GAP' || verdictStr === 'CONFIRMED DIRECTION')) {
                    discovery.review_pack = buildReviewPack(discovery);
                    const findingsData = readFindings();
                    const fIdx = (findingsData.findings || []).findIndex(f => f.id === discovery.id);
                    if (fIdx !== -1) {
                      findingsData.findings[fIdx] = discovery;
                      saveFindingsAtomic(findingsData);
                    }
                  }

                  // Record daily candidate score (for publishing + deep dive gate)
                  const candidateScore = ((goldenMeta && typeof goldenMeta.score === 'number') ? goldenMeta.score * 100 : 0) + (discovery.scores?.total || 0);
                  recordDailyCandidate(discovery, candidateScore);

                  // Queue for deep dive
                  const totalScore = discovery.scores && typeof discovery.scores.total === 'number' ? discovery.scores.total : 0;
                  if (discovery.type === 'discovery' && totalScore >= DEEP_DIVE_THRESHOLD && (verdictStr === 'HIGH-VALUE GAP' || discovery.impact === 'high')) {
                    const allowDeepDive = shouldQueueDeepDive(discovery, candidateScore, 10);
                    if (allowDeepDive) {
                      this.deepDiveQueue.push({ discovery, attempts: 0, last_error: null });
                      this._saveQueues();
                      this._log('info', `[DEEP-DIVE] Queued ${discovery.id} for deep dive (queue: ${this.deepDiveQueue.length})`);
                    } else {
                      this._log('info', `[DEEP-DIVE] Skipped ${discovery.id} (not in top-10 candidates today)`);
                    }
                  } else if (discovery.type === 'discovery' && (verdictStr === 'HIGH-VALUE GAP' || discovery.impact === 'high')) {
                    this._log('info', `[DEEP-DIVE] Skipped ${discovery.id} (score ${totalScore} < ${DEEP_DIVE_THRESHOLD})`);
                  }

                  // Emit discovery event
                  if (discovery.type === 'discovery') {
                    this.emit('discovery', {
                      discovery,
                      attempt: attemptId,
                      agents: [dataAgent.displayName, hypoAgent.displayName],
                      labels: [dataLabel, hypoLabel],
                      goldenMeta
                    });
                  }
                }
              } else {
                updateFindingById(attemptId, { result: { outcome: 'error', reason: 'investigateDiscovery returned null', discovery_id: null }, completed_at: new Date().toISOString() });
                recomputeMetricsNow('discovery_error', this._log.bind(this), this._emitError.bind(this));
              }
              apiUsed = true;
            } catch (err) {
              this._log('error', `[RESEARCH] Discovery investigation error: ${err.message}`);
              this._emitError('discovery', err);
              updateFindingById(attemptId, { result: { outcome: 'error', reason: err.message, discovery_id: null }, completed_at: new Date().toISOString() });
              recomputeMetricsNow('discovery_exception', this._log.bind(this), this._emitError.bind(this));
            }
            } else {
              apiUsed = true;
            } // end if (!skipResearch)
          }
        } else {
          // Same-layer: bond investigation
          try {
            const bondFinding = await withTimeout(investigateBond({
              tick: tickNum,
              cell: activeCell,
              cellLabel: label,
              agent1Name: agent1.displayName,
              agent2Name: agent2.displayName,
              cell1Label: a1Label,
              cell2Label: a2Label,
              packName,
              cell1Keywords: getAgentKeywords(agent1),
              cell2Keywords: getAgentKeywords(agent2)
            }), QUEUE_TIMEOUT_MS, 'investigateBond');

            if (bondFinding) {
              agent1.bondsWithFindings = (agent1.bondsWithFindings || 0) + 1;
              agent2.bondsWithFindings = (agent2.bondsWithFindings || 0) + 1;
              this._log('info', `[RESEARCH] ${bondFinding.id} | BOND | ${a1Label} x ${a2Label}`);
              this.emit('research', {
                type: 'bond',
                id: bondFinding.id,
                finding: bondFinding,
                agents: [agent1.displayName, agent2.displayName],
                label: `${a1Label} x ${a2Label}`
              });
            }
            apiUsed = true;
          } catch (err) {
            this._log('error', `[RESEARCH] Bond investigation error: ${err.message}`);
            this._emitError('bond', err);
          }
        }
      }

        // Cell investigation (only if no bond/discovery this tick)
        if (!apiUsed) {
          const leadAgent = agentsHere[0];
          try {
            const cellFinding = await withTimeout(investigateCell({
              tick: tickNum,
              agentName: leadAgent.displayName,
              cell: activeCell,
              cellLabel: label,
              packName
            }), QUEUE_TIMEOUT_MS, 'investigateCell');

            if (cellFinding && cellFinding.keywords) {
              updateAgentKeywords(leadAgent, cellFinding.keywords);
              leadAgent.findingsCount = (leadAgent.findingsCount || 0) + 1;
              recomputeMetricsNow('cell_finding_recorded', this._log.bind(this), this._emitError.bind(this));
              this._log('info', `[RESEARCH] ${cellFinding.id} | CELL | ${label}`);
              this.emit('research', {
                type: 'cell',
                id: cellFinding.id,
                finding: cellFinding,
                agents: [leadAgent.displayName],
                label
              });
            }
          } catch (err) {
            this._log('error', `[RESEARCH] Cell investigation error: ${err.message}`);
            this._emitError('cell', err);
          }
        }
      }

      state.save();
    }

    // === DEEP DIVE (max 1 per tick, with timeout) ===
    if (this.deepDiveQueue.length > 0 && !lowSpendMode && !budgetPaused && (Date.now() - this._tickStartedAt) < TICK_TIME_BUDGET_MS) {
      const ddItem = this.deepDiveQueue[0];
      const ddDiscovery = ddItem.discovery;
      if (!budget.canRunDeepDive(MAX_DEEP_DIVES_PER_DAY)) {
        this._log('info', `[DEEP-DIVE] Daily cap reached (${MAX_DEEP_DIVES_PER_DAY}). Deferring deep dives until next day.`);
      } else {
        this._log('info', `[DEEP-DIVE] Starting deep dive on ${ddDiscovery.id} (${this.deepDiveQueue.length} remaining)`);
        try {
          budget.recordDeepDive();
          const ddResult = await withTimeout(deepDive(ddDiscovery), QUEUE_TIMEOUT_MS, 'deep-dive');
          if (ddResult) {
            this.deepDiveQueue.shift();
            this._saveQueues();
            this._log('info', `[DEEP-DIVE] ${ddDiscovery.id} complete: ${ddResult.verdict} (${ddResult.scores.total}/100)`);
            this.emit('deepDiveComplete', { discoveryId: ddDiscovery.id, result: ddResult });
            if (ddResult.verdict === 'HIGH-VALUE GAP') {
              this.verificationQueue.push({ discovery: ddDiscovery, deepDive: ddResult });
              this._saveQueues();
              this._log('info', `[VERIFIER] QUEUED ${ddDiscovery.id} for GPT-4o adversarial review (queue: ${this.verificationQueue.length})`);
            }
          } else {
            this._recordDeepDiveFailure(ddItem, 'deepDive returned null');
          }
        } catch (err) {
          const msg = `${err.message.startsWith('timeout:') ? 'TIMEOUT' : 'Error'}: ${err.message}`;
          this._log('error', `[DEEP-DIVE] ${msg}`);
          this._emitError('deep-dive', err);
          this._recordDeepDiveFailure(ddItem, msg);
        }
      }
    }

    // === VERIFICATION ===
    if (this.verificationQueue.length > 0 && !lowSpendMode && !budgetPaused && (Date.now() - this._tickStartedAt) < TICK_TIME_BUDGET_MS) {
      if (!process.env.OPENAI_API_KEY) {
        if (tickNum % 50 === 0) this._log('warn', '[VERIFIER] OPENAI_API_KEY not set — skipping verification');
        updateMetrics({ gpt_skipped_missing_key: 1, gpt_errors: 1, last_error: 'OPENAI_API_KEY not set — skipping verification', last_error_at: new Date().toISOString() }, this._emitError.bind(this));
      } else {
        const vItem = this.verificationQueue[0];
        const vVerdict = (vItem.discovery.verdict && vItem.discovery.verdict.verdict) || vItem.discovery.verdict || '';
        const vScore = vItem.discovery.scores && typeof vItem.discovery.scores.total === 'number' ? vItem.discovery.scores.total : 0;
        if (vVerdict !== 'HIGH-VALUE GAP') {
          this.verificationQueue.shift();
          this._saveQueues();
          updateMetrics({ gpt_skipped_not_high_value: 1 }, this._emitError.bind(this));
          this._log('warn', `[VERIFIER] Skipping non-high-value discovery ${vItem.discovery.id} (verdict=${vVerdict || 'unknown'})`);
        } else if (vScore < VERIFIER_MIN_SCORE) {
          this.verificationQueue.shift();
          this._saveQueues();
          vItem.discovery.verification = 'skipped-low-score';
          const findingsData = readFindings();
          const fIdx = findingsData.findings.findIndex(f => f.id === vItem.discovery.id);
          if (fIdx !== -1) {
            findingsData.findings[fIdx] = vItem.discovery;
            saveFindingsAtomic(findingsData);
          }
          updateMetrics({ gpt_skipped_low_score: 1 }, this._emitError.bind(this));
          this._log('warn', `[VERIFIER] Skipping ${vItem.discovery.id} (score ${vScore} < ${VERIFIER_MIN_SCORE})`);
        } else {
          try {
            this._log('info', `[VERIFIER] REVIEWING ${vItem.discovery.id} — sending to GPT-4o...`);
            const vResult = await withTimeout(verifyGap(vItem.discovery, vItem.deepDive), QUEUE_TIMEOUT_MS, 'gpt-verifier');
            if (vResult && !vResult.error) {
              this.verificationQueue.shift();
              this._saveQueues();

              // Adversarial score adjustment
              const claudeScores = vItem.discovery.scores || {};
              const claudeTotal = claudeScores.total || 0;
              const claudeBridge = claudeScores.bridge || 0;
              const gptBridge = typeof vResult.bridge_strength_override === 'number' ? vResult.bridge_strength_override : claudeBridge;
              const gptReduction = typeof vResult.score_reduction === 'number' ? vResult.score_reduction : 0;
              const finalBridge = Math.min(claudeBridge, gptBridge);
              const bridgeDiff = claudeBridge - finalBridge;
              const totalAdjustment = bridgeDiff + gptReduction;
              const finalScore = Math.max(0, claudeTotal - totalAdjustment);

              let finalVerdict = (vItem.discovery.verdict && vItem.discovery.verdict.verdict) || vItem.discovery.verdict || 'CONFIRMED DIRECTION';
              const wasHighValue = finalVerdict === 'HIGH-VALUE GAP';
              if (finalScore < 75 && wasHighValue) finalVerdict = 'CONFIRMED DIRECTION';
              if (finalScore < 50) finalVerdict = 'LOW PRIORITY';

              vItem.discovery.adversarial_adjustment = {
                gpt_bridge: gptBridge, gpt_reduction: gptReduction,
                bridge_diff: bridgeDiff, final_bridge: finalBridge,
                final_score: finalScore, final_verdict: finalVerdict,
                downgraded: wasHighValue && finalVerdict !== 'HIGH-VALUE GAP'
              };

              if (vItem.discovery.scores) {
                vItem.discovery.scores.adversarial_total = finalScore;
                vItem.discovery.scores.adversarial_bridge = finalBridge;
              }

              const findingsData = readFindings();
              const fIdx = findingsData.findings.findIndex(f => f.id === vItem.discovery.id);
              if (fIdx !== -1) {
                findingsData.findings[fIdx] = vItem.discovery;
                saveFindingsAtomic(findingsData);
              }

              this._log('info', `[VERIFIER] RESULT ${vItem.discovery.id} | Claude: ${claudeTotal} → GPT: -${totalAdjustment} → Final: ${finalScore} | verdict=${finalVerdict}${vItem.discovery.adversarial_adjustment.downgraded ? ' (DOWNGRADED)' : ''}`);

              recomputeMetricsNow('gpt_verification_saved', this._log.bind(this), this._emitError.bind(this));

              this.emit('verificationComplete', {
                discoveryId: vItem.discovery.id,
                result: vResult,
                adjustment: vItem.discovery.adversarial_adjustment
              });

              if (vResult.survives_scrutiny && vResult.gpt_verdict === 'CONFIRMED') {
                this.validationQueue.push(vItem.discovery);
                this._saveQueues();
                this._log('info', `[VALIDATOR] Queued ${vItem.discovery.id} for pre-experiment validation (queue: ${this.validationQueue.length})`);
              }
            } else if (vResult && vResult.error) {
              this.verificationQueue.shift();
              this._saveQueues();
              const cat = safeMetricCategory(vResult.category || 'unknown');
              updateMetrics({
                gpt_errors: 1,
                [`gpt_errors_${cat}`]: 1,
                last_error_category: cat,
                last_error: `Verifier error: ${vResult.error}`,
                last_error_at: new Date().toISOString()
              }, this._emitError.bind(this));
              this._log('error', `[VERIFIER] Failed (${cat}): ${vResult.error}`);
              this._emitError('verification', new Error(vResult.error), { category: cat });
            }
            // null means rate-limited — keep in queue
          } catch (err) {
            this._log('error', `[VERIFIER] Error: ${err.message}`);
            this._emitError('verification', err);
            const cat = safeMetricCategory(err.code || err.name || 'unknown');
            updateMetrics({
              gpt_errors: 1,
              [`gpt_errors_${cat}`]: 1,
              last_error_category: cat,
              last_error: `Verifier error: ${err.message}`,
              last_error_at: new Date().toISOString()
            }, this._emitError.bind(this));
            this.verificationQueue.shift();
            this._saveQueues();
          }
        }
      }
    }

    // === VALIDATION ===
    if (this.validationQueue.length > 0 && !lowSpendMode && !budgetPaused && (Date.now() - this._tickStartedAt) < TICK_TIME_BUDGET_MS) {
      const valDiscovery = this.validationQueue[0];
      try {
        const valResult = await withTimeout(validateGap(valDiscovery), QUEUE_TIMEOUT_MS, 'validator');
        if (valResult) {
          this.validationQueue.shift();
          this._saveQueues();

          updateMetrics({ validated: 1 }, this._emitError.bind(this));
          const feas = valResult.overall_feasibility || 'blocked';
          if (feas === 'ready_to_test') updateMetrics({ ready_to_test: 1 }, this._emitError.bind(this));
          else if (feas === 'needs_data') updateMetrics({ needs_data: 1 }, this._emitError.bind(this));
          else updateMetrics({ blocked: 1 }, this._emitError.bind(this));

          try {
            await recordGap(valResult);
          } catch (e) {
            this._log('error', `[GAP-RECORDER] ${e.message}`);
          }

          this.emit('validationComplete', {
            discoveryId: valDiscovery.id,
            result: valResult
          });
        }
        // null means rate-limited — keep in queue
      } catch (err) {
        this._log('error', `[VALIDATOR] Error: ${err.message}`);
        this._emitError('validation', err);
        this.validationQueue.shift();
        this._saveQueues();
      }
    }

    // === GITHUB MONITORING (every 27 ticks = once per cycle) ===
    if (tickNum % 27 === 0 && process.env.GITHUB_MONITOR_ENABLED !== 'false' && process.env.GITHUB_TOKEN && !budgetPaused) {
      try {
        const { checkWatchlist, scanTrending } = require('./github-monitor');
        const { detectGaps } = require('./paper-code-matcher');
        const { analyzeAndFindCollisions } = require('./dependency-graph');

        // Run watchlist check (cached 30min, so cheap)
        const watchlist = await checkWatchlist();
        this._log('info', `[GITHUB] Watchlist: ${watchlist.length} repos checked`);

        // Run trending scan (cached 1hr)
        const trending = await scanTrending();
        this._log('info', `[GITHUB] Trending: ${trending.length} repos`);

        // Run paper-code gap detection on a sample of cube papers vs GitHub repos
        const allRepos = [...watchlist.filter(r => !r.error), ...trending];
        if (allRepos.length > 0) {
          const { collisions } = await analyzeAndFindCollisions(allRepos);
          if (collisions.length > 0) {
            this._log('info', `[GITHUB] Dependency collisions: ${collisions.length} found`);
            appendFinding({
              id: `github-scan-${tickNum}`,
              type: 'github-scan',
              timestamp: new Date().toISOString(),
              tick: tickNum,
              watchlist_count: watchlist.length,
              trending_count: trending.length,
              collisions_count: collisions.length,
              top_collisions: collisions.slice(0, 3).map(c => ({
                dep: c.dependency,
                domains: c.domains,
                score: c.score
              }))
            });
          }
        }
      } catch (e) {
        this._log('error', `[GITHUB] Monitor failed: ${e.message}`);
      }
    }

    // === DAILY GAP PUBLISH ===
    try {
      const pub = publishDailyGapsIfNeeded({ maxGaps: 5 });
      if (pub.published && pub.published > 0) {
        this._log('info', `[PUBLISH] Added ${pub.published} gaps (total today: ${pub.total})`);
      }
    } catch (e) {
      this._log('error', `[PUBLISH] Failed: ${e.message}`);
    }

    // Emit metrics event
    this.emit('metrics', { tickNum, metrics: readMetrics() });
  }
}

module.exports = { TickEngine, readMetrics, updateMetrics, recomputeMetricsFromFindings };
