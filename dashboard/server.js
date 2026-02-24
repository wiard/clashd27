/**
 * CLASHD27 — Dashboard Server
 * Reads state.json, serves packs, and runs the live dashboard on port 3027
 */
require('dotenv').config({ path: '/home/greenbanaanas/.secrets/clashd27.env', override: true });

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3027;
const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const PACKS_DIR = path.join(__dirname, '..', 'packs');

app.use(express.json());

// --- State ---
function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// --- Pack System ---
let activePack = null;

function loadPack(packId) {
  try {
    const packPath = path.join(PACKS_DIR, packId + '.json');
    const raw = fs.readFileSync(packPath, 'utf8');
    activePack = JSON.parse(raw);
    console.log(`[PACK] Loaded: ${activePack.name}`);
    return activePack;
  } catch (e) {
    console.error(`[PACK] Failed to load ${packId}:`, e.message);
    return null;
  }
}

function listPacks() {
  try {
    return fs.readdirSync(PACKS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(PACKS_DIR, f), 'utf8');
          const pack = JSON.parse(raw);
          return { id: pack.id, name: pack.name, description: pack.description };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

// Load default pack on startup
loadPack('open-arena');

// --- API: Cube State ---
app.get('/api/state', (req, res) => {
  const state = readState();
  if (!state) return res.status(500).json({ error: 'State not found' });

  const agents = Object.values(state.agents || {});
  const alive = agents.filter(a => a.alive);
  const dead = agents.filter(a => !a.alive);
  const activeCell = state.tick % 27;

  const leaderboard = [...alive].sort((a, b) => b.energy - a.energy);

  const cellOccupancy = {};
  for (let i = 0; i < 27; i++) cellOccupancy[i] = [];
  for (const agent of alive) {
    cellOccupancy[agent.currentCell].push(agent.displayName);
  }

  const recentBonds = (state.bonds || []).slice(-20).reverse();

  // Include active pack cell label
  const activeCellLabel = activePack?.cells?.[String(activeCell)]?.label || null;

  res.json({
    tick: state.tick,
    activeCell,
    activeCellLabel,
    cycle: Math.floor(state.tick / 27),
    totalAgents: agents.length,
    aliveAgents: alive.length,
    deadAgents: dead.length,
    totalBonds: (state.bonds || []).length,
    leaderboard,
    cellOccupancy,
    recentBonds,
    agents,
    pack: activePack ? { id: activePack.id, name: activePack.name } : null,
  });
});

// --- API: Pack System ---
app.get('/api/pack', (req, res) => {
  if (!activePack) return res.status(404).json({ error: 'No pack loaded' });
  res.json(activePack);
});

app.get('/api/packs', (req, res) => {
  res.json({ packs: listPacks(), active: activePack?.id || null });
});

app.post('/api/pack/load', (req, res) => {
  const { packId } = req.body;
  if (!packId) return res.status(400).json({ error: 'packId required' });
  const pack = loadPack(packId);
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  res.json({ loaded: pack.id, name: pack.name });
});

app.get('/api/cell/:id', (req, res) => {
  if (!activePack) return res.status(404).json({ error: 'No pack loaded' });
  const cell = activePack.cells[req.params.id];
  if (!cell) return res.status(404).json({ error: 'Cell not found' });

  const state = readState();
  const agents = state ? Object.values(state.agents || {}) : [];
  const occupants = agents.filter(a => a.alive && a.currentCell === parseInt(req.params.id));

  res.json({
    ...cell,
    cellId: parseInt(req.params.id),
    occupants: occupants.map(a => a.displayName),
    pack: activePack.id
  });
});

// --- API: Daily Research ---
const RESEARCH_FILE = path.join(__dirname, '..', 'data', 'daily-research.json');

function readResearch() {
  try {
    if (fs.existsSync(RESEARCH_FILE)) {
      return JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[RESEARCH] Read failed:', e.message);
  }
  return null;
}

app.get('/api/research/today', (req, res) => {
  const research = readResearch();
  if (!research) return res.json({ date: null, briefings: [] });
  res.json(research);
});

app.get('/api/research/:cell', (req, res) => {
  const cellId = parseInt(req.params.cell);
  const research = readResearch();
  if (!research) return res.json({ cell: cellId, articles: [] });

  const briefing = research.briefings.find(b => b.cell === cellId);
  res.json({
    cell: cellId,
    cellLabel: briefing?.cellLabel || null,
    articles: briefing?.articles || [],
    date: research.date
  });
});

// --- API: Agent Profiles ---
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'agent-history.json');

function readAgentHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[HISTORY] Read failed:', e.message);
  }
  return { events: [] };
}

