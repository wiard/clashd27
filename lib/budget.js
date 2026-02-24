const fs = require('fs');
const path = require('path');

const BUDGET_FILE = path.join(__dirname, '..', 'data', 'budget.json');
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '2.00');

const MODEL_COSTS = {
  'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
  'claude-sonnet-4-5-20250929': { input: 0.003, output: 0.015 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 }
};

function todayKeyUtc() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeModel(model) {
  if (!model) return model;
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'claude-haiku-4-5-20251001';
  if (m.includes('sonnet')) return 'claude-sonnet-4-5-20250929';
  return model;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function readBudget() {
  let budget = null;
  try {
    if (fs.existsSync(BUDGET_FILE)) {
      budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    }
  } catch (e) {
    budget = null;
  }

  const today = todayKeyUtc();
  if (!budget || budget.date !== today) {
    budget = {
      date: today,
      spent_usd: 0,
      calls_total: 0,
      calls_by_model: {},
      tokens_by_model: {},
      deep_dives_today: 0,
      last_updated: new Date().toISOString()
    };
  }

  return budget;
}

function writeBudget(budget) {
  const dir = path.dirname(BUDGET_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = BUDGET_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(budget, null, 2));
  fs.renameSync(tmp, BUDGET_FILE);
}

function estimateCostUSD(model, inputTokens, outputTokens) {
  const key = normalizeModel(model);
  const costs = MODEL_COSTS[key];
  if (!costs) return 0;
  const inCost = (inputTokens / 1000) * costs.input;
  const outCost = (outputTokens / 1000) * costs.output;
  return inCost + outCost;
}

function trackCall(model, inputTokens, outputTokens) {
  const budget = readBudget();
  const cost = estimateCostUSD(model, inputTokens, outputTokens);

  budget.spent_usd = Math.round((budget.spent_usd + cost) * 10000) / 10000;
  budget.calls_total = (budget.calls_total || 0) + 1;

  const key = normalizeModel(model) || 'unknown';
  budget.calls_by_model[key] = (budget.calls_by_model[key] || 0) + 1;
  budget.tokens_by_model[key] = (budget.tokens_by_model[key] || 0) + inputTokens + outputTokens;
  budget.last_updated = new Date().toISOString();

  writeBudget(budget);

  const remaining = Math.max(0, DAILY_BUDGET_USD - budget.spent_usd);
  return {
    todaySpent: budget.spent_usd,
    budgetRemaining: remaining,
    overBudget: budget.spent_usd >= DAILY_BUDGET_USD,
    cost
  };
}

function canAffordCall(model, estimatedInputTokens, estimatedOutputTokens = 0, bufferUsd = 0) {
  const budget = readBudget();
  const estimate = estimateCostUSD(model, estimatedInputTokens, estimatedOutputTokens);
  return (budget.spent_usd + estimate + bufferUsd) <= DAILY_BUDGET_USD;
}

function isOverBudget() {
  const budget = readBudget();
  return budget.spent_usd >= DAILY_BUDGET_USD;
}

function recordDeepDive() {
  const budget = readBudget();
  budget.deep_dives_today = (budget.deep_dives_today || 0) + 1;
  budget.last_updated = new Date().toISOString();
  writeBudget(budget);
  return budget.deep_dives_today;
}

function canRunDeepDive(maxPerDay) {
  const budget = readBudget();
  return (budget.deep_dives_today || 0) < maxPerDay;
}

function getStatus() {
  const budget = readBudget();
  return {
    todaySpent: budget.spent_usd,
    budgetRemaining: Math.max(0, DAILY_BUDGET_USD - budget.spent_usd),
    overBudget: budget.spent_usd >= DAILY_BUDGET_USD,
    deepDivesToday: budget.deep_dives_today || 0,
    date: budget.date
  };
}

module.exports = {
  DAILY_BUDGET_USD,
  estimateTokens,
  estimateCostUSD,
  trackCall,
  canAffordCall,
  isOverBudget,
  recordDeepDive,
  canRunDeepDive,
  getStatus
};
