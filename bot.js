require("dotenv").config({ path: require("path").join(__dirname, ".env"), override: true });

// Safe boot log — never prints full keys
{
  const k = process.env.OPENAI_API_KEY || '';
  const a = process.env.ANTHROPIC_API_KEY || '';
  const d = process.env.DISCORD_TOKEN || '';
  console.log(`[BOOT] env: openai_key_present=${!!k} openai_len=${k.length} openai_last4=${k.slice(-4) || 'n/a'} anthropic_present=${!!a} discord_present=${!!d}`);
}

/**
 * CLASHD-27 — Clock Bot
 * 27 cells. One clock. Agents clash.
 */

const {
  Client, GatewayIntentBits, EmbedBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { State, ENERGY, getActivePack, getCellLabel } = require('./lib/state');
const {
  renderCube, cellLabel, cellLabelShort, getNeighbors,
  getNeighborsByType, getNeighborType, getLayerName, getLayerForCell, isCrossLayer, neighborSummary,
  NEIGHBOR_TYPE, NEIGHBOR_INFO,
} = require('./lib/cube');
const { investigateCell, investigateBond, investigateDiscovery, investigateVerification, readFindings, queueFollowUps, getNextFollowUp, trackApiCall, isCircuitOpen, circuitBreakerWarn } = require('./lib/researcher');
const { deepDive, readDeepDives } = require('./lib/deep-dive');
const { verifyGap } = require('./lib/verifier');
const { validateGap } = require('./lib/validator');
const { checkSaturation } = require('./lib/saturation');
const budget = require('./lib/budget');

const MIN_COLLISION_SCORE = parseFloat(process.env.MIN_COLLISION_SCORE || '0.3');
const DEEP_DIVE_THRESHOLD = parseInt(process.env.DEEP_DIVE_THRESHOLD || '75', 10);
const MAX_DEEP_DIVES_PER_DAY = parseInt(process.env.MAX_DEEP_DIVES_PER_DAY || '5', 10);
const VERIFIER_MIN_SCORE = parseInt(process.env.VERIFIER_MIN_SCORE || '70', 10);

// --- Atomic findings.json helpers ---
function saveFindingsAtomic(data) {
  if (Array.isArray(data.findings) && data.findings.length > 1000) {
    data.findings = data.findings.slice(-1000);
  }
  const tmpF = FINDINGS_FILE_PATH + '.tmp';
  require('fs').writeFileSync(tmpF, JSON.stringify(data, null, 2));
  require('fs').renameSync(tmpF, FINDINGS_FILE_PATH);
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

// --- Review Pack Builder ---
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

const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL || '300') * 1000; // 5 minutes (rate limits)
const CHANNEL_PREFIX = 'cel-';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const state = new State();
let clockTimer = null;
const channels = {};

// Research state — persisted to disk so PM2 restarts don't lose queued items
const QUEUES_FILE = require('path').join(__dirname, 'data', 'queues.json');
const TICK_LOCK_FILE = require('path').join(__dirname, 'data', '.tick.lock');
const TICK_LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
function normalizeDeepDiveQueue(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (item && item.discovery) {
      return {
        discovery: item.discovery,
        attempts: item.attempts || 0,
        last_error: item.last_error || null
      };
    }
    return { discovery: item, attempts: 0, last_error: null };
  }).filter(item => item && item.discovery);
}

function loadQueues() {
  try {
    const raw = require('fs').readFileSync(QUEUES_FILE, 'utf8');
    const q = JSON.parse(raw);
    return {
      deepDive: normalizeDeepDiveQueue(q.deepDive),
      verification: Array.isArray(q.verification) ? q.verification : [],
      validation: Array.isArray(q.validation) ? q.validation : [],
    };
  } catch { return { deepDive: [], verification: [], validation: [] }; }
}
function saveQueues() {
  const tmp = QUEUES_FILE + '.tmp';
  require('fs').writeFileSync(tmp, JSON.stringify({ deepDive: deepDiveQueue, verification: verificationQueue, validation: validationQueue }, null, 2));
  require('fs').renameSync(tmp, QUEUES_FILE);
}
const _savedQueues = loadQueues();
let deepDiveQueue = _savedQueues.deepDive;
let verificationQueue = _savedQueues.verification;
let validationQueue = _savedQueues.validation;
if (deepDiveQueue.length || verificationQueue.length || validationQueue.length) {
  console.log(`[QUEUES] Restored: deepDive=${deepDiveQueue.length}, verification=${verificationQueue.length}, validation=${validationQueue.length}`);
}

// --- Collision cache (per cube generation) ---
let collisionCache = new Set();
let collisionCacheGeneration = null;

function recordDeepDiveFailure(item, message) {
  item.attempts = (item.attempts || 0) + 1;
  item.last_error = message || 'unknown';
  if (item.attempts >= 3) {
    console.warn(`[DEEP-DIVE] Dropping ${item.discovery.id} after ${item.attempts} failures: ${item.last_error}`);
    deepDiveQueue.shift();
  } else {
    console.warn(`[DEEP-DIVE] Will retry ${item.discovery.id} (${item.attempts}/3): ${item.last_error}`);
  }
  saveQueues();
}

// --- Tick lock (cross-process overlap guard) ---
function acquireTickLock() {
  try {
    const fs = require('fs');
    const dir = require('path').dirname(TICK_LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(TICK_LOCK_FILE)) {
      try {
        const raw = fs.readFileSync(TICK_LOCK_FILE, 'utf8');
        const lock = JSON.parse(raw);
        const ageMs = Date.now() - (lock.ts || 0);
        if (ageMs < TICK_LOCK_STALE_MS) {
          console.warn(`[LOCK] Tick lock present (${Math.round(ageMs / 1000)}s old) — skipping tick`);
          return false;
        }
        console.warn(`[LOCK] Stale tick lock detected (${Math.round(ageMs / 1000)}s old) — overwriting`);
      } catch (e) {
        console.warn('[LOCK] Corrupt tick lock — overwriting');
      }
    }
    const tmp = TICK_LOCK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    fs.renameSync(tmp, TICK_LOCK_FILE);
    return true;
  } catch (e) {
    console.error(`[LOCK] Failed to acquire tick lock: ${e.message}`);
    return false;
  }
}

function releaseTickLock() {
  try {
    const fs = require('fs');
    if (fs.existsSync(TICK_LOCK_FILE)) fs.unlinkSync(TICK_LOCK_FILE);
  } catch (e) {
    console.error(`[LOCK] Failed to release tick lock: ${e.message}`);
  }
}

// --- Metrics ---
const METRICS_FILE = require('path').join(__dirname, 'data', 'metrics.json');
const FINDINGS_FILE_PATH = require('path').join(__dirname, 'data', 'findings.json');