app.get('/api/agent/:name', (req, res) => {
  const name = req.params.name;
  const state = readState();
  if (!state) return res.status(500).json({ error: 'State not found' });

  const agents = Object.values(state.agents || {});
  const agent = agents.find(a => a.displayName === name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Calculate stats
  const bonds = (state.bonds || []).filter(b => b.agent1 === name || b.agent2 === name);
  const crossLayerBonds = bonds.filter(b => b.crossLayer);

  // Cell visit frequency from history
  const history = readAgentHistory();
  const agentEvents = history.events.filter(e => e.agent === name);
  const cellVisits = {};
  for (let i = 0; i < 27; i++) cellVisits[i] = 0;
  for (const e of agentEvents) {
    if (e.cell !== undefined) cellVisits[e.cell]++;
  }

  // Find favorite cell and layer
  let favoriteCell = 0;
  let maxVisits = 0;
  for (const [cell, visits] of Object.entries(cellVisits)) {
    if (visits > maxVisits) {
      maxVisits = visits;
      favoriteCell = parseInt(cell);
    }
  }

  const layerVisits = [0, 0, 0];
  for (const [cell, visits] of Object.entries(cellVisits)) {
    const layer = Math.floor(parseInt(cell) / 9);
    layerVisits[layer] += visits;
  }
  const favoriteLayer = layerVisits.indexOf(Math.max(...layerVisits));

  const uniqueCellsVisited = Object.values(cellVisits).filter(v => v > 0).length;
  const crossLayerPct = bonds.length > 0 ? Math.round((crossLayerBonds.length / bonds.length) * 100) : 0;

  // Get insights by this agent
  const insights = readInsights().filter(i => i.agentName === name || i.agentName?.includes(name));

  // Bond relationships
  const bondPartners = {};
  for (const bond of bonds) {
    const partner = bond.agent1 === name ? bond.agent2 : bond.agent1;
    if (!bondPartners[partner]) bondPartners[partner] = { count: 0, crossLayer: 0, cells: [] };
    bondPartners[partner].count++;
    if (bond.crossLayer) bondPartners[partner].crossLayer++;
    if (!bondPartners[partner].cells.includes(bond.cell)) {
      bondPartners[partner].cells.push(bond.cell);
    }
  }

  const relationships = Object.entries(bondPartners)
    .map(([partner, data]) => ({
      agent: partner,
      bondCount: data.count,
      crossLayerBonds: data.crossLayer,
      sharedCells: data.cells.length
    }))
    .sort((a, b) => b.bondCount - a.bondCount);

  // Leaderboard rank
  const leaderboard = [...agents].filter(a => a.alive).sort((a, b) => b.energy - a.energy);
  const rank = leaderboard.findIndex(a => a.displayName === name) + 1;

  // Get cell label for current cell
  const currentCellLabel = activePack?.cells?.[String(agent.currentCell)]?.label || null;
  const homeCellLabel = activePack?.cells?.[String(agent.homeCell)]?.label || null;
  const favoriteCellLabel = activePack?.cells?.[String(favoriteCell)]?.label || null;

  res.json({
    ...agent,
    currentCellLabel,
    homeCellLabel,
    rank: rank || null,
    totalInLeaderboard: leaderboard.length,
    stats: {
      favoriteCell,
      favoriteCellLabel,
      favoriteLayer,
      uniqueCellsVisited,
      crossLayerBondPct: crossLayerPct,
      insightsGenerated: insights.length
    },
    cellVisits,
    relationships,
    recentBonds: bonds.slice(-10).reverse()
  });
});

app.get('/api/agent/:name/history', (req, res) => {
  const name = req.params.name;
  const limit = parseInt(req.query.limit) || 100;
  const history = readAgentHistory();
  const agentEvents = history.events
    .filter(e => e.agent === name)
    .slice(-limit)
    .reverse();

  res.json({
    agent: name,
    events: agentEvents,
    total: history.events.filter(e => e.agent === name).length
  });
});

app.get('/api/agent/:name/insights', (req, res) => {
  const name = req.params.name;
  const limit = parseInt(req.query.limit) || 50;
  const insights = readInsights().filter(i => i.agentName === name || i.agentName?.includes(name));

  res.json({
    agent: name,
    insights: insights.slice(-limit).reverse(),
    total: insights.length
  });
});

// --- API: Insights ---
const INSIGHTS_FILE = path.join(__dirname, '..', 'data', 'insights.json');

function readInsights() {
  try {
    if (fs.existsSync(INSIGHTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(INSIGHTS_FILE, 'utf8'));
      return data.insights || [];
    }
  } catch (e) {
    console.error('[INSIGHTS] Read failed:', e.message);
  }
  return [];
}

app.get('/api/insights', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const insights = readInsights();
  res.json({
    insights: insights.slice(-limit).reverse(),
    total: insights.length
  });
});

app.get('/api/insights/:cell', (req, res) => {
  const cellId = parseInt(req.params.cell);
  const limit = parseInt(req.query.limit) || 20;
  const insights = readInsights().filter(i => i.cell === cellId);
  res.json({
    cell: cellId,
    insights: insights.slice(-limit).reverse(),
    total: insights.length
  });
});

// --- API: Discoveries ---
const DISCOVERIES_FILE = path.join(__dirname, '..', 'data', 'discoveries.json');

function readDiscoveries() {
  try {
    if (fs.existsSync(DISCOVERIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(DISCOVERIES_FILE, 'utf8'));
      return data.discoveries || [];
    }
  } catch (e) {
    console.error('[DISCOVERIES] Read failed:', e.message);
  }
  return [];
}

