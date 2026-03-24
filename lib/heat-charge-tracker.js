const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'heat-charge-state.json');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      heat: 0,
      charge: 0,
      publishedGaps: 0,
      approvedProposals: 0,
      totalRuns: 0,
      queueSize: 0,
      lastUpdated: new Date().toISOString(),
      chargeRatio: 0,
      status: 'ALARM',
      queueAlarm: false
    };
  }
}

function saveState(state) {
  ensureDir(STATE_FILE);
  state.lastUpdated = new Date().toISOString();
  state.chargeRatio = state.heat + state.charge > 0
    ? state.charge / (state.heat + state.charge)
    : 0;
  state.status =
    state.chargeRatio > 0.30 ? 'EXCELLENT' :
    state.chargeRatio > 0.15 ? 'GOOD' :
    state.chargeRatio > 0.05 ? 'LOW' : 'ALARM';
  state.queueAlarm = Number(state.queueSize || 0) > 200;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

function recordHeat(reason = 'tick') {
  const state = loadState();
  state.heat += 1;
  state.totalRuns += 1;
  state.lastHeatReason = reason;
  return saveState(state);
}

function recordCharge(reason = 'gap') {
  const state = loadState();
  state.charge += 1;
  state.lastChargeReason = reason;
  if (reason === 'gap') state.publishedGaps += 1;
  if (reason === 'approval') state.approvedProposals += 1;
  return saveState(state);
}

function updateQueueSize(size) {
  const state = loadState();
  state.queueSize = Math.max(0, Number(size || 0));
  return saveState(state);
}

function getMetrics() {
  return loadState();
}

module.exports = {
  recordHeat,
  recordCharge,
  updateQueueSize,
  getMetrics
};
