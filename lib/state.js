/**
 * CLASHD-27 State Management
 * Different neighbor types yield different energy:
 *   Face clash:   +12%  (direct, strong)
 *   Edge clash:   +8%   (diagonal, moderate)
 *   Corner clash: +5%   (deep diagonal, rare)
 *   Resonance:    +15%  (home cell active)
 *
 * Cross-layer bonds are worth more than same-layer bonds.
 */

const fs = require('fs');
const path = require('path');
const { getNeighbors, getNeighborType, isCrossLayer, NEIGHBOR_TYPE, getLayerForCell } = require('./cube');
const insightGen = require('./generate-insight');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');
const PACKS_DIR = path.join(__dirname, '..', 'packs');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'agent-history.json');

// Agent history tracking
function logAgentEvent(event) {
  try {
    let history = { events: [] };
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
    history.events.push({
      ...event,
      timestamp: new Date().toISOString()
    });
    // Keep last 10000 events
    if (history.events.length > 10000) {
      history.events = history.events.slice(-10000);
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('[HISTORY] Log failed:', e.message);
  }
}

// Active pack for insight generation
let activePack = null;

function loadPack(packId) {
  try {
    const packPath = path.join(PACKS_DIR, packId + '.json');
    if (fs.existsSync(packPath)) {
      activePack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      console.log(`[STATE] Pack loaded: ${activePack.name}`);
    }
  } catch (err) {
    console.error('[STATE] Pack load failed:', err.message);
  }
}

function getActivePack() {
  return activePack;
}

function getCellLabel(cell) {
  if (activePack && activePack.cells && activePack.cells[String(cell)]) {
    return activePack.cells[String(cell)].label;
  }
  return `Cell ${cell}`;
}

// Load default pack
loadPack('cancer-research');

const ENERGY = {
  MAX: 100,
  START: 100,
  RESONANCE: 15,
  CLASH_FACE: 12,
  CLASH_EDGE: 8,
  CLASH_CORNER: 5,
  IDLE_DRAIN: -2,
  REVIVE: 50,
  BOND_BONUS: 5,
  BOND_CROSS_LAYER: 8,
};

class State {
  constructor() {
    this.agents = new Map();
    this.bonds = [];
    this.alliances = [];
    this.shouts = [];
    this.tick = 0;
    this.events = [];
    this.load();
  }

  addAgent(discordId, displayName, chosenNumber) {
    if (this.agents.has(discordId)) return { ok: false, reason: 'already_joined' };
    const homeCell = chosenNumber % 27;
    const agent = {
      discordId, displayName, chosenNumber, homeCell,
      currentCell: homeCell, energy: ENERGY.START, alive: true,
      totalBonds: 0, crossLayerBonds: 0,
      survivalStreak: 0, longestStreak: 0, deaths: 0,
      clashCounts: { face: 0, edge: 0, corner: 0 },
      joinedAtTick: this.tick, lastActive: Date.now(),
    };
    this.agents.set(discordId, agent);
    this.save();
    return { ok: true, agent };
  }

  getAgent(discordId) {
    return this.agents.get(discordId) || null;
  }

  moveAgent(discordId, targetCell) {
    const agent = this.agents.get(discordId);
    if (!agent) return { ok: false, reason: 'not_found' };
    if (!agent.alive) return { ok: false, reason: 'dead' };
    if (targetCell < 0 || targetCell > 26) return { ok: false, reason: 'invalid_cell' };
    const oldCell = agent.currentCell;
    agent.currentCell = targetCell;
    agent.lastActive = Date.now();
    this.save();
    return { ok: true, oldCell, newCell: targetCell };
  }

  processTick() {
    const activeCell = this.tick % 27;
    const cycle = Math.floor(this.tick / 27);
    this.events = [];
    const agentsInActiveCell = [];
    const neighbors = getNeighbors(activeCell);

    for (const [id, agent] of this.agents) {
      if (!agent.alive) continue;

      if (agent.currentCell === activeCell) {
        const isHome = agent.homeCell === activeCell;
        agent.energy = Math.min(ENERGY.MAX, agent.energy + ENERGY.RESONANCE);
        agent.survivalStreak++;
        agentsInActiveCell.push(agent);
        this.events.push({ type: 'resonance', agent: agent.displayName, agentId: agent.discordId, cell: activeCell, isHome, energy: agent.energy });

        // Log to agent history
        logAgentEvent({
          tick: this.tick,
          agent: agent.displayName,
          cell: activeCell,
          cellLabel: getCellLabel(activeCell),
          event: 'resonance',
          isHome,
          energy: agent.energy
        });

        // Generate CELL_INSIGHT for resonance (only if first agent this tick)
        if (activePack && agentsInActiveCell.length === 1) {
          const cellLabel = getCellLabel(activeCell);
          const layer = getLayerForCell(activeCell);
          insightGen.queueCellInsight({
            tick: this.tick,
            cell: activeCell,
            cellLabel,
            layer,
            agentName: agent.displayName,
            packName: activePack.name
          });
        }

      } else if (neighbors.includes(agent.currentCell)) {
        const nType = getNeighborType(agent.currentCell, activeCell);
        let gain = ENERGY.CLASH_FACE;
        if (nType === NEIGHBOR_TYPE.EDGE) gain = ENERGY.CLASH_EDGE;
        if (nType === NEIGHBOR_TYPE.CORNER) gain = ENERGY.CLASH_CORNER;
        agent.energy = Math.min(ENERGY.MAX, agent.energy + gain);
        agent.survivalStreak++;
        if (nType && agent.clashCounts) agent.clashCounts[nType] = (agent.clashCounts[nType] || 0) + 1;
        this.events.push({ type: 'clash', agent: agent.displayName, agentId: agent.discordId, fromCell: agent.currentCell, activeCell, neighborType: nType, gain, energy: agent.energy });

      } else {
        agent.energy = Math.max(0, agent.energy + ENERGY.IDLE_DRAIN);
        agent.survivalStreak++;
        if (agent.energy <= 0) {
          agent.alive = false;
          agent.longestStreak = Math.max(agent.longestStreak, agent.survivalStreak);
          agent.survivalStreak = 0;
          agent.deaths++;
          this.events.push({ type: 'death', agent: agent.displayName, agentId: agent.discordId, cell: agent.currentCell, homeCell: agent.homeCell, tick: this.tick });
        }
      }
    }

    if (agentsInActiveCell.length >= 2) {
      for (let i = 0; i < agentsInActiveCell.length; i++) {
        for (let j = i + 1; j < agentsInActiveCell.length; j++) {
          const a1 = agentsInActiveCell[i];
          const a2 = agentsInActiveCell[j];
          const crossLayer = isCrossLayer(a1.homeCell, a2.homeCell);
          const bonus = crossLayer ? ENERGY.BOND_CROSS_LAYER : ENERGY.BOND_BONUS;
          this.bonds.push({ agent1: a1.displayName, agent1Id: a1.discordId, agent2: a2.displayName, agent2Id: a2.discordId, cell: activeCell, tick: this.tick, cycle, crossLayer, timestamp: Date.now() });
          a1.totalBonds++; a2.totalBonds++;
          if (crossLayer) { a1.crossLayerBonds = (a1.crossLayerBonds || 0) + 1; a2.crossLayerBonds = (a2.crossLayerBonds || 0) + 1; }
          a1.energy = Math.min(ENERGY.MAX, a1.energy + bonus);
          a2.energy = Math.min(ENERGY.MAX, a2.energy + bonus);
          this.events.push({ type: 'bond', agent1: a1.displayName, agent2: a2.displayName, cell: activeCell, tick: this.tick, crossLayer, bonus });

          // Log bond to both agents' history
          const cellLabel = getCellLabel(activeCell);
          logAgentEvent({
            tick: this.tick,
            agent: a1.displayName,
            cell: activeCell,
            cellLabel,
            event: 'bond',
            bondWith: a2.displayName,
            crossLayer
          });
          logAgentEvent({
            tick: this.tick,
            agent: a2.displayName,
            cell: activeCell,
            cellLabel,
            event: 'bond',
            bondWith: a1.displayName,
            crossLayer
          });

          // Generate insight for bond
          if (activePack) {
            const cellLabel = getCellLabel(activeCell);
            const a1Label = getCellLabel(a1.homeCell);
            const a2Label = getCellLabel(a2.homeCell);
            const layer = getLayerForCell(activeCell);

            if (crossLayer) {
              // Cross-layer bond = DISCOVERY
              insightGen.queueDiscovery({
                tick: this.tick,
                cell: activeCell,
                cellLabel,
                layer,
                agent1Name: a1.displayName,
                agent2Name: a2.displayName,
                agent1Layer: getLayerForCell(a1.homeCell),
                agent2Layer: getLayerForCell(a2.homeCell),
                agent1Label: a1Label,
                agent2Label: a2Label,
                packName: activePack.name
              });
            } else {
              // Same-layer bond = BOND_INSIGHT
              insightGen.queueBondInsight({
                tick: this.tick,
                cell: activeCell,
                cellLabel,
                layer,
                agent1Name: a1.displayName,
                agent2Name: a2.displayName,
                agent1Cell: a1.homeCell,
                agent2Cell: a2.homeCell,
                agent1Label: a1Label,
                agent2Label: a2Label,
                packName: activePack.name
              });
            }
          }
        }
      }
    }

    for (const [id, deadAgent] of this.agents) {
      if (deadAgent.alive) continue;
      if (deadAgent.homeCell !== activeCell) continue;
      const reviver = agentsInActiveCell.find(a => a.discordId !== id && a.alive);
      if (reviver) {
        deadAgent.alive = true;
        deadAgent.energy = ENERGY.REVIVE;
        deadAgent.currentCell = deadAgent.homeCell;
        this.events.push({ type: 'revive', reviver: reviver.displayName, revived: deadAgent.displayName, cell: activeCell, tick: this.tick });
      }
    }

    this.tick++;
    this.save();
    return { tick: this.tick - 1, activeCell, cycle, events: this.events, isCycleEnd: this.tick % 27 === 0 };
  }

  getCycleSummary() {
    const cycle = Math.floor((this.tick - 1) / 27);
    const aliveAgents = [...this.agents.values()].filter(a => a.alive);
    const deadAgents = [...this.agents.values()].filter(a => !a.alive);
    const cycleBonds = this.bonds.filter(b => b.cycle === cycle);
    const crossBonds = cycleBonds.filter(b => b.crossLayer);
    const cellHeat = new Map();
    for (let i = 0; i < 27; i++) cellHeat.set(i, 0);
    for (const bond of cycleBonds) cellHeat.set(bond.cell, (cellHeat.get(bond.cell) || 0) + 1);
    return {
      cycle, totalAgents: this.agents.size, alive: aliveAgents.length, dead: deadAgents.length,
      bondsThisCycle: cycleBonds.length, crossLayerBonds: crossBonds.length, totalBonds: this.bonds.length, cellHeat,
      topAgents: aliveAgents.sort((a, b) => b.energy - a.energy).slice(0, 10).map(a => ({ name: a.displayName, energy: a.energy, bonds: a.totalBonds, crossLayer: a.crossLayerBonds || 0, streak: a.survivalStreak })),
    };
  }

  getLeaderboard() {
    const agents = [...this.agents.values()];
    return {
      byEnergy: [...agents].filter(a => a.alive).sort((a, b) => b.energy - a.energy).slice(0, 10),
      byBonds: [...agents].sort((a, b) => b.totalBonds - a.totalBonds).slice(0, 10),
      byStreak: [...agents].sort((a, b) => Math.max(b.survivalStreak, b.longestStreak) - Math.max(a.survivalStreak, a.longestStreak)).slice(0, 10),
      byCrossLayer: [...agents].sort((a, b) => (b.crossLayerBonds || 0) - (a.crossLayerBonds || 0)).filter(a => (a.crossLayerBonds || 0) > 0).slice(0, 10),
    };
  }

  getBondNetwork(discordId) {
    const agent = this.agents.get(discordId);
    if (!agent) return null;
    const connections = new Map();
    for (const bond of this.bonds) {
      const otherId = bond.agent1Id === discordId ? bond.agent2Id : bond.agent2Id === discordId ? bond.agent1Id : null;
      if (!otherId) continue;
      const existing = connections.get(otherId) || { count: 0, crossLayer: 0 };
      existing.count++;
      if (bond.crossLayer) existing.crossLayer++;
      connections.set(otherId, existing);
    }
    return {
      agent: agent.displayName, totalBonds: agent.totalBonds, crossLayerBonds: agent.crossLayerBonds || 0,
      uniqueConnections: connections.size,
      connections: [...connections.entries()].map(([id, data]) => ({ name: this.agents.get(id)?.displayName || 'Unknown', bondCount: data.count, crossLayer: data.crossLayer })).sort((a, b) => b.bondCount - a.bondCount),
    };
  }

  addAlliance(id1, name1, id2, name2) {
    const exists = this.alliances.find(a => (a.agent1Id === id1 && a.agent2Id === id2) || (a.agent1Id === id2 && a.agent2Id === id1));
    if (exists) return { ok: false, reason: 'already_allied' };
    this.alliances.push({ agent1Id: id1, agent1Name: name1, agent2Id: id2, agent2Name: name2, tick: this.tick, timestamp: Date.now() });
    this.save();
    return { ok: true };
  }

  getAlliances(discordId) {
    return this.alliances
      .filter(a => a.agent1Id === discordId || a.agent2Id === discordId)
      .map(a => ({ ally: a.agent1Id === discordId ? a.agent2Name : a.agent1Name, allyId: a.agent1Id === discordId ? a.agent2Id : a.agent1Id, since: a.tick }));
  }

  addShout(discordId, displayName, message) {
    this.shouts.push({ agentId: discordId, agentName: displayName, message, tick: this.tick, timestamp: Date.now() });
    if (this.shouts.length > 100) this.shouts = this.shouts.slice(-100);
    this.save();
  }

  getAgentsInCell(cell) {
    return [...this.agents.values()].filter(a => a.alive && a.currentCell === cell);
  }

  getRivals(discordId) {
    const agent = this.agents.get(discordId);
    if (!agent) return null;
    const sorted = [...this.agents.values()].filter(a => a.alive).sort((a, b) => b.energy - a.energy);
    const myIndex = sorted.findIndex(a => a.discordId === discordId);
    if (myIndex === -1) return { agent, rivals: [], rank: -1 };
    const start = Math.max(0, myIndex - 3);
    const end = Math.min(sorted.length, myIndex + 4);
    const rivals = sorted.slice(start, end).map((a, i) => ({ name: a.displayName, energy: a.energy, bonds: a.totalBonds, isYou: a.discordId === discordId, rank: start + i + 1 }));
    return { agent, rivals, rank: myIndex + 1, total: sorted.length };
  }

  getGridState() {
    const occupants = new Map();
    for (const agent of this.agents.values()) {
      if (!agent.alive) continue;
      occupants.set(agent.currentCell, (occupants.get(agent.currentCell) || 0) + 1);
    }
    return occupants;
  }

  save() {
    const data = { tick: this.tick, agents: Object.fromEntries(this.agents), bonds: this.bonds, alliances: this.alliances, shouts: this.shouts };
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  }

  load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.tick = data.tick || 0;
        this.agents = new Map(Object.entries(data.agents || {}));
        this.bonds = data.bonds || [];
        this.alliances = data.alliances || [];
        this.shouts = data.shouts || [];
        console.log(`[STATE] Loaded: tick=${this.tick}, agents=${this.agents.size}, bonds=${this.bonds.length}`);
      } else {
        console.log('[STATE] Fresh start');
      }
    } catch (err) {
      console.error('[STATE] Load failed:', err.message);
    }
  }
}

module.exports = { State, ENERGY, loadPack, getActivePack, getCellLabel };