app.get('/api/discoveries', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const pack = req.query.pack || null;
  let discoveries = readDiscoveries();

  // Also include discovery-type findings (gap packets from researcher.js)
  const findings = readFindings();
  const discoveryFindings = findings.filter(f => f.type === 'discovery' || f.type === 'draft');
  const existingIds = new Set(discoveries.map(d => d.id));
  for (const f of discoveryFindings) {
    if (!existingIds.has(f.id)) {
      discoveries.push({
        id: f.id,
        tick: f.tick,
        cell: f.cell,
        cellLabel: f.cellLabel,
        agents: f.agents,
        agentDomains: f.cellLabels,
        connection: f.discovery || f.hypothesis || '',
        hypothesis: f.hypothesis || '',
        evidence: '',
        source: f.source || '',
        novelty: f.novelty || 'medium',
        pack: f.pack,
        type: f.type,
        timestamp: f.timestamp,
        abc_chain: f.abc_chain,
        bridge: f.bridge,
        supporting_sources: f.supporting_sources,
        limiting_sources: f.limiting_sources,
        kill_test: f.kill_test,
        cheapest_validation: f.cheapest_validation,
        clinical_relevance: f.clinical_relevance,
        verdict: f.verdict,
        feasibility: f.feasibility,
        impact: f.impact,
        goldenCollision: f.goldenCollision || null,
        sources: f.sources || []
      });
    }
  }

  // Filter by pack if specified
  if (pack) {
    discoveries = discoveries.filter(d => d.pack === pack);
  }

  // Enrich with verification data from deep-dives
  const dives = readDeepDives();
  const diveMap = {};
  for (const dive of dives) diveMap[dive.discovery_id] = dive;

  const enriched = discoveries.map(d => {
    const dive = diveMap[d.id];
    if (dive) {
      const verifications = dive.verifications || [];
      d.verificationCount = verifications.filter(v => v.verified).length;
      d.verificationTotal = verifications.length;
      d.diveScore = dive.scores?.total || 0;
      d.diveScoreDelta = verifications.reduce((sum, v) => sum + (v.verified ? 5 : -10), 0);
    }
    return d;
  });

  // Sort by timestamp
  enriched.sort((a, b) => {
    const ta = a.timestamp || '';
    const tb = b.timestamp || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  res.json({
    discoveries: enriched.slice(-limit).reverse(),
    total: enriched.length
  });
});

app.get('/api/discoveries/high-novelty', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const discoveries = readDiscoveries().filter(d => d.novelty === 'high');
  res.json({
    discoveries: discoveries.slice(-limit).reverse(),
    total: discoveries.length
  });
});

app.get('/api/discoveries/stats', (req, res) => {
  const discoveries = readDiscoveries();

  // Count per pack
  const byPack = {};
  // Count per cell
  const byCell = {};
  // Count by novelty
  const byNovelty = { high: 0, medium: 0, low: 0 };

  for (const d of discoveries) {
    byPack[d.pack] = (byPack[d.pack] || 0) + 1;
    byCell[d.cell] = (byCell[d.cell] || 0) + 1;
    if (d.novelty) byNovelty[d.novelty] = (byNovelty[d.novelty] || 0) + 1;
  }

  res.json({
    total: discoveries.length,
    highNovelty: byNovelty.high,
    byPack,
    byCell,
    byNovelty
  });
});

app.get('/api/discoveries/agent/:name', (req, res) => {
  const name = req.params.name;
  const limit = parseInt(req.query.limit) || 50;
  const discoveries = readDiscoveries().filter(d =>
    d.agents && d.agents.includes(name)
  );
  res.json({
    agent: name,
    discoveries: discoveries.slice(-limit).reverse(),
    total: discoveries.length,
    discoveryRate: discoveries.length > 0 ? discoveries.length : 0
  });
});

// --- API: Findings (Active Research Output) ---
const FINDINGS_FILE = path.join(__dirname, '..', 'data', 'findings.json');
const RATINGS_FILE = path.join(__dirname, '..', 'data', 'ratings.json');

function readRatings() {
  try {
    if (fs.existsSync(RATINGS_FILE)) {
      return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[RATINGS] Read failed:', e.message);
  }
  return {};
}

function writeRatings(ratings) {
  fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2));
}

function readFindings() {
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FINDINGS_FILE, 'utf8'));
      return data.findings || [];
    }
  } catch (e) {
    console.error('[FINDINGS] Read failed:', e.message);
  }
  return [];
}

app.get('/api/findings', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const type = req.query.type || null;
  const novelty = req.query.novelty || null;

  let findings = readFindings();
  const ratings = readRatings();

  if (type) findings = findings.filter(f => f.type === type);
  if (novelty) findings = findings.filter(f => f.novelty === novelty);

  const merged = findings.slice(-limit).reverse().map(f => ({
    ...f,
    ratings: ratings[f.id] || { up: 0, down: 0 }
  }));

  res.json({
    findings: merged,
    total: findings.length
  });
});

