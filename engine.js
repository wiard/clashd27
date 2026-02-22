/**
 * CLASHD-27 — Standalone Engine
 * Runs the tick cycle, agent movement, bond formation, insight generation,
 * and ACTIVE RESEARCH via the researcher module.
 */

const { State, ENERGY, loadPack, getActivePack, getCellLabel } = require('./lib/state');
const { cellLabel, cellLabelShort, getLayerName, getLayerForCell, isCrossLayer } = require('./lib/cube');
const insightGen = require('./lib/generate-insight');
const researcher = require('./lib/researcher');
const { deepDive, readDeepDives } = require('./lib/deep-dive');

const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL || '300') * 1000; // 2 minutes

const state = new State();
let clockTimer = null;

// Deep-dive queue: discoveries waiting for evaluation
let deepDiveQueue = [];

/**
 * Get an agent's accumulated keywords from state (last 5 sets)
 */
function getAgentKeywords(agent) {
  return agent.keywords || [];
}

/**
 * Update an agent's keywords after a finding
 */
function updateAgentKeywords(agent, newKeywords) {
  if (!agent.lastCellKeywords) agent.lastCellKeywords = [];

  // Add this set of keywords
  agent.lastCellKeywords.push(newKeywords);

  // Keep last 5 sets
  if (agent.lastCellKeywords.length > 5) {
    agent.lastCellKeywords = agent.lastCellKeywords.slice(-5);
  }

  // Flatten to a single unique list for easy access
  const all = new Set();
  for (const kwSet of agent.lastCellKeywords) {
    for (const kw of kwSet) all.add(kw);
  }
  agent.keywords = [...all].slice(0, 25); // Cap at 25 keywords
}

/**
 * Initialize research-tracking fields on agent if missing
 */
function ensureResearchFields(agent) {
  if (agent.keywords === undefined) agent.keywords = [];
  if (agent.lastCellKeywords === undefined) agent.lastCellKeywords = [];
  if (agent.lastCells === undefined) agent.lastCells = [];
  if (agent.findingsCount === undefined) agent.findingsCount = 0;
  if (agent.bondsWithFindings === undefined) agent.bondsWithFindings = 0;
  if (agent.discoveriesCount === undefined) agent.discoveriesCount = 0;
}

/**
 * Track which cell an agent has visited
 */
function trackCellVisit(agent, cell) {
  if (!agent.lastCells) agent.lastCells = [];
  if (agent.lastCells[agent.lastCells.length - 1] !== cell) {
    agent.lastCells.push(cell);
    if (agent.lastCells.length > 10) {
      agent.lastCells = agent.lastCells.slice(-10);
    }
  }
}

