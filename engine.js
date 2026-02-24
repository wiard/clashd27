/**
 * CLASHD-27 — Standalone Engine (headless)
 * Thin console wrapper around TickEngine.
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env"), override: true });

const { State, getActivePack, getCellLabel } = require('./lib/state');
const { cellLabel, getLayerName } = require('./lib/cube');
const { TickEngine } = require('./lib/tick-engine');

const state = new State();
const engine = new TickEngine({ state });

// ---------------------------------------------------------------------------
// Event listeners — console output
// ---------------------------------------------------------------------------
engine.on('tick', ({ tickNum, activeCell, cycle, events, isCycleEnd }) => {
  const pack = getActivePack();
  const packLabel = getCellLabel(activeCell);
  const cubeLabel = cellLabel(activeCell);
  const label = packLabel !== `Cell ${activeCell}` ? packLabel : cubeLabel;
  const agentsHere = state.getAgentsInCell(activeCell);
  const agentNames = agentsHere.map(a => a.displayName);
  const bondEvents = events.filter(e => e.type === 'bond');

  console.log(
    `[TICK] ${tickNum} | cell=${activeCell} (${label}) | ` +
    `layer=${getLayerName(activeCell)} | cycle=${cycle} | ` +
    `agents=[${agentNames.join(', ') || 'none'}] | ` +
    `bonds=${bondEvents.length} | events=${events.length}`
  );

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
});

engine.on('cycleEnd', ({ summary }) => {
  console.log(
    `[CYCLE] ${summary.cycle} complete | ` +
    `alive=${summary.alive} dead=${summary.dead} total=${summary.totalAgents} | ` +
    `bonds=${summary.bondsThisCycle} (${summary.crossLayerBonds} cross-layer) | ` +
    `total_bonds=${summary.totalBonds}`
  );
});

engine.on('discovery', ({ discovery, agents, labels }) => {
  console.log(`  💡 DISCOVERY: ${labels.join(' x ')} | agents=${agents.join(', ')} | id=${discovery.id}`);
});

engine.on('deepDiveComplete', ({ discoveryId, result }) => {
  console.log(`[DEEP-DIVE] ${discoveryId} complete: ${result.verdict} (${result.scores.total}/100)`);
});

engine.on('verificationComplete', ({ discoveryId, result, adjustment }) => {
  console.log(`[VERIFIER] ${discoveryId} | verdict=${adjustment.final_verdict} final_score=${adjustment.final_score}${adjustment.downgraded ? ' (DOWNGRADED)' : ''}`);
});

engine.on('validationComplete', ({ discoveryId, result }) => {
  console.log(`[VALIDATOR] ${discoveryId} | feasibility=${result.overall_feasibility}`);
});

engine.on('shuffle', ({ generation, totalPapers, durationMs }) => {
  console.log(`[SHUFFLE] generation=${generation} papers=${totalPapers} (${durationMs}ms)`);
});

engine.on('budgetPaused', ({ todaySpent }) => {
  console.log(`[BUDGET] Paused — $${todaySpent.toFixed(2)} spent today`);
});

engine.on('log', ({ level, msg, ctx }) => {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (ctx) fn(`${msg} ${JSON.stringify(ctx)}`);
  else fn(msg);
});

engine.on('error', ({ phase, error, ctx }) => {
  if (ctx) console.error(`[${phase}] ${error.message} ${JSON.stringify(ctx)}`);
  else console.error(`[${phase}] ${error.message}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const pack = getActivePack();
console.log(`[ENGINE] CLASHD-27 standalone engine starting`);
console.log(`[ENGINE] Pack: ${pack ? pack.name : 'none'}`);
console.log(`[ENGINE] Tick interval: ${engine.tickInterval / 1000}s`);
console.log(`[ENGINE] State: tick=${state.tick}, agents=${state.agents.size}, bonds=${state.bonds.length}`);
console.log(`[ENGINE] Mode: ACTIVE RESEARCH (agents investigate on each tick)`);

const activeCell = state.tick % 27;
console.log(`[ENGINE] Next active cell: ${activeCell} (${cellLabel(activeCell)})`);

engine.start();

process.on('SIGINT', () => { engine.stop(); process.exit(0); });
process.on('SIGTERM', () => { engine.stop(); process.exit(0); });
