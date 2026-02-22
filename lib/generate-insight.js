/**
 * CLASHD-27 Cross-Domain Discovery Engine
 * Finds real connections between research domains using web search
 * Rate limited to 1 call per tick
 */

const fs = require('fs');
const path = require('path');
const insights = require('./insights');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const RESEARCH_FILE = path.join(__dirname, '..', 'data', 'daily-research.json');
const DISCOVERIES_FILE = path.join(__dirname, '..', 'data', 'discoveries.json');

// Rate limiting
let lastGenerationTick = -1;
let pendingQueue = [];
let isProcessing = false;
let discoveryCounter = 0;

/**
 * Load today's research briefing for a specific cell
 */
function getResearchBriefing(cellId) {
  try {
    if (!fs.existsSync(RESEARCH_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8'));
    const today = new Date().toISOString().split('T')[0];
    if (data.date !== today) return null;
    return data.briefings.find(b => b.cell === cellId) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Load discoveries database
 */
function loadDiscoveries() {
  try {
    if (fs.existsSync(DISCOVERIES_FILE)) {
      return JSON.parse(fs.readFileSync(DISCOVERIES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[DISCOVERY] Load failed:', e.message);
  }
  return { discoveries: [] };
}

/**
 * Save discovery to database
 */
function saveDiscovery(discovery) {
  const data = loadDiscoveries();
  discoveryCounter++;
  discovery.id = `disc-${String(discoveryCounter).padStart(4, '0')}`;
  data.discoveries.push(discovery);

  // Keep last 500 discoveries
  if (data.discoveries.length > 500) {
    data.discoveries = data.discoveries.slice(-500);
  }

  const dir = path.dirname(DISCOVERIES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DISCOVERIES_FILE, JSON.stringify(data, null, 2));
  console.log(`[DISCOVERY] Saved: ${discovery.id} — ${discovery.agentDomains.join(' × ')}`);
  return discovery;
}

/**
 * Call API without web search (for cell insights)
 */
async function callAPI(prompt) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
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
 * Call API WITH web search (for cross-domain discoveries)
 */
async function callAPIWithSearch(prompt) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.error('[DISCOVERY] API error:', response.status);
      return null;
    }

    const data = await response.json();

    // Extract text from response (may have multiple blocks)
    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
    }
    return text.trim();
  } catch (err) {
    console.error('[DISCOVERY] API call failed:', err.message);
    return null;
  }
}

/**
 * Parse JSON from API response
 */
function parseDiscoveryJSON(text) {
  try {
    // Try to find JSON object in response
    const jsonMatch = text.match(/\{[\s\S]*"connection"[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('[DISCOVERY] JSON parse failed:', e.message);
  }
  return null;
}

/**
 * Process the queue - only one API call per tick
 */
async function processQueue(currentTick) {
  if (isProcessing) return;
  if (pendingQueue.length === 0) return;
  if (currentTick <= lastGenerationTick) return;

  isProcessing = true;

  // Priority: DISCOVERY > BOND > CELL
  pendingQueue.sort((a, b) => {
    const priority = { DISCOVERY: 0, BOND_INSIGHT: 1, CELL_INSIGHT: 2 };
    return (priority[a.type] || 99) - (priority[b.type] || 99);
  });

  const item = pendingQueue.shift();
  lastGenerationTick = currentTick;

  try {
    if (item.type === 'CELL_INSIGHT') {
      // Regular insight without web search
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
    } else {
      // BOND_INSIGHT or DISCOVERY — use web search for real connections
      const rawResponse = await callAPIWithSearch(item.prompt);

      if (rawResponse) {
        const parsed = parseDiscoveryJSON(rawResponse);

        if (parsed && parsed.connection) {
          // Save to discoveries database
          const discovery = saveDiscovery({
            tick: item.tick,
            cell: item.cell,
            cellLabel: item.cellLabel,
            agents: item.metadata.agents || [item.metadata.agent1Name, item.metadata.agent2Name],
            agentDomains: [item.metadata.agent1Label, item.metadata.agent2Label],
            connection: parsed.connection,
            evidence: parsed.evidence || '',
            source: parsed.source || '',
            novelty: parsed.novelty || 'medium',
            hypothesis: parsed.hypothesis || '',
            pack: item.metadata.packName,
            crossLayer: item.metadata.crossLayer || false,
            type: item.type,
            timestamp: new Date().toISOString()
          });

          // Also add to regular insights feed
          const displayContent = `${parsed.connection}${parsed.evidence ? `\n\n📄 Evidence: ${parsed.evidence}` : ''}${parsed.hypothesis ? `\n\n💡 Hypothesis: ${parsed.hypothesis}` : ''}`;

          insights.addInsight({
            type: item.type,
            tick: item.tick,
            cell: item.cell,
            cellLabel: item.cellLabel,
            layer: item.layer,
            agentName: item.agentName,
            content: displayContent,
            metadata: {
              ...item.metadata,
              discoveryId: discovery.id,
              novelty: parsed.novelty,
              source: parsed.source,
              hasEvidence: !!parsed.evidence
            }
          });
        } else {
          // Fallback: use raw response as insight
          insights.addInsight({
            type: item.type,
            tick: item.tick,
            cell: item.cell,
            cellLabel: item.cellLabel,
            layer: item.layer,
            agentName: item.agentName,
            content: rawResponse.slice(0, 500),
            metadata: item.metadata || {}
          });
        }
      }
    }
  } catch (err) {
    console.error('[INSIGHT-GEN] Generation failed:', err.message);
  }

  isProcessing = false;
}

/**
 * Queue a CELL_INSIGHT when agent arrives on active cell
 */
function queueCellInsight({ tick, cell, cellLabel, layer, agentName, packName }) {
  console.log(`[INSIGHT-GEN] Queueing CELL_INSIGHT: agent=${agentName}, cell=${cell}`);

  const briefing = getResearchBriefing(cell);
  let prompt;

  if (briefing && briefing.articles && briefing.articles.length > 0) {
    const researchSummary = briefing.articles.map(a =>
      `- "${a.title}" (${a.source}, ${a.date}): ${a.summary}`
    ).join('\n');

    prompt = `You are a research agent on cell "${cellLabel}" in ${packName}. Today's real research includes:

${researchSummary}

Generate a specific 2-3 sentence insight that connects this real research to the broader domain. Reference the actual paper or finding.`;
  } else {
    prompt = `You are a research agent exploring "${cellLabel}" in ${packName}. Generate one specific, concrete research observation in 2-3 sentences. Be precise — cite real concepts, mechanisms, data patterns. No generalities.`;
  }

  pendingQueue.push({
    type: 'CELL_INSIGHT',
    tick, cell, cellLabel, layer, agentName, prompt,
    metadata: { packName, hasResearchBriefing: !!briefing }
  });

  processQueue(tick);
}

/**
 * Queue a BOND_INSIGHT when two agents meet — searches for real cross-domain connections
 */
function queueBondInsight({ tick, cell, cellLabel, layer, agent1Name, agent2Name, agent1Cell, agent2Cell, agent1Label, agent2Label, packName }) {
  console.log(`[DISCOVERY] Queueing BOND_INSIGHT: ${agent1Label} × ${agent2Label}`);

  const prompt = `Two research agents have met on cell "${cellLabel}". Agent A specializes in "${agent1Label}" and Agent B specializes in "${agent2Label}" in the domain of ${packName}.

Search for real research that connects these two areas. Look for:
- Papers in one field that cite concepts from the other
- Shared biological/chemical/physical mechanisms
- Cases where a breakthrough in one area could solve a problem in the other
- Researchers who work at the intersection

Return a JSON object:
{
  "connection": "2-3 sentences describing the specific cross-domain link you found",
  "evidence": "The real paper, study, or finding that supports this connection",
  "source": "Journal/publication name and approximate date",
  "novelty": "high/medium/low — how likely is it that specialists in both fields already know this?",
  "hypothesis": "One sentence: what should be tested next based on this connection?"
}

Only return the JSON object, nothing else.`;

  pendingQueue.push({
    type: 'BOND_INSIGHT',
    tick, cell, cellLabel, layer,
    agentName: `${agent1Name}, ${agent2Name}`,
    prompt,
    metadata: {
      packName,
      agent1Label, agent2Label,
      agent1Name, agent2Name,
      agents: [agent1Name, agent2Name]
    }
  });

  processQueue(tick);
}

/**
 * Queue a DISCOVERY when cross-layer bond forms — highest priority search
 */
function queueDiscovery({ tick, cell, cellLabel, layer, agent1Name, agent2Name, agent1Layer, agent2Layer, agent1Label, agent2Label, packName }) {
  console.log(`[DISCOVERY] Queueing CROSS-LAYER DISCOVERY: ${agent1Label} (L${agent1Layer}) × ${agent2Label} (L${agent2Layer})`);

  // Identify data vs hypothesis layer
  let dataLabel, hypothesisLabel;
  if (agent1Layer === 0) {
    dataLabel = agent1Label;
    hypothesisLabel = agent2Label;
  } else if (agent2Layer === 0) {
    dataLabel = agent2Label;
    hypothesisLabel = agent1Label;
  } else {
    dataLabel = agent1Label;
    hypothesisLabel = agent2Label;
  }

  const prompt = `CROSS-LAYER DISCOVERY: A data-layer agent ("${dataLabel}") and a hypothesis-layer agent ("${hypothesisLabel}") have connected in ${packName}. This is a rare intersection between hard data and frontier thinking.

Search extensively for undiscovered connections. Look for:
- Data from "${dataLabel}" that could validate or invalidate hypotheses in "${hypothesisLabel}"
- Theoretical frameworks in "${hypothesisLabel}" that explain patterns in "${dataLabel}"
- Cases like Don Swanson's fish oil/Raynaud's discovery — where two literatures never cited each other but are connected

Return a JSON object:
{
  "connection": "2-3 sentences describing the specific cross-layer connection you found",
  "evidence": "The real paper, study, or data that supports this connection",
  "source": "Journal/publication name and approximate date",
  "novelty": "high/medium/low — is this a known connection or potentially undiscovered?",
  "hypothesis": "One testable hypothesis that emerges from this connection"
}

Only return the JSON object, nothing else.`;

  pendingQueue.push({
    type: 'DISCOVERY',
    tick, cell, cellLabel, layer,
    agentName: `${agent1Name}, ${agent2Name}`,
    prompt,
    metadata: {
      packName,
      agent1Label, agent2Label,
      agent1Name, agent2Name,
      agent1Layer, agent2Layer,
      agents: [agent1Name, agent2Name],
      crossLayer: true
    }
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

/**
 * Get discoveries
 */
function getDiscoveries() {
  return loadDiscoveries();
}

module.exports = {
  queueCellInsight,
  queueBondInsight,
  queueDiscovery,
  getQueueStatus,
  clearQueue,
  processQueue,
  getDiscoveries
};