app.post('/api/findings/:id/rate', (req, res) => {
  const findingId = req.params.id;
  const { rating } = req.body;
  if (rating !== 'up' && rating !== 'down') {
    return res.status(400).json({ error: 'rating must be "up" or "down"' });
  }
  const ratings = readRatings();
  if (!ratings[findingId]) ratings[findingId] = { up: 0, down: 0 };
  ratings[findingId][rating]++;
  writeRatings(ratings);
  res.json({ id: findingId, ratings: ratings[findingId] });
});

app.get('/api/findings/rated', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const type = req.query.type || null;
  const ratings = readRatings();
  let findings = readFindings();

  if (type) findings = findings.filter(f => f.type === type);

  // Enrich discoveries with verification data from deep-dives
  const dives = readDeepDives();
  const diveMap = {};
  for (const dive of dives) {
    diveMap[dive.discovery_id] = dive;
  }

  const merged = findings.map(f => {
    const r = ratings[f.id] || { up: 0, down: 0 };
    const entry = { ...f, ratings: r, netRating: r.up - r.down };
    // Attach verification info for discoveries
    if (f.type === 'discovery' && diveMap[f.id]) {
      const dive = diveMap[f.id];
      const verifications = dive.verifications || [];
      const verified = verifications.filter(v => v.verified).length;
      entry.verificationCount = verified;
      entry.verificationTotal = verifications.length;
      entry.diveScore = dive.scores?.total || 0;
      entry.diveScoreDelta = verifications.reduce((sum, v) => sum + (v.verified ? 5 : -10), 0);
    }
    return entry;
  });

  merged.sort((a, b) => b.netRating - a.netRating);

  res.json({
    findings: merged.slice(0, limit),
    total: merged.length
  });
});

app.get('/api/findings/stats', (req, res) => {
  const findings = readFindings();
  const byType = { cell: 0, bond: 0, discovery: 0, draft: 0 };
  const byNovelty = { high: 0, medium: 0, low: 0 };

  for (const f of findings) {
    if (byType[f.type] !== undefined) byType[f.type]++;
    if (f.novelty && byNovelty[f.novelty] !== undefined) byNovelty[f.novelty]++;
  }

  res.json({ total: findings.length, byType, byNovelty });
});

app.get('/api/findings/cell/:id', (req, res) => {
  const cellId = parseInt(req.params.id);
  const limit = parseInt(req.query.limit) || 20;
  const findings = readFindings().filter(f => f.cell === cellId);
  res.json({
    cell: cellId,
    findings: findings.slice(-limit).reverse(),
    total: findings.length
  });
});

app.get('/api/agent/:name/findings', (req, res) => {
  const name = req.params.name;
  const limit = parseInt(req.query.limit) || 50;
  const findings = readFindings().filter(f =>
    f.agent === name || (f.agents && f.agents.includes(name))
  );
  res.json({
    agent: name,
    findings: findings.slice(-limit).reverse(),
    total: findings.length
  });
});

app.get('/api/agent/:name/keywords', (req, res) => {
  const name = req.params.name;
  const state = readState();
  if (!state) return res.status(500).json({ error: 'State not found' });

  const agents = Object.values(state.agents || {});
  const agent = agents.find(a => a.displayName === name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  res.json({
    agent: name,
    keywords: agent.keywords || [],
    findingsCount: agent.findingsCount || 0,
    bondsWithFindings: agent.bondsWithFindings || 0,
    discoveriesCount: agent.discoveriesCount || 0,
    lastCells: agent.lastCells || []
  });
});

// --- API: Deep Dives ---
const DEEP_DIVES_FILE = path.join(__dirname, '..', 'data', 'deep-dives.json');

function readDeepDives() {
  try {
    if (fs.existsSync(DEEP_DIVES_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEEP_DIVES_FILE, 'utf8'));
      return data.dives || [];
    }
  } catch (e) {
    console.error('[DEEP-DIVES] Read failed:', e.message);
  }
  return [];
}

app.get('/api/deep-dives', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const dives = readDeepDives();
  res.json({
    dives: dives.slice(-limit).reverse(),
    total: dives.length
  });
});

app.get('/api/deep-dives/:id', (req, res) => {
  const id = req.params.id;
  const dives = readDeepDives();
  const dive = dives.find(d => d.discovery_id === id);
  if (!dive) return res.status(404).json({ error: 'Deep-dive not found' });
  res.json(dive);
});

// --- API: Verifications (GPT-4o Independent Review) ---
const VERIFICATIONS_FILE = path.join(__dirname, '..', 'data', 'verifications.json');

function readVerifications() {
  try {
    if (fs.existsSync(VERIFICATIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(VERIFICATIONS_FILE, 'utf8'));
      return data.verifications || [];
    }
  } catch (e) {
    console.error('[VERIFICATIONS] Read failed:', e.message);
  }
  return [];
}

app.get('/api/verifications', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const verifications = readVerifications();
  res.json({
    verifications: verifications.slice(-limit).reverse(),
    total: verifications.length
  });
});