function readMetrics() {
  try {
    if (require('fs').existsSync(METRICS_FILE)) {
      return JSON.parse(require('fs').readFileSync(METRICS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

/** Detect legacy discoveries: missing abc_chain, kill_test, or scores */
function isLegacyDiscovery(f) {
  if (f.type !== 'discovery') return false;
  return !f.abc_chain || !f.kill_test || !f.scores;
}

/** Recompute metrics from findings.json + verifications.json (ground truth) */
function recomputeMetricsFromFindings() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(FINDINGS_FILE_PATH)) return;
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
      if (attemptsBackfilled > 0) console.log(`[METRICS] Backfilled ${attemptsBackfilled} attempt records`);
    }

    // Verdict counts (all discoveries)
    let countHighValue = 0;
    let countConfirmed = 0;
    let countNeedsWork = 0;
    let countLowPriority = 0;
    for (const d of allDiscoveries) {
      const vStr = (d.verdict && d.verdict.verdict) || d.verdict || '';
      if (vStr === 'HIGH-VALUE GAP') countHighValue++;
      else if (vStr === 'CONFIRMED DIRECTION') countConfirmed++;
      else if (vStr === 'NEEDS WORK') countNeedsWork++;
      else if (vStr === 'LOW PRIORITY') countLowPriority++;
    }

    // Strict averages
    let scoreSum = 0;
    let bridgeSum = 0;
    let specSum = 0;
    let strictCount = 0;
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
    let gptReviewed = 0;
    let gptConfirmed = 0;
    let gptWeakened = 0;
    let gptKilled = 0;
    try {
      const vFile = require('path').join(__dirname, 'data', 'verifications.json');
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
    for (const k of ['gap_rate','rejection_rate','high_value_rate','strict_gap_rate']) {
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
      console.log(`[METRICS] Recomputed from findings: att=${countAttempts} disc=${countDiscovery} no_gap=${countNoGap} strict=${strictDiscoveries.length} legacy=${legacyDiscoveries.length}`);
    }
  } catch (e) {
    console.error(`[METRICS] Recompute failed: ${e.message}`);
  }
}
recomputeMetricsFromFindings();

// --- Epoch Marker: set once at first startup, never overwritten ---
(function initEpoch() {
  try {
    const m = readMetrics();
    if (!m.epoch_started_at) {
      const { execSync } = require('child_process');
      let gitHash = 'unknown';
      try { gitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch (e) {}
      const state = new (require('./lib/state').State)();
      m.epoch_started_at = new Date().toISOString();
      m.epoch_git_commit = gitHash;
      m.epoch_tick_start = state.tick;
      const tmpFile = METRICS_FILE + '.tmp';
      require('fs').writeFileSync(tmpFile, JSON.stringify(m, null, 2));
      require('fs').renameSync(tmpFile, METRICS_FILE);
      console.log(`[EPOCH] Initialized: commit=${gitHash} tick=${state.tick}`);
    }
  } catch (e) {
    console.error(`[EPOCH] Init failed: ${e.message}`);
  }
})();

function updateMetrics(updates) {
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

    // Calculated rates (percentages) — total includes legacy
    const att = m.total_discovery_attempts || 0;
    if (att > 0) {
      m.gap_rate = Math.round(((m.total_discoveries || 0) / att) * 1000) / 10;
      m.rejection_rate = Math.round((((m.total_no_gap || 0) + (m.total_drafts || 0) + (m.total_duplicates || 0)) / att) * 1000) / 10;
      m.high_value_rate = Math.round(((m.total_high_value || 0) / att) * 1000) / 10;

      // Strict rates: exclude legacy discoveries
      const strictDisc = (m.strict_discoveries_count || 0);
      m.strict_gap_rate = Math.round((strictDisc / att) * 1000) / 10;
    }
    // Remove misleading alias
    delete m.survival_rate;
    delete m.red_flag_rate;

    // GPT survival rate
    if ((m.gpt_reviewed || 0) > 0) {
      m.gpt_survival_rate = Math.round(((m.gpt_confirmed || 0) / m.gpt_reviewed) * 1000) / 10;
    } else {
      m.gpt_survival_rate = 0;
    }

    // Precision@k: null until enough labels
    const lt = m.labeled_total || 0;
    if (lt < 5) { m.precision_at_5 = null; m.precision_at_5_status = 'INSUFFICIENT_LABELS'; }
    else { delete m.precision_at_5_status; }
    if (lt < 10) { m.precision_at_10 = null; m.precision_at_10_status = 'INSUFFICIENT_LABELS'; }
    else { delete m.precision_at_10_status; }

    m.last_updated = new Date().toISOString();

    // Atomic write: write to tmp then rename
    const dir = require('path').dirname(METRICS_FILE);
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
    const tmpFile = METRICS_FILE + '.tmp';
    require('fs').writeFileSync(tmpFile, JSON.stringify(m, null, 2));
    require('fs').renameSync(tmpFile, METRICS_FILE);
    return m;
  } catch (e) {
    console.error(`[METRICS] Update failed: ${e.message}`);
    return {};
  }
}

function logMetrics(tickNum) {
  if (tickNum % 10 !== 0) return;
  const m = readMetrics();
  const attempts = m.total_discovery_attempts || 0;
  const gaps = m.total_discoveries || 0;
  const pct = m.gap_rate || 0;
  const hv = m.total_high_value || 0;
  const reject = m.rejection_rate || 0;
  console.log(`[METRICS] attempts=${attempts} gaps=${gaps} (${pct}%) HV=${hv} reject=${reject}% cost_today=$${(m.estimated_cost_today || 0).toFixed(2)}`);
  if ((m.estimated_cost_today || 0) > 0) {
    console.log(`[COST] Today: $${(m.estimated_cost_today || 0).toFixed(2)} (${m.api_calls_today || 0} calls) | Total: $${(m.estimated_cost_total || 0).toFixed(2)} (${m.api_calls_total || 0} calls)`);
  }
}

function recomputeMetricsNow(reason) {
  try {
    recomputeMetricsFromFindings();
    if (reason) console.log(`[METRICS] Recompute triggered: ${reason}`);
  } catch (e) {
    console.error(`[METRICS] Recompute failed: ${e.message}`);
  }
}

function safeMetricCategory(cat) {
  return String(cat || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

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
  if (agent.findingsCount === undefined) agent.findingsCount = 0;
  if (agent.bondsWithFindings === undefined) agent.bondsWithFindings = 0;
  if (agent.discoveriesCount === undefined) agent.discoveriesCount = 0;
}

async function cacheChannels(guild) {
  const allChannels = await guild.channels.fetch();
  for (const [, ch] of allChannels) {
    if (ch.type === ChannelType.GuildText) channels[ch.name] = ch;
  }
  console.log(`[CHANNELS] Cached ${Object.keys(channels).length} text channels`);
}

function getChannel(name) { return channels[name] || null; }

async function sendToChannel(name, content) {
  const ch = getChannel(name);
  if (ch) {
    try { await ch.send(content); } catch (err) { console.error(`[SEND] #${name}: ${err.message}`); }
  }
}

function tickEmbed(tickNum, activeCell, cycle) {
  const nByType = getNeighborsByType(activeCell);
  const occupants = state.getGridState();
  const agentsHere = occupants.get(activeCell) || 0;
  return new EmbedBuilder()
    .setColor(0xFF4500)
    .setTitle(`⏱ TICK ${tickNum}`)
    .setDescription(
      `**Active: cell ${activeCell}** (${cellLabel(activeCell)})\n` +
      `Layer: ${getLayerName(activeCell)} | Cycle: ${cycle} | Agents here: ${agentsHere}\n\n` +
      `🟥 Face [+${ENERGY.CLASH_FACE}%]: ${nByType.face.join(', ') || '—'}\n` +
      `🟧 Edge [+${ENERGY.CLASH_EDGE}%]: ${nByType.edge.join(', ') || '—'}\n` +
      `🟨 Corner [+${ENERGY.CLASH_CORNER}%]: ${nByType.corner.join(', ') || '—'}`
    )
    .setFooter({ text: `CLASHD-27 | Next tick in ${TICK_INTERVAL / 1000}s` })
    .setTimestamp();
}

function eventEmbed(events) {
  if (events.length === 0) return null;
  const lines = events.map(e => {
    switch (e.type) {
      case 'resonance': return `✨ **${e.agent}** resonates in cell ${e.cell}${e.isHome ? ' 🏠' : ''} [${e.energy}%]`;
      case 'clash': { const info = NEIGHBOR_INFO[e.neighborType]; return `${info?.emoji || '⚡'} **${e.agent}** ${e.neighborType} clash from ${e.fromCell}→${e.activeCell} [+${e.gain}%→${e.energy}%]`; }
      case 'bond': return `🔗 **BOND** — ${e.agent1} ⟷ ${e.agent2} in cell ${e.cell} [+${e.bonus}%]${e.crossLayer ? ' 🌈 CROSS-LAYER' : ''}`;
      case 'death': return `💀 **${e.agent}** died in cell ${e.cell}. Revive in cell ${e.homeCell}.`;
      case 'revive': return `🔄 **${e.reviver}** revived **${e.revived}** in cell ${e.cell}`;
      default: return `❓ Unknown event`;
    }
  });
  return new EmbedBuilder().setColor(0xFFD700).setTitle('📡 Live Feed').setDescription(lines.join('\n')).setTimestamp();
}

function cycleEmbed(summary) {
  const hotCells = [...summary.cellHeat.entries()].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0).slice(0, 5)
    .map(([cell, heat]) => `Cell ${cell} (${cellLabel(cell)}): ${heat} bonds`).join('\n') || 'No bonds this cycle';
  const topAgents = summary.topAgents.map((a, i) =>
    `${i + 1}. **${a.name}** — ${a.energy}% ⚡ | ${a.bonds} bonds (${a.crossLayer} cross-layer) | streak ${a.streak}`
  ).join('\n') || 'No agents alive';
  return new EmbedBuilder().setColor(0x9B59B6).setTitle(`📊 Cycle ${summary.cycle} Complete`)
    .setDescription(`**Population:** ${summary.alive} alive / ${summary.dead} dead / ${summary.totalAgents} total\n**Bonds:** ${summary.bondsThisCycle} this cycle (${summary.crossLayerBonds} cross-layer) | ${summary.totalBonds} total\n\n**🔥 Hottest Cells:**\n${hotCells}\n\n**🏆 Top Agents:**\n${topAgents}`)
    .setTimestamp();
}

function leaderboardEmbed() {
  const lb = state.getLeaderboard();
  const energyList = lb.byEnergy.map((a, i) => `${i + 1}. **${a.displayName}** — ${a.energy}% ⚡`).join('\n') || 'No agents';
  const bondsList = lb.byBonds.map((a, i) => `${i + 1}. **${a.displayName}** — ${a.totalBonds} bonds`).join('\n') || 'No bonds yet';
  const streakList = lb.byStreak.map((a, i) => { const best = Math.max(a.survivalStreak, a.longestStreak); return `${i + 1}. **${a.displayName}** — ${best} ticks ${a.alive ? '🟢' : '💀'}`; }).join('\n') || 'No agents';
  const crossList = lb.byCrossLayer.length > 0 ? lb.byCrossLayer.map((a, i) => `${i + 1}. **${a.displayName}** — ${a.crossLayerBonds} cross-layer bonds`).join('\n') : 'No cross-layer bonds yet';
  return new EmbedBuilder().setColor(0xE74C3C).setTitle('🏆 CLASHD-27 Leaderboard')
    .addFields(
      { name: '⚡ Energy', value: energyList, inline: false },
      { name: '🔗 Bonds', value: bondsList, inline: false },
      { name: '🌈 Cross-Layer', value: crossList, inline: false },
      { name: '🔥 Survival', value: streakList, inline: false },
    )
    .setFooter({ text: `Tick ${state.tick} | ${state.agents.size} agents` }).setTimestamp();
}

function statusEmbed(agent) {
  const activeCell = state.tick % 27;
  const neighbors = getNeighbors(activeCell);
  let proximity = '😴 Idle (-2%)';
  if (agent.currentCell === activeCell) proximity = '✨ IN ACTIVE CELL (+15%)';
  else if (neighbors.includes(agent.currentCell)) {
    const nType = getNeighborType(agent.currentCell, activeCell);
    const info = NEIGHBOR_INFO[nType];
    proximity = `${info.emoji} ${info.label} neighbor of active cell`;
  }
  const cc = agent.clashCounts || { face: 0, edge: 0, corner: 0 };
  return new EmbedBuilder()
    .setColor(agent.alive ? 0x2ECC71 : 0x95A5A6)
    .setTitle(`Agent: ${agent.displayName}`)
    .setDescription(
      `**Status:** ${agent.alive ? '🟢 Alive' : '💀 Dead'}\n` +
      `**Number:** ${agent.chosenNumber} → Home cell: ${agent.homeCell} (${getLayerName(agent.homeCell)})\n` +
      `**Current cell:** ${agent.currentCell} (${cellLabel(agent.currentCell)})${agent.currentCell === agent.homeCell ? ' 🏠' : ''}\n` +
      `**Energy:** ${agent.energy}%\n**Proximity:** ${proximity}\n\n` +
      `**Bonds:** ${agent.totalBonds} total (${agent.crossLayerBonds || 0} cross-layer)\n` +
      `**Clashes:** 🟥 ${cc.face} face · 🟧 ${cc.edge} edge · 🟨 ${cc.corner} corner\n` +
      `**Survival:** ${agent.survivalStreak} current / ${agent.longestStreak} best\n**Deaths:** ${agent.deaths}`
    ).setTimestamp();
}

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

  // Find highest-scoring dive
  const sorted = [...ddData.dives].sort((a, b) => (b.scores?.total || 0) - (a.scores?.total || 0));
  const bestDive = sorted[0];
  if (!bestDive) return null;

  // Find the source discovery
  const findings = readFindings();
  const discovery = (findings.findings || []).find(f => f.id === bestDive.discovery_id);
  if (!discovery) return null;

  // Extract claims from the discovery text
  const claims = [];
  if (discovery.discovery) claims.push(discovery.discovery);
  if (discovery.gap) claims.push(discovery.gap);
  if (discovery.proposed_experiment) claims.push(discovery.proposed_experiment);

  // Check which claims have already been verified
  const verified = (bestDive.verifications || []).map(v => v.claim);

  // Find first unverified claim
  for (const claim of claims) {
    if (!verified.includes(claim)) {
      return { dive: bestDive, discovery, claim };
    }
  }
  // All claims verified on best dive, try next
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

// Timeout wrapper for optional async work (deep-dive, verifier, validator)
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label} (${ms}ms)`)), ms))
  ]);
}
const QUEUE_TIMEOUT_MS = 90_000; // 90s per queue operation
const TICK_TIME_BUDGET_MS = 240_000; // 240s soft budget for optional work

let _tickRunning = false;
let _tickStartedAt = 0;
async function tick() {
  if (_tickRunning) { console.log('[TICK] SKIP overlap'); return; }
  if (!acquireTickLock()) return;
  _tickRunning = true;
  _tickStartedAt = Date.now();
  try { await _tickInner(); }
  finally {
    _tickRunning = false;
    releaseTickLock();
  }
}
async function _tickInner() {
  const result = state.processTick();
  const { tick: tickNum, activeCell, cycle, events, isCycleEnd } = result;
  console.log(`[TICK] ${tickNum} | cell=${activeCell} (${cellLabelShort(activeCell)}) | events=${events.length}`);
  logMetrics(tickNum);
  if (tickNum % 10 === 0) recomputeMetricsFromFindings();
  await sendToChannel('clock', { embeds: [tickEmbed(tickNum, activeCell, cycle)] });
  if (events.length > 0) {
    const embed = eventEmbed(events);
    if (embed) await sendToChannel('live', { embeds: [embed] });
    const cellEvents = events.filter(e => ['resonance','clash','bond','revive'].includes(e.type));
    if (cellEvents.length > 0) { const ce = eventEmbed(cellEvents); if (ce) await sendToChannel(`${CHANNEL_PREFIX}${activeCell}`, { embeds: [ce] }); }
    for (const d of events.filter(e => e.type === 'death')) {
      await sendToChannel('graveyard', `💀 **${d.agent}** fell at tick ${d.tick}. Awaiting revive in cell ${d.homeCell} (${cellLabel(d.homeCell)})...`);
    }
  }
  if (isCycleEnd) {
    await sendToChannel('residue', { embeds: [cycleEmbed(state.getCycleSummary())] });
    await sendToChannel('leaderboard', { embeds: [leaderboardEmbed()] });
  }

  // === COST GUARD: skip expensive pipeline steps if over daily budget ===
  const costMetrics = readMetrics();
  const lowSpendMode = (costMetrics.estimated_cost_today || 0) > 5.00;
  if (lowSpendMode && tickNum % 50 === 0) {
    console.log(`[COST] WARNING $${(costMetrics.estimated_cost_today || 0).toFixed(2)} today — low-spend mode active (skipping deep-dive/verification)`);
  }

  const budgetStatus = budget.getStatus();
  if (budgetStatus.overBudget || !budget.canAffordCall('claude-haiku-4-5-20251001', 2000)) {
    console.log(`[BUDGET] Daily limit reached ($${budgetStatus.todaySpent.toFixed(2)}). Pausing research until midnight UTC.`);
    state.save();
    return;
  }

  // === CUBE SHUFFLE (Anomaly Magnet v2.0) ===
  if (process.env.USE_CUBE === 'true') {
    try {
      const { shouldShuffle, shuffle, readCube } = require('./lib/shuffler');
      const cube = readCube();
      const lastShuffle = cube ? cube.createdAtTick : null;

      if (shouldShuffle(tickNum, lastShuffle) && !global._shuffleInProgress) {
        global._shuffleInProgress = true;
        const gen = cube ? cube.generation : 0;
        console.log(`[SHUFFLE] Triggering cube shuffle at tick ${tickNum} (generation ${gen} → ${gen + 1})`);

        // Run async — does not block tick loop
        shuffle(tickNum, gen, (fetched, total) => {
          if (fetched % 100 === 0) console.log(`[SHUFFLE] Progress: ${fetched}/${total} papers`);
        }).then(newCube => {
          console.log(`[SHUFFLE] Complete: generation ${newCube.generation}, ${newCube.totalPapers} papers (${newCube.shuffleDurationMs}ms)`);
          global._shuffleInProgress = false;
          // Log shuffle event to findings
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
          });
        }).catch(err => {
          console.error(`[SHUFFLE] Failed: ${err.message}`);
          global._shuffleInProgress = false;
        });
      }
    } catch (err) {
      console.error(`[SHUFFLE] Init error: ${err.message}`);
    }
  }

  // Move all alive agents to active cell
  for (const [, agent] of state.agents) {
    if (agent.alive && agent.currentCell !== activeCell) {
      agent.currentCell = activeCell;
    }
  }
  state.save();
  // === ACTIVE RESEARCH (max 1 API call per tick) ===
  const agentsHere = []; for (const [, a] of state.agents) { if (a.alive && a.currentCell === activeCell) agentsHere.push(a); }
  const pack = getActivePack();
  const packLabel = getCellLabel(activeCell);
  const cubeLabel = cellLabelShort(activeCell);
  const label = packLabel !== `Cell ${activeCell}` ? packLabel : cubeLabel;
  const packName = pack ? pack.name : 'Research';

  if (agentsHere.length > 0 && pack) {
    for (const agent of agentsHere) {
      ensureResearchFields(agent);
    }

    let apiUsed = false;

    // Circuit breaker: skip all API research if Anthropic credits exhausted
    if (isCircuitOpen()) {
      circuitBreakerWarn(tickNum);
      return;
    }

    // Rotate through ALL 5 cross-layer pairs using tickNum % 5
    // Layer 0: home 0 (Genomics), home 4 (Epidemiology)
    // Layer 1: home 9 (Drug Interactions)
    // Layer 2: home 18 (Novel Combinations)
    const CROSS_LAYER_PAIRS = [
      [0, 9],   // Agent-001 (L0) × Agent-002 (L1)
      [0, 18],  // Agent-001 (L0) × Agent-003 (L2)
      [4, 9],   // greenbanaanas (L0) × Agent-002 (L1)
      [4, 18],  // greenbanaanas (L0) × Agent-003 (L2)
      [9, 18],  // Agent-002 (L1) × Agent-003 (L2)
    ];
    const pairIdx = tickNum % CROSS_LAYER_PAIRS.length;
    const [home1, home2] = CROSS_LAYER_PAIRS[pairIdx];
    const allAgents = agentsHere;
    let agent1 = allAgents.find(a => a.homeCell === home1);
    let agent2 = allAgents.find(a => a.homeCell === home2);

    if (agent1 && agent2 && agent1.homeCell !== agent2.homeCell) {
      const a1Label = getCellLabel(agent1.homeCell);
      const a2Label = getCellLabel(agent2.homeCell);
      const crossLayer = isCrossLayer(agent1.homeCell, agent2.homeCell);

      if (crossLayer) {
        // Check if this cell-label combo already has 2+ discoveries
        const priorDiscoveries = getPriorDiscoveries(a1Label, a2Label);
        if (priorDiscoveries.length >= 2) {
          console.log(`[RESEARCH] SKIP discovery: ${a1Label} × ${a2Label} already has ${priorDiscoveries.length} discoveries`);
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
                console.log(`[RESEARCH] ${vResult.id} | VERIFY | ${claimData.discovery.id} | verified=${vResult.verified} confidence=${vResult.confidence}`);
                // Update deep dive with verification
                const { saveDeepDive } = require('./lib/deep-dive');
                if (!claimData.dive.verifications) claimData.dive.verifications = [];
                claimData.dive.verifications.push({
                  claim: claimData.claim,
                  verified: vResult.verified,
                  confidence: vResult.confidence,
                  source: vResult.source || '',
                  finding_id: vResult.id
                });
                // Adjust total score: +5 verified, -10 contradicted
                if (vResult.verified) {
                  claimData.dive.scores.total = Math.min(100, claimData.dive.scores.total + 5);
                } else {
                  claimData.dive.scores.total = Math.max(0, claimData.dive.scores.total - 10);
                }
                saveDeepDive(claimData.dive);
              }
              apiUsed = true;
            } catch (err) {
              console.error(`[RESEARCH] Verification error: ${err.message}`);
            }
          }
        } else {
          // Cross-layer: discovery investigation
          // Assign lower-layer agent as "data" side, higher as "hypothesis" side
          const layer1 = getLayerForCell(agent1.homeCell);
          const layer2 = getLayerForCell(agent2.homeCell);
          const dataAgent = layer1 <= layer2 ? agent1 : agent2;
          const hypoAgent = dataAgent === agent1 ? agent2 : agent1;
          const dataLabel = getCellLabel(dataAgent.homeCell);
          const hypoLabel = getCellLabel(hypoAgent.homeCell);
          const pairId = `${dataLabel.replace(/\s+/g, '')}_${hypoLabel.replace(/\s+/g, '')}`;
          const attemptId = `att-${tickNum}-${pairId}`;

          // --- Golden collision scoring + cache (when cube data exists) ---
          let goldenMeta = null;
          let dataCubeDesc = null;
          let hypoCubeDesc = null;
          const cubeMode = process.env.USE_CUBE === 'true';

          try {
            const { goldenCollisionScore, getCubeDescription, readCube } = require('./lib/shuffler');
            const cube = readCube();
            const cubeGen = cube ? cube.generation : null;
            if (cubeGen !== collisionCacheGeneration) {
              collisionCacheGeneration = cubeGen;
              collisionCache = new Set();
            }
            if (cubeGen !== null) {
              const cellA = Math.min(dataAgent.homeCell, hypoAgent.homeCell);
              const cellB = Math.max(dataAgent.homeCell, hypoAgent.homeCell);
              const collisionKey = `${cellA}-${cellB}-gen${cubeGen}`;
              if (collisionCache.has(collisionKey)) {
                console.log(`[CACHE] Collision ${collisionKey} already evaluated this generation — skipping`);
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
                recomputeMetricsNow('collision_skipped_cached');
                return;
              }
              collisionCache.add(collisionKey);
            }

            goldenMeta = goldenCollisionScore(dataAgent.homeCell, hypoAgent.homeCell);
            if (cubeMode) {
              dataCubeDesc = getCubeDescription(dataAgent.homeCell);
              hypoCubeDesc = getCubeDescription(hypoAgent.homeCell);
            }

            if (goldenMeta && goldenMeta.golden) {
              console.log(`[GOLDEN] Score ${goldenMeta.score} | ${goldenMeta.cellA.method} x ${goldenMeta.cellB.method} | surprise: ${goldenMeta.cellA.surprise} x ${goldenMeta.cellB.surprise}`);
            }

            if (goldenMeta && typeof goldenMeta.score === 'number' && !goldenMeta.reason && goldenMeta.score < MIN_COLLISION_SCORE) {
              console.log(`[SKIP] Collision score ${goldenMeta.score.toFixed(2)} below threshold ${MIN_COLLISION_SCORE} — skipping Claude API call`);
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
              recomputeMetricsNow('collision_skipped_score');
              return;
            }

            // Safety: fall back to pack mode if cube cells are too thin
            if (dataCubeDesc && dataCubeDesc.paperCount < 3) {
              console.log(`[CUBE] Cell ${dataAgent.homeCell} too thin (${dataCubeDesc.paperCount} papers) — falling back to pack labels`);
              dataCubeDesc = null;
              hypoCubeDesc = null;
            }
            if (hypoCubeDesc && hypoCubeDesc.paperCount < 3) {
              console.log(`[CUBE] Cell ${hypoAgent.homeCell} too thin (${hypoCubeDesc.paperCount} papers) — falling back to pack labels`);
              dataCubeDesc = null;
              hypoCubeDesc = null;
            }
          } catch (e) {
            console.error(`[CUBE] Golden scoring error: ${e.message}`);
          }

          // Build prior summary for the prompt
          const priorSummary = priorDiscoveries.length > 0
            ? priorDiscoveries.map(d => d.discovery || d.gap || '').filter(Boolean).join('; ')
            : '';

          // Meeting point: the active cell domain provides additional context
          const meetingPointLabel = label;

          // --- Attempt Event: persist to findings.json before API call ---
          const attemptRecord = {
            id: attemptId,
            type: 'attempt',
            timestamp: new Date().toISOString(),
            tick: tickNum,
            pair: { a: dataAgent.displayName, b: hypoAgent.displayName },
            domains: { domain_a: dataLabel, domain_b: hypoLabel, meeting_cell: meetingPointLabel },
            goldenCollision: goldenMeta,
            result: { outcome: 'pending', reason: '', discovery_id: null }
          };
          appendFinding(attemptRecord);
          recomputeMetricsNow('attempt_recorded');

          try {
            const discovery = await investigateDiscovery({
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
              goldenCollision: goldenMeta
            });

            // Attach golden collision metadata to discovery
            if (discovery && goldenMeta) {
              discovery.goldenCollision = goldenMeta;
              if (goldenMeta.golden) {
                updateMetrics({ total_golden_collisions: 1 });
              }
            }

            if (discovery) {
              // Handle no_gap responses
              if (discovery.type === 'no_gap') {
                updateFindingById(attemptId, { result: { outcome: 'no_gap', reason: discovery.reason || 'insufficient evidence', discovery_id: null }, completed_at: new Date().toISOString() });
                recomputeMetricsNow('no_gap_recorded');
              } else {
                // Track by type
                if (discovery.type === 'discovery') {
                  dataAgent.discoveriesCount = (dataAgent.discoveriesCount || 0) + 1;
                  hypoAgent.discoveriesCount = (hypoAgent.discoveriesCount || 0) + 1;
                }

                dataAgent.bondsWithFindings = (dataAgent.bondsWithFindings || 0) + 1;
                hypoAgent.bondsWithFindings = (hypoAgent.bondsWithFindings || 0) + 1;
                console.log(`[RESEARCH] ${discovery.id} | ${(discovery.type || 'discovery').toUpperCase()} | ${dataLabel} x ${hypoLabel} | verdict=${discovery.verdict?.verdict || discovery.verdict || 'none'}`);

                // Log S2 metadata if present
                if (discovery.s2_metadata) {
                  const s2 = discovery.s2_metadata;
                  console.log(`[S2] ${discovery.id} | prefetched=${s2.papers_prefetched} verified=${s2.sources_verified}/${s2.sources_total} (${s2.verification_rate}%)`);
                }

                // Finalize attempt: map verdict to outcome
                const vFinal = (discovery.verdict && discovery.verdict.verdict) || discovery.verdict || '';
                const outcomeMap = { 'HIGH-VALUE GAP': 'high_value', 'CONFIRMED DIRECTION': 'confirmed_direction', 'NEEDS WORK': 'needs_work', 'LOW PRIORITY': 'low_priority' };
                updateFindingById(attemptId, { result: { outcome: outcomeMap[vFinal] || 'discovery', reason: vFinal, discovery_id: discovery.id }, completed_at: new Date().toISOString() });
                recomputeMetricsNow('discovery_recorded');

                // Queue follow-up questions from this discovery
                if (discovery.type === 'discovery') {
                  const queued = queueFollowUps(discovery);
                  if (queued.length > 0) {
                    console.log(`[FOLLOW-UP] Queued ${queued.length} follow-ups from ${discovery.id}: ${queued.map(q => q.id).join(', ')}`);
                  }
                }

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
                      updateMetrics({ saturation_checks: 1 });
                      console.log(`[SATURATION] ${discovery.id} | score=${satResult.field_saturation_score} | papers=${satResult.paper_estimate_5y} | trials=${satResult.trial_count} | field=${satResult.established_field_name || 'none'}`);

                      if (satResult.field_saturation_score >= 60) {
                        discovery.verdict = { verdict: 'CONFIRMED DIRECTION', reason: `Saturation downgrade (score ${satResult.field_saturation_score}): ${satResult.reasoning}` };
                        verdictStr = 'CONFIRMED DIRECTION';
                        updateMetrics({ saturation_downgrades: 1 });
                        console.log(`[SATURATION] ${discovery.id} DOWNGRADED to CONFIRMED DIRECTION (saturation=${satResult.field_saturation_score})`);
                      } else if (satResult.field_saturation_score >= 40) {
                        if (discovery.scores && typeof discovery.scores.novelty === 'number') {
                          discovery.scores.novelty = Math.max(0, discovery.scores.novelty - 5);
                          discovery.scores.total = Math.max(0, (discovery.scores.total || 0) - 5);
                        }
                        updateMetrics({ saturation_penalties: 1 });
                        console.log(`[SATURATION] ${discovery.id} novelty penalized -5 (saturation=${satResult.field_saturation_score})`);
                      } else {
                        updateMetrics({ saturation_passed: 1 });
                        console.log(`[SATURATION] ${discovery.id} PASSED saturation check (score=${satResult.field_saturation_score})`);
                      }
                    }
                  } catch (satErr) {
                    console.error(`[SATURATION] Check failed for ${discovery.id}: ${satErr.message}`);
                  }
                }

                // Build review pack for reviewable discoveries (not NEEDS WORK / LOW PRIORITY)
                if (discovery.type === 'discovery' && (verdictStr === 'HIGH-VALUE GAP' || verdictStr === 'CONFIRMED DIRECTION')) {
                  discovery.review_pack = buildReviewPack(discovery);
                  const findingsData = readFindings();
                  const fIdx = (findingsData.findings || []).findIndex(f => f.id === discovery.id);
                  if (fIdx !== -1) {
                    findingsData.findings[fIdx] = discovery;
                    saveFindingsAtomic(findingsData);
                  }
                }

                // Queue for deep dive if score >= threshold and verdict/impact meet criteria
                const totalScore = discovery.scores && typeof discovery.scores.total === 'number' ? discovery.scores.total : 0;
                if (discovery.type === 'discovery' && totalScore >= DEEP_DIVE_THRESHOLD && (verdictStr === 'HIGH-VALUE GAP' || discovery.impact === 'high')) {
                  deepDiveQueue.push({ discovery, attempts: 0, last_error: null });
                  saveQueues();
                  console.log(`[DEEP-DIVE] Queued ${discovery.id} for deep dive (queue: ${deepDiveQueue.length})`);
                } else if (discovery.type === 'discovery' && (verdictStr === 'HIGH-VALUE GAP' || discovery.impact === 'high')) {
                  console.log(`[DEEP-DIVE] Skipped ${discovery.id} (score ${totalScore} < ${DEEP_DIVE_THRESHOLD})`);
                }
              }
            } else {
              // discovery returned null/undefined — finalize as error
              updateFindingById(attemptId, { result: { outcome: 'error', reason: 'investigateDiscovery returned null', discovery_id: null }, completed_at: new Date().toISOString() });
              recomputeMetricsNow('discovery_error');
            }
            apiUsed = true;
          } catch (err) {
            console.error(`[RESEARCH] Discovery investigation error: ${err.message}`);
            updateFindingById(attemptId, { result: { outcome: 'error', reason: err.message, discovery_id: null }, completed_at: new Date().toISOString() });
            recomputeMetricsNow('discovery_exception');
          }
        }
      } else {
        // Same-layer: bond investigation
        try {
          const bondFinding = await investigateBond({
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
          });

          if (bondFinding) {
            agent1.bondsWithFindings = (agent1.bondsWithFindings || 0) + 1;
            agent2.bondsWithFindings = (agent2.bondsWithFindings || 0) + 1;
            console.log(`[RESEARCH] ${bondFinding.id} | BOND | ${a1Label} x ${a2Label}`);
          }
          apiUsed = true;
        } catch (err) {
          console.error(`[RESEARCH] Bond investigation error: ${err.message}`);
        }
      }
    }

    // Pick lead agent on active cell → investigateCell (only if no bond/discovery this tick)
    if (!apiUsed) {
      const leadAgent = agentsHere[0];
      try {
        const cellFinding = await investigateCell({
          tick: tickNum,
          agentName: leadAgent.displayName,
          cell: activeCell,
          cellLabel: label,
          packName
        });

          if (cellFinding && cellFinding.keywords) {
            updateAgentKeywords(leadAgent, cellFinding.keywords);
            leadAgent.findingsCount = (leadAgent.findingsCount || 0) + 1;
            recomputeMetricsNow('cell_finding_recorded');
            console.log(`[RESEARCH] ${cellFinding.id} | CELL | ${label}`);
          }
      } catch (err) {
        console.error(`[RESEARCH] Cell investigation error: ${err.message}`);
      }
    }

    state.save();
  }

  // === DEEP DIVE (max 1 per tick, with timeout) ===
  if (deepDiveQueue.length > 0 && !lowSpendMode && (Date.now() - _tickStartedAt) < TICK_TIME_BUDGET_MS) {
    const ddItem = deepDiveQueue[0];
    const ddDiscovery = ddItem.discovery;
    if (!budget.canRunDeepDive(MAX_DEEP_DIVES_PER_DAY)) {
      console.log(`[DEEP-DIVE] Daily cap reached (${MAX_DEEP_DIVES_PER_DAY}). Deferring deep dives until next day.`);
    } else {
    console.log(`[DEEP-DIVE] Starting deep dive on ${ddDiscovery.id} (${deepDiveQueue.length} remaining)`);
    try {
      budget.recordDeepDive();
      const ddResult = await withTimeout(deepDive(ddDiscovery), QUEUE_TIMEOUT_MS, 'deep-dive');
      if (ddResult) {
        deepDiveQueue.shift();
        saveQueues();
        console.log(`[DEEP-DIVE] ${ddDiscovery.id} complete: ${ddResult.verdict} (${ddResult.scores.total}/100)`);
        if (ddResult.verdict === 'HIGH-VALUE GAP') {
          verificationQueue.push({ discovery: ddDiscovery, deepDive: ddResult });
          saveQueues();
          console.log(`[VERIFIER] QUEUED ${ddDiscovery.id} for GPT-4o adversarial review (queue: ${verificationQueue.length})`);
        }
      } else {
        recordDeepDiveFailure(ddItem, 'deepDive returned null');
      }
    } catch (err) {
      const msg = `${err.message.startsWith('timeout:') ? 'TIMEOUT' : 'Error'}: ${err.message}`;
      console.error(`[DEEP-DIVE] ${msg}`);
      recordDeepDiveFailure(ddItem, msg);
    }
    }
  }

  // === VERIFICATION (independent of deep-dive — runs every tick if queue has items, with timeout) ===
  if (verificationQueue.length > 0 && !lowSpendMode && (Date.now() - _tickStartedAt) < TICK_TIME_BUDGET_MS) {
    if (!process.env.OPENAI_API_KEY) {
      if (tickNum % 50 === 0) console.warn('[VERIFIER] OPENAI_API_KEY not set — skipping verification');
      updateMetrics({ gpt_skipped_missing_key: 1, gpt_errors: 1, last_error: 'OPENAI_API_KEY not set — skipping verification', last_error_at: new Date().toISOString() });
    } else {
      const vItem = verificationQueue[0];
      const vVerdict = (vItem.discovery.verdict && vItem.discovery.verdict.verdict) || vItem.discovery.verdict || '';
      const vScore = vItem.discovery.scores && typeof vItem.discovery.scores.total === 'number' ? vItem.discovery.scores.total : 0;
      if (vVerdict !== 'HIGH-VALUE GAP') {
        verificationQueue.shift();
        saveQueues();
        updateMetrics({ gpt_skipped_not_high_value: 1 });
        console.warn(`[VERIFIER] Skipping non-high-value discovery ${vItem.discovery.id} (verdict=${vVerdict || 'unknown'})`);
      } else if (vScore < VERIFIER_MIN_SCORE) {
        verificationQueue.shift();
        saveQueues();
        vItem.discovery.verification = 'skipped-low-score';
        const findingsData = readFindings();
        const fIdx = findingsData.findings.findIndex(f => f.id === vItem.discovery.id);
        if (fIdx !== -1) {
          findingsData.findings[fIdx] = vItem.discovery;
          saveFindingsAtomic(findingsData);
        }
        updateMetrics({ gpt_skipped_low_score: 1 });
        console.warn(`[VERIFIER] Skipping ${vItem.discovery.id} (score ${vScore} < ${VERIFIER_MIN_SCORE})`);
      } else {
        try {
          console.log(`[VERIFIER] REVIEWING ${vItem.discovery.id} — sending to GPT-4o...`);
          const vResult = await withTimeout(verifyGap(vItem.discovery, vItem.deepDive), QUEUE_TIMEOUT_MS, 'gpt-verifier');
          if (vResult && !vResult.error) {
            verificationQueue.shift();
            saveQueues();

            // === ADVERSARIAL SCORE ADJUSTMENT ===
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

            // Save updated finding (atomic)
            const findingsData = readFindings();
            const fIdx = findingsData.findings.findIndex(f => f.id === vItem.discovery.id);
            if (fIdx !== -1) {
              findingsData.findings[fIdx] = vItem.discovery;
              saveFindingsAtomic(findingsData);
            }

            console.log(`[VERIFIER] RESULT ${vItem.discovery.id} | Claude: ${claudeTotal} → GPT: -${totalAdjustment} → Final: ${finalScore} | verdict=${finalVerdict}${vItem.discovery.adversarial_adjustment.downgraded ? ' (DOWNGRADED)' : ''}`);

            recomputeMetricsNow('gpt_verification_saved');

            if (vResult.survives_scrutiny && vResult.gpt_verdict === 'CONFIRMED') {
              validationQueue.push(vItem.discovery);
              saveQueues();
              console.log(`[VALIDATOR] Queued ${vItem.discovery.id} for pre-experiment validation (queue: ${validationQueue.length})`);
            }
          } else if (vResult && vResult.error) {
            verificationQueue.shift();
            saveQueues();
            const cat = safeMetricCategory(vResult.category || 'unknown');
            updateMetrics({
              gpt_errors: 1,
              [`gpt_errors_${cat}`]: 1,
              last_error_category: cat,
              last_error: `Verifier error: ${vResult.error}`,
              last_error_at: new Date().toISOString()
            });
            console.error(`[VERIFIER] Failed (${cat}): ${vResult.error}`);
          }
          // null means rate-limited — keep in queue for next tick
        } catch (err) {
          console.error(`[VERIFIER] Error: ${err.message}`);
          const cat = safeMetricCategory(err.code || err.name || 'unknown');
          updateMetrics({
            gpt_errors: 1,
            [`gpt_errors_${cat}`]: 1,
            last_error_category: cat,
            last_error: `Verifier error: ${err.message}`,
            last_error_at: new Date().toISOString()
          });
          verificationQueue.shift();
          saveQueues();
        }
      }
    }
  }

  // === VALIDATION (independent of deep-dive — runs every tick if queue has items, with timeout) ===
  if (validationQueue.length > 0 && !lowSpendMode && (Date.now() - _tickStartedAt) < TICK_TIME_BUDGET_MS) {
    const valDiscovery = validationQueue[0];
    try {
      const valResult = await withTimeout(validateGap(valDiscovery), QUEUE_TIMEOUT_MS, 'validator');
      if (valResult) {
        validationQueue.shift();
        saveQueues();

        updateMetrics({ validated: 1 });
        const feas = valResult.overall_feasibility || 'blocked';
        if (feas === 'ready_to_test') updateMetrics({ ready_to_test: 1 });
        else if (feas === 'needs_data') updateMetrics({ needs_data: 1 });
        else updateMetrics({ blocked: 1 });
      }
      // null means rate-limited — keep in queue for next tick
    } catch (err) {
      console.error(`[VALIDATOR] Error: ${err.message}`);
      validationQueue.shift();
      saveQueues();
    }
  }
}

async function handleCommand(interaction) {
  const { commandName, user, options } = interaction;
  switch (commandName) {

    case 'join': {
      const number = options.getInteger('number');
      const result = state.addAgent(user.id, user.displayName, number);
      if (!result.ok) return interaction.reply({ content: '❌ Already joined! Use `/status`.', ephemeral: true });
      const a = result.agent;
      await sendToChannel('live', `🆕 **${a.displayName}** joined! #${a.chosenNumber} → cell ${a.homeCell} (${getLayerName(a.homeCell)})`);
      return interaction.reply({ content: `✅ Welcome!\n**Number:** ${a.chosenNumber}\n**Home cell:** ${a.homeCell} (${cellLabel(a.homeCell)})\n**Layer:** ${getLayerName(a.homeCell)}\n**Energy:** ${a.energy}%\n\n**Your neighbors:**\n${neighborSummary(a.homeCell)}` });
    }

    case 'move': {
      const cell = options.getInteger('cell');
      const result = state.moveAgent(user.id, cell);
      if (!result.ok) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
      return interaction.reply({ content: `📍 ${result.oldCell} → **cell ${result.newCell}** (${cellLabel(result.newCell)})` });
    }

    case 'home': {
      const agent = state.getAgent(user.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!agent.alive) return interaction.reply({ content: '💀 Dead.', ephemeral: true });
      state.moveAgent(user.id, agent.homeCell);
      return interaction.reply({ content: `🏠 Home → **${agent.homeCell}** (${cellLabel(agent.homeCell)})` });
    }

    case 'status': {
      const agent = state.getAgent(user.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      return interaction.reply({ embeds: [statusEmbed(agent)] });
    }

    case 'grid': {
      const occupants = state.getGridState();
      const activeCell = state.tick % 27;
      return interaction.reply({ content: `${renderCube(occupants, activeCell)}\n\nTick: ${state.tick} | Agents: ${state.agents.size}` });
    }

    case 'leaderboard': return interaction.reply({ embeds: [leaderboardEmbed()] });

    case 'bonds': {
      const network = state.getBondNetwork(user.id);
      if (!network) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (network.connections.length === 0) return interaction.reply({ content: 'No bonds yet.' });
      const list = network.connections.map(c => `**${c.name}** — ${c.bondCount} bond${c.bondCount > 1 ? 's' : ''}${c.crossLayer > 0 ? ` (${c.crossLayer} 🌈)` : ''}`).join('\n');
      return interaction.reply({ content: `🔗 **Bonds**: ${network.totalBonds} (${network.crossLayerBonds} 🌈) | ${network.uniqueConnections} unique\n\n${list}` });
    }

    case 'revive': {
      const targetUser = options.getUser('agent');
      const reviver = state.getAgent(user.id);
      const target = state.getAgent(targetUser.id);
      if (!reviver) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!reviver.alive) return interaction.reply({ content: '💀 Dead yourself.', ephemeral: true });
      if (!target) return interaction.reply({ content: '❌ They haven\'t joined.', ephemeral: true });
      if (target.alive) return interaction.reply({ content: '❌ Already alive!', ephemeral: true });
      if (reviver.currentCell !== target.homeCell) return interaction.reply({ content: `❌ Go to cell **${target.homeCell}** first. You're in ${reviver.currentCell}.`, ephemeral: true });
      target.alive = true; target.energy = ENERGY.REVIVE; target.currentCell = target.homeCell;
      state.save();
      await sendToChannel('live', `🔄 **${reviver.displayName}** revived **${target.displayName}** in cell ${target.homeCell}!`);
      await sendToChannel('graveyard', `🔄 **${target.displayName}** has been revived!`);
      return interaction.reply({ content: `🔄 Revived **${target.displayName}**! Back at ${ENERGY.REVIVE}% in cell ${target.homeCell}.` });
    }

    case 'info': {
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFF4500).setTitle('🌶 CLASHD-27')
        .setDescription('**27 cells. One clock. Agents clash.**\n\n`/join <number>` — mod 27 = home cell\n`/move <cell>` — move (0-26)\n`/home` — return home\n`/status` — your agent\n`/grid` — the cube\n`/leaderboard` — rankings\n`/bonds` — bond network\n`/revive @user` — revive dead agent\n`/profile [@user]` — agent profile\n`/who <cell>` — who\'s there\n`/shout <msg>` — broadcast\n`/ally @user` — declare alliance\n`/rivals` — near your rank\n\n🪱 THE FLOOR (0-8) · 💯 NO HATS ALLOWED (9-17) · 🧠 MOD 27 ZONE (18-26)\n\n✨ Resonance +${ENERGY.RESONANCE}% · 🟥 Face +${ENERGY.CLASH_FACE}% · 🟧 Edge +${ENERGY.CLASH_EDGE}% · 🟨 Corner +${ENERGY.CLASH_CORNER}% · 😴 Idle ${ENERGY.IDLE_DRAIN}%\n\n*Text: `!join`, `!move`, `!status`, etc.*')
        .setFooter({ text: 'CLASHD-27 by Greenbanaanas' })] });
    }

    case 'profile': {
      const targetUser = options.getUser('agent') || user;
      const agent = state.getAgent(targetUser.id);
      if (!agent) return interaction.reply({ content: '❌ Agent not found.', ephemeral: true });
      const cc = agent.clashCounts || { face: 0, edge: 0, corner: 0 };
      const totalClashes = cc.face + cc.edge + cc.corner;
      let archetype = '🆕 Fresh Spawn';
      if (agent.deaths >= 3) archetype = '💀 Phoenix';
      else if ((agent.crossLayerBonds || 0) > agent.totalBonds * 0.4) archetype = '🌈 Layer Hopper';
      else if (cc.corner > cc.face && totalClashes > 10) archetype = '🟨 Corner Creep';
      else if (agent.totalBonds > 20) archetype = '🔗 Web Weaver';
      else if (agent.survivalStreak > 100) archetype = '🔥 Cockroach';
      else if (totalClashes > 30) archetype = '⚡ Clash Addict';
      else if (agent.totalBonds === 0 && agent.survivalStreak > 20) archetype = '🐺 Lone Wolf';
      const alliances = state.getAlliances(targetUser.id);
      const network = state.getBondNetwork(targetUser.id);
      const topBonds = network?.connections.slice(0, 5).map(c => `${c.name} (${c.bondCount}${c.crossLayer > 0 ? '🌈' : ''})`).join(', ') || 'None';
      return interaction.reply({ embeds: [new EmbedBuilder()
        .setColor(agent.alive ? 0xFF4500 : 0x95A5A6).setTitle(`${agent.alive ? '🌶' : '💀'} ${agent.displayName}`)
        .setDescription(`**${archetype}**\n\n**Home:** cell ${agent.homeCell} (${cellLabel(agent.homeCell)}) · ${getLayerName(agent.homeCell)}\n**Energy:** ${agent.energy}%${agent.alive ? '' : ' · DEAD'}\n**Survival:** ${agent.survivalStreak} current · ${agent.longestStreak} best\n**Deaths:** ${agent.deaths}\n\n**Clashes:** 🟥 ${cc.face} · 🟧 ${cc.edge} · 🟨 ${cc.corner} (${totalClashes} total)\n**Bonds:** ${agent.totalBonds} total · ${agent.crossLayerBonds || 0} cross-layer 🌈\n**Top bonds:** ${topBonds}\n\n**Alliances:**\n${alliances.length > 0 ? alliances.map(a => `⚔️ ${a.ally}`).join('\n') : 'None'}`)
        .setFooter({ text: `Agent #${agent.chosenNumber} · Joined at tick ${agent.joinedAtTick}` }).setTimestamp()] });
    }

    case 'who': {
      const cell = options.getInteger('cell');
      const agents = state.getAgentsInCell(cell);
      const isActive = cell === (state.tick % 27);
      if (agents.length === 0) return interaction.reply({ content: `Cell **${cell}** (${cellLabel(cell)}) is empty${isActive ? ' — ACTIVE right now! 👀' : '.'}` });
      const list = agents.map(a => `**${a.displayName}** — ${a.energy}% ⚡ · ${a.totalBonds} bonds${a.homeCell === cell ? ' 🏠' : ''}`).join('\n');
      return interaction.reply({ content: `${isActive ? '🔥 **ACTIVE** ' : ''}Cell **${cell}** — ${agents.length} agent${agents.length > 1 ? 's' : ''}:\n\n${list}` });
    }

    case 'shout': {
      const agent = state.getAgent(user.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!agent.alive) return interaction.reply({ content: '💀 Dead agents don\'t shout.', ephemeral: true });
      const msg = options.getString('message');
      state.addShout(user.id, agent.displayName, msg);
      await sendToChannel('live', `📢 **${agent.displayName}** [cell ${agent.currentCell}]: ${msg}`);
      return interaction.reply({ content: '📢 Broadcasted to #live', ephemeral: true });
    }

    case 'ally': {
      const targetUser = options.getUser('agent');
      const agent = state.getAgent(user.id);
      const target = state.getAgent(targetUser.id);
      if (!agent) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!target) return interaction.reply({ content: '❌ They haven\'t joined.', ephemeral: true });
      if (targetUser.id === user.id) return interaction.reply({ content: '❌ Can\'t ally with yourself.', ephemeral: true });
      const result = state.addAlliance(user.id, agent.displayName, targetUser.id, target.displayName);
      if (!result.ok) return interaction.reply({ content: `❌ Already allied with **${target.displayName}**!`, ephemeral: true });
      await sendToChannel('live', `⚔️ **ALLIANCE** — ${agent.displayName} 🤝 ${target.displayName}`);
      await sendToChannel('alliances', `⚔️ **${agent.displayName}** declared alliance with **${target.displayName}** at tick ${state.tick}`);
      return interaction.reply({ content: `⚔️ Alliance declared with **${target.displayName}**!` });
    }

    case 'rivals': {
      const rivalData = state.getRivals(user.id);
      if (!rivalData) return interaction.reply({ content: '❌ Not joined.', ephemeral: true });
      if (!rivalData.agent.alive) return interaction.reply({ content: '💀 Dead agents have no rivals.', ephemeral: true });
      const list = rivalData.rivals.map(r => `#${r.rank} **${r.name}** — ${r.energy}% ⚡ · ${r.bonds} bonds${r.isYou ? ' ◄ YOU' : ''}`).join('\n');
      return interaction.reply({ content: `**Your rank: #${rivalData.rank}/${rivalData.total}**\n\n${list}` });
    }
  }
}