async function tick() {
  // Move all alive agents to the active cell BEFORE processing the tick
  const activeCell = state.tick % 27;
  for (const [, agent] of state.agents) {
    if (agent.alive) {
      agent.currentCell = activeCell;
    }
  }

  const result = state.processTick();
  const { tick: tickNum, activeCell: ac, cycle, events, isCycleEnd } = result;

  // Count bonds formed this tick
  const bondEvents = events.filter(e => e.type === 'bond');
  const bondsFormed = bondEvents.length;

  // Agents present in the active cell
  const agentsHere = state.getAgentsInCell(activeCell);
  const agentNames = agentsHere.map(a => a.displayName);

  // Cell label from pack if available
  const pack = getActivePack();
  const packLabel = getCellLabel(activeCell);
  const cubeLabel = cellLabel(activeCell);
  const label = packLabel !== `Cell ${activeCell}` ? packLabel : cubeLabel;
  const packName = pack ? pack.name : 'Research';

  console.log(
    `[TICK] ${tickNum} | cell=${activeCell} (${label}) | ` +
    `layer=${getLayerName(activeCell)} | cycle=${cycle} | ` +
    `agents=[${agentNames.join(', ') || 'none'}] | ` +
    `bonds=${bondsFormed} | events=${events.length}`
  );

  // Log notable events
  for (const e of events) {
    switch (e.type) {
      case 'resonance':
        console.log(`  ✨ ${e.agent} resonates in cell ${e.cell}${e.isHome ? ' (home)' : ''} [${e.energy}%]`);
        break;
      case 'clash':
        console.log(`  ⚡ ${e.agent} ${e.neighborType} clash ${e.fromCell}→${e.activeCell} [+${e.gain}%→${e.energy}%]`);
        break;
      case 'bond':
        console.log(`  🔗 BOND ${e.agent1} ⟷ ${e.agent2} in cell ${e.cell} [+${e.bonus}%]${e.crossLayer ? ' CROSS-LAYER' : ''}`);
        break;
      case 'death':
        console.log(`  💀 ${e.agent} died in cell ${e.cell}. Revive in cell ${e.homeCell}.`);
        break;
      case 'revive':
        console.log(`  🔄 ${e.reviver} revived ${e.revived} in cell ${e.cell}`);
        break;
    }
  }

  if (isCycleEnd) {
    const summary = state.getCycleSummary();
    console.log(
      `[CYCLE] ${summary.cycle} complete | ` +
      `alive=${summary.alive} dead=${summary.dead} total=${summary.totalAgents} | ` +
      `bonds=${summary.bondsThisCycle} (${summary.crossLayerBonds} cross-layer) | ` +
      `total_bonds=${summary.totalBonds}`
    );
  }

  // Process any pending insight/discovery queue (legacy)
  insightGen.processQueue(result.tick);

  // === DEEP DIVE (max 1 per tick) ===
  if (deepDiveQueue.length > 0) {
    const discovery = deepDiveQueue.shift();
    console.log(`[ENGINE] Deep-diving ${discovery.id} (${deepDiveQueue.length} remaining in queue)`);
    try {
      const result = await deepDive(discovery);
      if (result) {
        console.log(`[ENGINE] Deep-dive complete: ${result.verdict} (${result.scores.total}/100)`);
      }
    } catch (err) {
      console.error(`[ENGINE] Deep-dive error: ${err.message}`);
    }
  }

  // === ACTIVE RESEARCH ===
  // Only research if agents are on the active cell and pack is loaded
  if (agentsHere.length > 0 && pack) {
    let apiCallsThisTick = 0;
    const MAX_API_CALLS = 2;

    // Ensure all agents have research fields
    for (const agent of agentsHere) {
      ensureResearchFields(agent);
      trackCellVisit(agent, activeCell);
    }

    // 1. Pick the first agent to investigate the cell
    const leadAgent = agentsHere[0];

    if (apiCallsThisTick < MAX_API_CALLS) {
      apiCallsThisTick++;
      try {
        const cellFinding = await researcher.investigateCell({
          tick: tickNum,
          agentName: leadAgent.displayName,
          cell: activeCell,
          cellLabel: label,
          packName
        });

        if (cellFinding && cellFinding.keywords) {
          updateAgentKeywords(leadAgent, cellFinding.keywords);
          leadAgent.findingsCount = (leadAgent.findingsCount || 0) + 1;
          console.log(`  🔬 ${leadAgent.displayName} found: [${cellFinding.keywords.join(', ')}]`);
        }
      } catch (err) {
        console.error(`  [RESEARCHER] Cell investigation error: ${err.message}`);
      }
    }

    // Delay between API calls — rate limit is 30k input tokens/minute
    // Web search responses include large encrypted content, so we need ~60s between calls
    if (apiCallsThisTick > 0) {
      console.log(`[RESEARCHER] Waiting 60s before second API call (rate limit)...`);
      await new Promise(r => setTimeout(r, 60000));
    }

    // 2. If multiple agents — investigate bond between first pair
    if (agentsHere.length >= 2 && apiCallsThisTick < MAX_API_CALLS) {
      const agent1 = agentsHere[0];
      const agent2 = agentsHere[1];
      const a1Home = agent1.homeCell;
      const a2Home = agent2.homeCell;
      const a1Label = getCellLabel(a1Home);
      const a2Label = getCellLabel(a2Home);
      const crossLayer = isCrossLayer(a1Home, a2Home);

      if (crossLayer) {
        // Cross-layer: discovery investigation
        const layer0Agent = getLayerForCell(a1Home) === 0 ? agent1 : (getLayerForCell(a2Home) === 0 ? agent2 : agent1);
        const layer2Agent = layer0Agent === agent1 ? agent2 : agent1;
        const layer0Label = getCellLabel(layer0Agent.homeCell);
        const layer2Label = getCellLabel(layer2Agent.homeCell);

        apiCallsThisTick++;
        try {
          const discovery = await researcher.investigateDiscovery({
            tick: tickNum,
            cell: activeCell,
            cellLabel: label,
            agent1Name: layer0Agent.displayName,
            agent2Name: layer2Agent.displayName,
            layer0Cell: layer0Label,
            layer2Cell: layer2Label,
            packName,
            dataKeywords: getAgentKeywords(layer0Agent),
            hypothesisKeywords: getAgentKeywords(layer2Agent)
          });

          if (discovery) {
            layer0Agent.discoveriesCount = (layer0Agent.discoveriesCount || 0) + 1;
            layer2Agent.discoveriesCount = (layer2Agent.discoveriesCount || 0) + 1;
            layer0Agent.bondsWithFindings = (layer0Agent.bondsWithFindings || 0) + 1;
            layer2Agent.bondsWithFindings = (layer2Agent.bondsWithFindings || 0) + 1;
            console.log(`  💡 DISCOVERY: ${layer0Label} x ${layer2Label} | impact=${discovery.impact} | feasibility=${discovery.feasibility}`);

            // Queue for deep-dive if high impact or high novelty
            if (discovery.impact === 'high' || discovery.novelty === 'high') {
              deepDiveQueue.push(discovery);
              console.log(`  🔭 Queued ${discovery.id} for deep-dive (queue: ${deepDiveQueue.length})`);
            }
          }
        } catch (err) {
          console.error(`  [RESEARCHER] Discovery investigation error: ${err.message}`);
        }
      } else {
        // Same-layer: bond investigation
        apiCallsThisTick++;
        try {
          const bondFinding = await researcher.investigateBond({
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
            console.log(`  🔗 BOND FINDING: ${a1Label} x ${a2Label} | ${bondFinding.strength} | ${bondFinding.novelty} novelty`);
          }
        } catch (err) {
          console.error(`  [RESEARCHER] Bond investigation error: ${err.message}`);
        }
      }
    }

    // Save updated agent state (keywords, counts)
    state.save();
  }
}

function start() {
  const pack = getActivePack();
  console.log(`[ENGINE] CLASHD-27 standalone engine starting`);
  console.log(`[ENGINE] Pack: ${pack ? pack.name : 'none'}`);
  console.log(`[ENGINE] Tick interval: ${TICK_INTERVAL / 1000}s`);
  console.log(`[ENGINE] State: tick=${state.tick}, agents=${state.agents.size}, bonds=${state.bonds.length}`);
  console.log(`[ENGINE] Mode: ACTIVE RESEARCH (agents investigate on each tick)`);

  // Initialize research fields for existing agents
  for (const [, agent] of state.agents) {
    ensureResearchFields(agent);
  }
  state.save();

  const activeCell = state.tick % 27;
  console.log(`[ENGINE] Next active cell: ${activeCell} (${cellLabel(activeCell)})`);

  clockTimer = setInterval(tick, TICK_INTERVAL);
  console.log(`[ENGINE] Clock running.`);
}

function shutdown() {
  console.log(`[ENGINE] Shutting down...`);
  clearInterval(clockTimer);
  state.save();
  console.log(`[ENGINE] State saved. Goodbye.`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