// --- API: Validations (Pre-Experiment Validation) ---
const VALIDATIONS_FILE = path.join(__dirname, '..', 'data', 'validations.json');

function readValidationsData() {
  try {
    if (fs.existsSync(VALIDATIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(VALIDATIONS_FILE, 'utf8'));
      return data.validations || [];
    }
  } catch (e) {
    console.error('[VALIDATIONS] Read failed:', e.message);
  }
  return [];
}

app.get('/api/validations', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const validations = readValidationsData();
  res.json({
    validations: validations.slice(-limit).reverse(),
    total: validations.length
  });
});

app.get('/api/validations/:id', (req, res) => {
  const id = req.params.id;
  const validations = readValidationsData();
  const validation = validations.find(v => v.discovery_id === id);
  if (!validation) return res.status(404).json({ error: 'Validation not found' });
  res.json(validation);
});

// --- API: Post Weigher Proxy ---
app.post('/api/weigh', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_APIKEY || process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Metrics ---
const METRICS_FILE = path.join(__dirname, '..', 'data', 'metrics.json');

app.get('/api/metrics', (req, res) => {
  try {
    if (fs.existsSync(METRICS_FILE)) {
      const data = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
      // Strip internal tracking fields
      const clean = { ...data };
      delete clean._score_sum;
      delete clean._score_count;
      delete clean._bridge_sum;
      delete clean._bridge_count;
      delete clean._spec_sum;
      delete clean._spec_count;
      delete clean._cost_date;
      // Augment with cube data
      const cube = readCube();
      if (cube) {
        clean.cube_generation = cube.generation || 0;
        clean.cube_papers = cube.totalPapers || 0;
        clean.retraction_enriched = cube.retractionEnriched || 0;
      }
      res.json(clean);
    } else {
      res.json({});
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to read metrics' });
  }
});

// --- API: Retrospective ---
const RETRO_FILE = path.join(__dirname, '..', 'data', 'retrospective.json');

app.get('/api/retrospective', (req, res) => {
  try {
    if (fs.existsSync(RETRO_FILE)) {
      const data = JSON.parse(fs.readFileSync(RETRO_FILE, 'utf8'));
      res.json(data);
    } else {
      res.json({ outcomes: [] });
    }
  } catch (e) {
    res.json({ outcomes: [] });
  }
});

// --- API: Labels (Human Review) ---
const LABELS_FILE = path.join(__dirname, '..', 'data', 'labels.json');

function readLabels() {
  try {
    if (fs.existsSync(LABELS_FILE)) {
      return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[LABELS] Read failed:', e.message);
  }
  return [];
}

function writeLabels(labels) {
  const tmpFile = LABELS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(labels, null, 2));
  fs.renameSync(tmpFile, LABELS_FILE);
}

function computePrecision(labels, findings, k) {
  // Get most recent K HIGH-VALUE GAP discoveries that have labels
  const hvFindings = findings.filter(f => {
    const v = (f.verdict && f.verdict.verdict) || f.verdict || '';
    return f.type === 'discovery' && (v === 'HIGH-VALUE GAP' || v === 'CONFIRMED DIRECTION');
  });
  // Sort by timestamp descending
  hvFindings.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const labelMap = {};
  for (const l of labels) labelMap[l.id] = l;

  let count = 0, tp = 0;
  for (const f of hvFindings) {
    if (count >= k) break;
    const label = labelMap[f.id];
    if (!label) continue;
    count++;
    if (label.labels.novel === 1 && label.labels.testable === 1 && label.labels.wrong === 0) {
      tp++;
    }
  }
  return count > 0 ? Math.round((tp / k) * 1000) / 1000 : null;
}

function updatePrecisionMetrics(labels) {
  const findings = readFindings();
  const labeledHV = labels.filter(l => {
    const f = findings.find(ff => ff.id === l.id);
    if (!f) return false;
    const v = (f.verdict && f.verdict.verdict) || f.verdict || '';
    return v === 'HIGH-VALUE GAP' || v === 'CONFIRMED DIRECTION';
  }).length;

  // Update metrics file
  const metricsFile = path.join(__dirname, '..', 'data', 'metrics.json');
  try {
    let m = {};
    if (fs.existsSync(metricsFile)) m = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
    m.labeled_total = labels.length;
    m.labeled_high_value = labeledHV;

    // Precision@k: only compute when enough labels exist
    if (labeledHV >= 5) {
      m.precision_at_5 = computePrecision(labels, findings, 5);
      delete m.precision_at_5_status;
    } else {
      m.precision_at_5 = null;
      m.precision_at_5_status = 'INSUFFICIENT_LABELS';
    }
    if (labeledHV >= 10) {
      m.precision_at_10 = computePrecision(labels, findings, 10);
      delete m.precision_at_10_status;
    } else {
      m.precision_at_10 = null;
      m.precision_at_10_status = 'INSUFFICIENT_LABELS';
    }

    m.last_updated = new Date().toISOString();
    const tmpM = metricsFile + '.tmp';
    fs.writeFileSync(tmpM, JSON.stringify(m, null, 2));
    fs.renameSync(tmpM, metricsFile);
  } catch (e) {
    console.error('[LABELS] Metrics update failed:', e.message);
  }
}

app.get('/api/review/:id', (req, res) => {
  const id = req.params.id;
  const findings = readFindings();
  const finding = findings.find(f => f.id === id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });
  const labels = readLabels().filter(l => l.id === id);
  res.json({ finding, review_pack: finding.review_pack || null, labels });
});

app.post('/api/review/:id/label', (req, res) => {
  const id = req.params.id;
  const { reviewer, labels: labelData } = req.body;
  if (!reviewer || !labelData) {
    return res.status(400).json({ error: 'reviewer and labels required' });
  }
  if (typeof labelData.novel !== 'number' || typeof labelData.testable !== 'number') {
    return res.status(400).json({ error: 'labels.novel and labels.testable are required (0 or 1)' });
  }
  const findings = readFindings();
  const finding = findings.find(f => f.id === id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  const labels = readLabels();
  labels.push({
    id,
    timestamp: new Date().toISOString(),
    reviewer,
    labels: {
      novel: labelData.novel ? 1 : 0,
      testable: labelData.testable ? 1 : 0,
      obvious: labelData.obvious ? 1 : 0,
      wrong: labelData.wrong ? 1 : 0,
      confidence: Math.min(5, Math.max(1, parseInt(labelData.confidence) || 3)),
      notes: (labelData.notes || '').substring(0, 500)
    }
  });
  writeLabels(labels);
  updatePrecisionMetrics(labels);
  res.json({ ok: true, total_labels: labels.length });
});

app.get('/api/labels', (req, res) => {
  res.json(readLabels());
});

// --- API: Cube (Anomaly Magnet v2.0) ---
const CUBE_FILE = path.join(__dirname, '..', 'data', 'cube.json');

function readCube() {
  try {
    if (fs.existsSync(CUBE_FILE)) {
      return JSON.parse(fs.readFileSync(CUBE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[CUBE] Read failed:', e.message);
  }
  return null;
}

app.get('/api/cube', (req, res) => {
  const cube = readCube();
  if (!cube) return res.json({ active: false });
  // Return cube without full paper arrays (just counts) for overview
  const overview = {
    active: true,
    generation: cube.generation,
    createdAtTick: cube.createdAtTick,
    timestamp: cube.timestamp,
    totalPapers: cube.totalPapers,
    axisLabels: cube.axisLabels,
    distribution: cube.distribution,
    sourceBreakdown: cube.sourceBreakdown || {},
    retractionEnriched: cube.retractionEnriched || 0,
    shuffleDurationMs: cube.shuffleDurationMs || 0,
    cells: {}
  };
  for (const [key, cell] of Object.entries(cube.cells || {})) {
    // Count sources per cell
    const sourceCounts = {};
    let retractedCount = 0;
    for (const p of (cell.papers || [])) {
      const src = p.source || 'unknown';
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      if (p.isRetracted) retractedCount++;
    }

    overview.cells[key] = {
      x: cell.x, y: cell.y, z: cell.z,
      methodLabel: cell.methodLabel,
      surpriseLabel: cell.surpriseLabel,
      clusterLabel: cell.clusterLabel,
      paperCount: cell.paperCount,
      sourceCounts,
      retractedCount,
      topPapers: (cell.papers || []).slice(0, 3).map(p => ({
        title: p.title, year: p.year, citationCount: p.citationCount,
        source: p.source || 'unknown', isRetracted: p.isRetracted || false
      }))
    };
  }
  res.json(overview);
});

app.get('/api/cube/cell/:id', (req, res) => {
  const cube = readCube();
  if (!cube) return res.status(404).json({ error: 'No cube active' });
  const cell = cube.cells[req.params.id];
  if (!cell) return res.status(404).json({ error: 'Cell not found' });
  res.json({
    cellId: parseInt(req.params.id),
    ...cell,
    generation: cube.generation
  });
});

app.get('/api/cube/golden/:cellA/:cellB', (req, res) => {
  const cube = readCube();
  if (!cube) return res.status(404).json({ error: 'No cube active' });
  const a = cube.cells[req.params.cellA];
  const b = cube.cells[req.params.cellB];
  if (!a || !b) return res.status(404).json({ error: 'Cell not found' });

  const methodDistance = Math.abs(a.x - b.x) / 2;
  const yA = a.y / 2;
  const yB = b.y / 2;
  const surprisePair = 0.2 + 0.8 * (0.6 * ((yA + yB) / 2) + 0.4 * Math.sqrt(yA * yB));
  const semanticDistance = a.z !== b.z ? 1.0 : 0.3;
  const raw = (0.45 * methodDistance) + (0.35 * surprisePair) + (0.20 * semanticDistance);
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 1000) / 1000;

  res.json({
    score,
    golden: score > 0.5,
    components: { methodDistance, surprisePair: Math.round(surprisePair * 100) / 100, semanticDistance },
    cellA: { cell: parseInt(req.params.cellA), method: a.methodLabel, surprise: a.surpriseLabel, cluster: a.clusterLabel, papers: a.paperCount },
    cellB: { cell: parseInt(req.params.cellB), method: b.methodLabel, surprise: b.surpriseLabel, cluster: b.clusterLabel, papers: b.paperCount }
  });
});

// --- API: PubMed & Trials (per finding, live enrichment) ---

app.get('/api/findings/:id/pubmed', async (req, res) => {
  const id = req.params.id;
  const findings = readFindings();
  const finding = findings.find(f => f.id === id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  try {
    const pubmed = require('../lib/pubmed');
    const refs = await pubmed.enrichWithReferences(finding);
    res.json({
      finding_id: id,
      pubmed_references: refs,
      mesh_terms: finding.mesh_terms || [],
      total: refs.length
    });
  } catch (e) {
    res.status(500).json({ error: `PubMed enrichment failed: ${e.message}` });
  }
});

app.get('/api/findings/:id/trials', async (req, res) => {
  const id = req.params.id;
  const findings = readFindings();
  const finding = findings.find(f => f.id === id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  try {
    const clinicaltrials = require('../lib/clinicaltrials');
    const trials = await clinicaltrials.searchTrials(finding);
    const assessment = clinicaltrials.assessTrialOverlap(finding, trials);
    res.json({
      finding_id: id,
      ...assessment
    });
  } catch (e) {
    res.status(500).json({ error: `ClinicalTrials check failed: ${e.message}` });
  }
});

// --- API: Funding & Enrichment ---

app.get('/api/findings/:id/funding', (req, res) => {
  const id = req.params.id;
  const validations = readValidationsData();
  const validation = validations.find(v => v.discovery_id === id);
  if (!validation) return res.status(404).json({ error: 'No funding data for this finding' });
  res.json({
    discovery_id: id,
    nih_funding: validation.nih_funding || null,
    eu_funding: validation.eu_funding || null
  });
});

app.get('/api/funding/stats', (req, res) => {
  const validations = readValidationsData();
  let nihTotal = 0, nihCross = 0, euTotal = 0, euFunded = 0;
  let withNih = 0, withEu = 0;

  for (const v of validations) {
    if (v.nih_funding) {
      withNih++;
      nihTotal += v.nih_funding.total_projects_found || 0;
      nihCross += v.nih_funding.cross_domain_projects || 0;
    }
    if (v.eu_funding) {
      withEu++;
      euTotal += v.eu_funding.total_found || 0;
      euFunded += v.eu_funding.eu_funded_count || 0;
    }
  }

  res.json({
    validations_with_funding: { nih: withNih, eu: withEu, total: validations.length },
    nih: { total_projects: nihTotal, cross_domain: nihCross },
    eu: { total_papers: euTotal, eu_funded: euFunded }
  });
});

app.get('/api/findings/:id/brief', async (req, res) => {
  const id = req.params.id;
  const findings = readFindings();
  const finding = findings.find(f => f.id === id);
  if (!finding) return res.status(404).json({ error: 'Finding not found' });

  try {
    const { enrichGapBrief } = require('../lib/brief-enricher');
    const brief = await enrichGapBrief(finding);
    res.json({ finding_id: id, ...brief });
  } catch (e) {
    res.status(500).json({ error: `Enrichment failed: ${e.message}` });
  }
});

app.get('/api/credibility/stats', (req, res) => {
  const findings = readFindings();
  const discoveries = findings.filter(f => f.type === 'discovery');

  try {
    const { scoreGapQuality } = require('../lib/brief-enricher');
    const scores = discoveries.map(d => {
      const gq = scoreGapQuality(d);
      return {
        id: d.id,
        gap_quality_score: gq.score,
        gap_quality_passed: gq.passed,
        gap_quality_total: gq.total,
        // source_credibility_score requires live API calls, so only gap_quality is shown here
        score: gq.score  // backward-compatible
      };
    });

    const avg = scores.length > 0
      ? Math.round(scores.reduce((s, c) => s + c.gap_quality_score, 0) / scores.length)
      : 0;

    const distribution = { high: 0, medium: 0, low: 0 };
    for (const s of scores) {
      if (s.gap_quality_score >= 70) distribution.high++;
      else if (s.gap_quality_score >= 40) distribution.medium++;
      else distribution.low++;
    }

    res.json({
      total_scored: scores.length,
      average_gap_quality_score: avg,
      average_score: avg,  // backward-compatible
      distribution,
      note: 'source_credibility_score requires live API enrichment via /api/findings/:id/brief',
      recent: scores.slice(-20).reverse()
    });
  } catch (e) {
    res.status(500).json({ error: `Credibility scoring failed: ${e.message}` });
  }
});

// --- API: Engine Control (Command Center) ---
const BUDGET_FILE = path.join(__dirname, '..', 'data', 'budget.json');
const ENGINE_CMD_FILE = path.join(__dirname, '..', 'data', '.engine-cmd.json');
const CUBE_FILE_ENGINE = path.join(__dirname, '..', 'data', 'cube.json');

// Engine status: read from data files since engine runs in a separate process
app.get('/api/engine/status', (req, res) => {
  const state = readState();
  const metrics = readJSON(METRICS_FILE);
  const budgetData = readJSON(BUDGET_FILE);
  const cube = readJSON(CUBE_FILE_ENGINE);
  const cmdState = readJSON(ENGINE_CMD_FILE);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const budgetToday = (budgetData && budgetData.date === today) ? budgetData.spent || 0 : 0;
  const budgetLimit = parseFloat(process.env.DAILY_BUDGET_USD || '2.00');

  res.json({
    running: !(cmdState && cmdState.paused),
    paused: !!(cmdState && cmdState.paused),
    tick: state ? state.tick : 0,
    pack: activePack ? { id: activePack.id, name: activePack.name } : null,
    budget_today: Math.round(budgetToday * 100) / 100,
    budget_limit: budgetLimit,
    cube_generation: cube ? cube.generation || 0 : 0,
    cube_papers: cube ? cube.totalPapers || 0 : 0,
    cube_timestamp: cube ? cube.timestamp || null : null,
    agents_total: state ? Object.keys(state.agents || {}).length : 0,
    agents_alive: state ? Object.values(state.agents || {}).filter(a => a.alive).length : 0,
    total_bonds: state ? (state.bonds || []).length : 0,
    metrics: metrics || {}
  });
});

// Pipeline funnel: aggregate counts from findings
app.get('/api/pipeline/funnel', (req, res) => {
  const findings = readFindings();
  const dives = readDeepDives();
  const verifications = readVerifications();
  const validations = readValidationsData();
  const metrics = readJSON(METRICS_FILE);

  const cube = readJSON(CUBE_FILE_ENGINE);
  const papers = cube ? cube.totalPapers || 0 : 0;

  const classified = papers; // all papers in cube are classified
  const allFindings = findings.length;
  const discoveries = findings.filter(f => f.type === 'discovery' || f.type === 'draft').length;
  const attempts = findings.filter(f => f.type === 'attempt' || f.type === 'duplicate').length;

  // Golden collisions (discoveries that had a golden collision score)
  const golden = findings.filter(f =>
    (f.type === 'discovery' || f.type === 'draft') &&
    f.goldenCollision && (typeof f.goldenCollision === 'number' ? f.goldenCollision > 0.5 : f.goldenCollision?.score > 0.5)
  ).length;

  // Investigated = total findings minus duplicates
  const investigated = findings.filter(f => f.type !== 'duplicate').length;

  // High-score = discoveries with score >= 75
  const highScore = findings.filter(f =>
    (f.type === 'discovery' || f.type === 'draft') &&
    f.scores && f.scores.total >= 75
  ).length;

  const deepDived = dives.length;
  const verified = verifications.length;
  const validated = validations.length;

  res.json({
    papers,
    classified,
    findings: allFindings,
    golden: golden || metrics?.golden_collisions || 0,
    investigated,
    discoveries,
    attempts,
    high_score: highScore || metrics?.total_high_value || 0,
    deep_dived: deepDived,
    verified,
    validated
  });
});

// Force shuffle: write command file for engine to pick up
app.post('/api/shuffle/force', (req, res) => {
  try {
    const cmd = readJSON(ENGINE_CMD_FILE) || {};
    cmd.forceShuffle = true;
    cmd.forceShuffleAt = new Date().toISOString();
    const tmp = ENGINE_CMD_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cmd, null, 2));
    fs.renameSync(tmp, ENGINE_CMD_FILE);
    res.json({ ok: true, message: 'Shuffle command queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pause engine: write pause signal
app.post('/api/engine/pause', (req, res) => {
  try {
    const cmd = readJSON(ENGINE_CMD_FILE) || {};
    cmd.paused = true;
    cmd.pausedAt = new Date().toISOString();
    const tmp = ENGINE_CMD_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cmd, null, 2));
    fs.renameSync(tmp, ENGINE_CMD_FILE);
    res.json({ ok: true, message: 'Engine pause signal sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resume engine: clear pause signal
app.post('/api/engine/resume', (req, res) => {
  try {
    const cmd = readJSON(ENGINE_CMD_FILE) || {};
    cmd.paused = false;
    cmd.resumedAt = new Date().toISOString();
    const tmp = ENGINE_CMD_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cmd, null, 2));
    fs.renameSync(tmp, ENGINE_CMD_FILE);
    res.json({ ok: true, message: 'Engine resume signal sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export all gaps as JSON download
app.get('/api/export/gaps', (req, res) => {
  const findings = readFindings();
  const discoveries = findings.filter(f => f.type === 'discovery' || f.type === 'draft');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="clashd27-gaps.json"');
  res.json({ exported_at: new Date().toISOString(), gaps: discoveries });
});

// Helper for new endpoints
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) { }
  return null;
}

// --- Static files & Dashboard ---
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[DASHBOARD] Running on http://localhost:${PORT}`);
  console.log(`[PACK] Active: ${activePack?.name || 'none'}`);
});
