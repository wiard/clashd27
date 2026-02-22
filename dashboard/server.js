/**
 * CLASHD27 — Dashboard Server
 * Reads state.json, serves packs, and runs the live dashboard on port 3027
 */

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

  // Filter by pack if specified
  if (pack) {
    discoveries = discoveries.filter(d => d.pack === pack);
  }

  res.json({
    discoveries: discoveries.slice(-limit).reverse(),
    total: discoveries.length
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

// --- Static files & Dashboard ---
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[DASHBOARD] Running on http://localhost:${PORT}`);
  console.log(`[PACK] Active: ${activePack?.name || 'none'}`);
});
