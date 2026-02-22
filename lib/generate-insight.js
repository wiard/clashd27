/**
 * CLASHD-27 Insight Generator
 * Calls Anthropic API via local proxy to generate research insights
 * Rate limited to 1 call per tick (~10 minutes)
 * Now integrates daily research briefings for grounded insights
 */

const fs = require('fs');
const path = require('path');
const insights = require('./insights');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const RESEARCH_FILE = path.join(__dirname, '..', 'data', 'daily-research.json');

/**
 * Load today's research briefing for a specific cell
 */
function getResearchBriefing(cellId) {
  try {
    if (!fs.existsSync(RESEARCH_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    // Only use if from today
    if (data.date !== today) return null;
    const briefing = data.briefings.find(b => b.cell === cellId);
    return briefing || null;
  } catch (e) {
    return null;
  }
}

// Rate limiting: track last generation tick
let lastGenerationTick = -1;
let pendingQueue = [];
let isProcessing = false;

/**
 * Generate insight content via API
 */
async function callAPI(prompt) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.error('[INSIGHT-GEN] API error:', response.status);
      return null;
    }

    const data = await response.json();
    if (data.content && data.content[0] && data.content[0].text) {
      return data.content[0].text.trim();
    }
    return null;
  } catch (err) {
    console.error('[INSIGHT-GEN] API call failed:', err.message);
    return null;
  }
}

/**
 * Process the queue - only one API call per tick
 */
async function processQueue(currentTick) {
  console.log(`[INSIGHT-GEN] processQueue called: tick=${currentTick}, queue=${pendingQueue.length}, lastTick=${lastGenerationTick}, processing=${isProcessing}`);
  if (isProcessing) return;
  if (pendingQueue.length === 0) return;
  if (currentTick <= lastGenerationTick) return; // Already generated this tick

  isProcessing = true;

  // Take the highest priority item (DISCOVERY > BOND > CELL)
  pendingQueue.sort((a, b) => {
    const priority = { DISCOVERY: 0, BOND_INSIGHT: 1, CELL_INSIGHT: 2 };
    return (priority[a.type] || 99) - (priority[b.type] || 99);
  });

  const item = pendingQueue.shift();
  lastGenerationTick = currentTick;

  try {
    const content = await callAPI(item.prompt);
    if (content) {
      insights.addInsight({
        type: item.type,
        tick: item.tick,
        cell: item.cell,
        cellLabel: item.cellLabel,
        layer: item.layer,
        agentName: item.agentName,
        content,
        metadata: item.metadata || {}
      });
    }
  } catch (err) {
    console.error('[INSIGHT-GEN] Generation failed:', err.message);
  }

  isProcessing = false;
}

/**
 * Queue a CELL_INSIGHT when agent arrives on active cell
 * If daily research briefing exists for this cell, use it to ground the insight
 */
function queueCellInsight({ tick, cell, cellLabel, layer, agentName, packName }) {
  console.log(`[INSIGHT-GEN] Queueing CELL_INSIGHT: agent=${agentName}, cell=${cell}, label=${cellLabel}`);

  // Check for daily research briefing
  const briefing = getResearchBriefing(cell);
  let prompt;

  if (briefing && briefing.articles && briefing.articles.length > 0) {
    // Use real research to ground the insight
    const researchSummary = briefing.articles.map(a =>
      `- "${a.title}" (${a.source}, ${a.date}): ${a.summary}`
    ).join('\n');

    prompt = `You are a research agent on cell "${cellLabel}" in ${packName}. Today's real research includes:

${researchSummary}

Generate a specific 2-3 sentence insight that connects this real research to the broader domain. Reference the actual paper or finding. Be concrete and insightful.`;
  } else {
    // Fallback to generic prompt
    prompt = `You are a research agent exploring "${cellLabel}" in the field of ${packName}. Generate one specific, concrete research observation in 2-3 sentences. Be precise — cite real concepts, real mechanisms, real data patterns. No fluff. No generalities. This should read like a note from a specialist.`;
  }

  pendingQueue.push({
    type: 'CELL_INSIGHT',
    tick,
    cell,
    cellLabel,
    layer,
    agentName,
    prompt,
    metadata: { packName, hasResearchBriefing: !!briefing }
  });

  processQueue(tick);
}

/**
 * Queue a BOND_INSIGHT when two agents meet on same cell
 */
function queueBondInsight({ tick, cell, cellLabel, layer, agent1Name, agent2Name, agent1Cell, agent2Cell, agent1Label, agent2Label, packName }) {
  const prompt = `Two research agents have met: one specializing in "${agent1Label}" and one in "${agent2Label}", both in ${packName}. Generate a specific cross-domain connection in 2-3 sentences. What concrete link exists between these two areas that most researchers miss? Be precise and surprising.`;

  pendingQueue.push({
    type: 'BOND_INSIGHT',
    tick,
    cell,
    cellLabel,
    layer,
    agentName: `${agent1Name}, ${agent2Name}`,
    prompt,
    metadata: { packName, agent1Label, agent2Label, agent1Name, agent2Name }
  });

  processQueue(tick);
}

/**
 * Queue a DISCOVERY when cross-layer bond forms
 */
function queueDiscovery({ tick, cell, cellLabel, layer, agent1Name, agent2Name, agent1Layer, agent2Layer, agent1Label, agent2Label, packName }) {
  // Determine which is data (layer 0) and which is hypothesis (layer 2)
  let dataLabel, hypothesisLabel;
  if (agent1Layer === 0) {
    dataLabel = agent1Label;
    hypothesisLabel = agent2Label;
  } else if (agent2Layer === 0) {
    dataLabel = agent2Label;
    hypothesisLabel = agent1Label;
  } else {
    // Both analysis/hypothesis - still interesting
    dataLabel = agent1Label;
    hypothesisLabel = agent2Label;
  }

  const prompt = `A data agent ("${dataLabel}") and a hypothesis agent ("${hypothesisLabel}") have connected in ${packName}. Generate a novel hypothesis in 1-2 sentences that emerges from combining hard data with frontier thinking. Be bold but grounded.`;

  pendingQueue.push({
    type: 'DISCOVERY',
    tick,
    cell,
    cellLabel,
    layer,
    agentName: `${agent1Name}, ${agent2Name}`,
    prompt,
    metadata: { packName, agent1Label, agent2Label, agent1Name, agent2Name, crossLayer: true }
  });

  processQueue(tick);
}

/**
 * Get queue status
 */
function getQueueStatus() {
  return {
    pending: pendingQueue.length,
    lastGenerationTick,
    isProcessing
  };
}

/**
 * Clear queue (for testing)
 */
function clearQueue() {
  pendingQueue = [];
}

module.exports = {
  queueCellInsight,
  queueBondInsight,
  queueDiscovery,
  getQueueStatus,
  clearQueue,
  processQueue
};