async function handleTextCommand(message) {
  if (message.author.id === client.user.id) return;
  if (!message.content.startsWith('!')) return;
  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();

  switch (cmd) {
    case 'join': {
      const number = parseInt(args[1]);
      if (isNaN(number) || number < 0) return message.reply('Usage: `!join <number>`');
      const result = state.addAgent(message.author.id, message.author.displayName, number);
      if (!result.ok) return message.reply('Already joined! `!status`');
      const a = result.agent;
      await sendToChannel('live', `🆕 **${a.displayName}** joined! #${a.chosenNumber} → cell ${a.homeCell}`);
      return message.reply(`✅ #${a.chosenNumber} → home cell **${a.homeCell}** (${cellLabel(a.homeCell)})`);
    }
    case 'move': {
      const cell = parseInt(args[1]);
      if (isNaN(cell) || cell < 0 || cell > 26) return message.reply('Usage: `!move <0-26>`');
      const result = state.moveAgent(message.author.id, cell);
      if (!result.ok) return message.reply(`❌ ${result.reason}`);
      return message.reply(`📍 → **cell ${result.newCell}** (${cellLabel(result.newCell)})`);
    }
    case 'home': {
      const agent = state.getAgent(message.author.id);
      if (!agent) return message.reply('Not joined.');
      if (!agent.alive) return message.reply('💀');
      state.moveAgent(message.author.id, agent.homeCell);
      return message.reply(`🏠 → cell **${agent.homeCell}**`);
    }
    case 'status': {
      const agent = state.getAgent(message.author.id);
      if (!agent) return message.reply('Not joined.');
      return message.reply({ embeds: [statusEmbed(agent)] });
    }
    case 'grid': {
      const occupants = state.getGridState();
      return message.reply(`${renderCube(occupants, state.tick % 27)}\nTick: ${state.tick}`);
    }
    case 'leaderboard': case 'lb': return message.reply({ embeds: [leaderboardEmbed()] });
    case 'bonds': {
      const network = state.getBondNetwork(message.author.id);
      if (!network) return message.reply('Not joined.');
      if (network.connections.length === 0) return message.reply('No bonds yet.');
      return message.reply(`🔗 ${network.totalBonds} bonds (${network.crossLayerBonds}🌈)\n${network.connections.map(c => `**${c.name}** — ${c.bondCount}${c.crossLayer > 0 ? '🌈' : ''}`).join('\n')}`);
    }
    case 'who': {
      const cell = parseInt(args[1]);
      if (isNaN(cell) || cell < 0 || cell > 26) return message.reply('Usage: `!who <0-26>`');
      const agents = state.getAgentsInCell(cell);
      if (agents.length === 0) return message.reply(`Cell **${cell}** is empty.`);
      return message.reply(`Cell **${cell}**: ${agents.map(a => `**${a.displayName}** ${a.energy}%`).join(', ')}`);
    }
    case 'shout': {
      const agent = state.getAgent(message.author.id);
      if (!agent || !agent.alive) return message.reply('❌');
      const msg = args.slice(1).join(' ').slice(0, 200);
      if (!msg) return message.reply('Usage: `!shout <message>`');
      state.addShout(message.author.id, agent.displayName, msg);
      await sendToChannel('live', `📢 **${agent.displayName}** [cell ${agent.currentCell}]: ${msg}`);
      return message.reply('📢 Sent');
    }
    case 'rivals': {
      const rivalData = state.getRivals(message.author.id);
      if (!rivalData || !rivalData.agent.alive) return message.reply('❌');
      return message.reply(`Rank #${rivalData.rank}/${rivalData.total}\n${rivalData.rivals.map(r => `#${r.rank} **${r.name}** ${r.energy}%${r.isYou ? ' ◄' : ''}`).join('\n')}`);
    }
    case 'setup': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return message.reply('❌ Need Manage Channels permission.');
      const guild = message.guild;
      await message.reply('🔧 Setting up CLASHD-27...');
      const categories = {};
      for (const name of ['CLASHD-27 INFO','LEVER','THE FLOOR','NO HATS ALLOWED','MOD 27 ZONE','COMMUNITY']) {
        categories[name] = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildCategory) ||
          await guild.channels.create({ name, type: ChannelType.GuildCategory });
      }
      async function ensureChannel(name, parentName) {
        return guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText) ||
          await guild.channels.create({ name, type: ChannelType.GuildText, parent: categories[parentName] });
      }
      for (const ch of ['welcome','rules','info']) await ensureChannel(ch, 'CLASHD-27 INFO');
      for (const ch of ['clock','live','residue','leaderboard','graveyard']) await ensureChannel(ch, 'LEVER');
      for (let i = 0; i < 9; i++) await ensureChannel(`${CHANNEL_PREFIX}${i}`, 'THE FLOOR');
      for (let i = 9; i < 18; i++) await ensureChannel(`${CHANNEL_PREFIX}${i}`, 'NO HATS ALLOWED');
      for (let i = 18; i < 27; i++) await ensureChannel(`${CHANNEL_PREFIX}${i}`, 'MOD 27 ZONE');
      for (const ch of ['general','strategy','alliances']) await ensureChannel(ch, 'COMMUNITY');
      await cacheChannels(guild);
      return message.reply('✅ All channels created! CLASHD-27 is ready.');
    }
  }
}

async function handleCellPresence(message) {
  if (message.author.bot) return;
  const channelName = message.channel.name;
  if (!channelName.startsWith(CHANNEL_PREFIX)) return;
  const cellNum = parseInt(channelName.replace(CHANNEL_PREFIX, ''));
  if (isNaN(cellNum) || cellNum < 0 || cellNum > 26) return;
  const agent = state.getAgent(message.author.id);
  if (!agent || !agent.alive) return;
  if (agent.currentCell !== cellNum) state.moveAgent(message.author.id, cellNum);
}

client.once('ready', async () => {
  console.log(`[BOT] ${client.user.tag} online`);
  const guild = client.guilds.cache.first();
  if (guild) await cacheChannels(guild);

  // === v2.0 Anomaly Magnet: Initialize open data sources ===
  if (process.env.USE_CUBE === 'true') {
    console.log('[BOOT] Initializing v2.0 Anomaly Magnet data sources...');

    // Retraction enricher (background init — downloads/caches retraction data)
    try {
      const { init: initRetractions } = require('./lib/retraction-enricher');
      initRetractions().then(() => {
        console.log('[BOOT] Retraction enricher ready');
      }).catch(e => {
        console.warn(`[BOOT] Retraction enricher init failed (non-fatal): ${e.message}`);
      });
    } catch (e) {
      console.warn(`[BOOT] Retraction enricher load failed: ${e.message}`);
    }

    // OpenAlex cache prune
    try {
      const { pruneCache } = require('./lib/openalex');
      pruneCache();
    } catch (e) {
      console.warn(`[BOOT] OpenAlex cache prune failed: ${e.message}`);
    }

    console.log('[BOOT] v2.0 data source init dispatched (async, non-blocking)');
  }

  console.log(`[CLOCK] Interval: ${TICK_INTERVAL / 1000}s`);
  clockTimer = setInterval(tick, TICK_INTERVAL);
  const activeCell = state.tick % 27;
  await sendToChannel('clock', `🌶 **CLASHD-27 is live.** Tick ${state.tick}. Active cell: **${activeCell}** (${cellLabel(activeCell)})`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try { await handleCommand(interaction); }
  catch (err) {
    console.error('[CMD]', err);
    const reply = { content: '❌ Error.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

client.on('messageCreate', async (message) => {
  await handleTextCommand(message);
  await handleCellPresence(message);
});

process.on('SIGINT', () => { clearInterval(clockTimer); state.save(); client.destroy(); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(clockTimer); state.save(); client.destroy(); process.exit(0); });

client.login(process.env.DISCORD_TOKEN);
