/**
 * CLASHD-27 Researcher Module
 * Makes agents do real research using the Anthropic API with web search.
 * Three functions: investigateCell, investigateBond, investigateDiscovery
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const FINDINGS_FILE = path.join(__dirname, '..', 'data', 'findings.json');

let findingCounter = 0;

// Load finding counter from existing file
function initCounter() {
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FINDINGS_FILE, 'utf8'));
      findingCounter = (data.findings || []).length;
    }
  } catch (e) {
    findingCounter = 0;
  }
}
initCounter();

/**
 * Call the API with web search enabled
 */
async function callWithSearch(prompt, maxTokens = 1000) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unreadable');
      console.error(`[RESEARCHER] API HTTP error: ${response.status} — ${errBody.substring(0, 300)}`);
      return null;
    }

    const data = await response.json();

    // Check for API-level errors (proxy forwards Anthropic errors as 200)
    if (data.error) {
      console.error(`[RESEARCHER] API error: ${data.error.type} — ${data.error.message}`);
      return null;
    }

    // Log response structure for debugging
    const blockTypes = (data.content || []).map(b => b.type);
    console.log(`[RESEARCHER] Response: stop=${data.stop_reason}, blocks=[${blockTypes.join(', ')}]`);

    // Extract text from response (may have multiple blocks after search)
    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }
    }

    if (!text.trim()) {
      console.log(`[RESEARCHER] No text blocks found in response. Stop reason: ${data.stop_reason}`);
      if (data.stop_reason === 'tool_use') {
        console.log(`[RESEARCHER] Response stopped for tool_use — needs continuation`);
      }
    }

    return text.trim() || null;
  } catch (err) {
    console.error(`[RESEARCHER] API call failed: ${err.message}`);
    return null;
  }
}

/**
 * Strip citation tags from API response text before parsing
 */
function stripCitations(text) {
  if (!text) return text;
  return text.replace(/<cite[^>]*>/g, '').replace(/<\/cite>/g, '');
}

/**
 * Parse JSON from API response text
 */
function parseJSON(text) {
  if (!text) return null;

  // Strip <cite> tags — they contain index="..." attributes that break JSON parsing
  text = stripCitations(text);

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e) { /* fall through */ }

  // Try to extract JSON from markdown code block
  try {
    const codeBlockMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) return JSON.parse(codeBlockMatch[1]);
  } catch (e) { /* fall through */ }

  // Try to find JSON object by matching balanced braces
  try {
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end !== -1) {
        return JSON.parse(text.substring(start, end + 1));
      }
    }
  } catch (e) {
    console.error(`[RESEARCHER] JSON parse failed: ${e.message}`);
    // Log first 200 chars for debugging
    console.error(`[RESEARCHER] Raw text preview: ${text.substring(0, 200)}`);
  }

  return null;
}

/**
 * Save a finding to findings.json
 */
function saveFinding(finding) {
  let data = { findings: [] };
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      data = JSON.parse(fs.readFileSync(FINDINGS_FILE, 'utf8'));
    }
  } catch (e) {
    data = { findings: [] };
  }

  findingCounter++;
  finding.id = `find-${String(findingCounter).padStart(4, '0')}`;
  finding.timestamp = new Date().toISOString();
  data.findings.push(finding);

  // Keep last 1000 findings
  if (data.findings.length > 1000) {
    data.findings = data.findings.slice(-1000);
  }

  const dir = path.dirname(FINDINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FINDINGS_FILE, JSON.stringify(data, null, 2));
  return finding;
}

/**
 * investigateCell — Agent searches for real recent research on a cell topic
 */
async function investigateCell({ tick, agentName, cell, cellLabel, packName }) {
  console.log(`[RESEARCHER] ${agentName} investigating cell ${cell} (${cellLabel})`);

  const prompt = `You are a research agent investigating "${cellLabel}" in the domain of ${packName}. Search the web for the most significant recent developments (last 30 days) in this specific area. Find REAL papers, REAL clinical results, REAL data. Return JSON only, no markdown:
{
  "finding": "3-4 sentences describing the most important recent development you found. Be specific — names, numbers, institutions, mechanisms.",
  "source": "The actual paper title, journal, or news source",
  "date": "Publication date if found",
  "keywords": ["3-5 specific technical keywords from this finding"],
  "questions": ["2 specific questions this raises for adjacent research areas"]
}`;

  const rawText = await callWithSearch(prompt);
  const parsed = parseJSON(rawText);

  if (!parsed || !parsed.finding) {
    console.log(`[RESEARCHER] Cell investigation returned no parseable result`);
    return null;
  }

  const finding = saveFinding({
    type: 'cell',
    tick,
    agent: agentName,
    cell,
    cellLabel,
    pack: packName,
    finding: stripCitations(parsed.finding),
    source: parsed.source || '',
    date: parsed.date || '',
    keywords: parsed.keywords || [],
    questions: parsed.questions || []
  });

  console.log(`[RESEARCHER] ${finding.id} | CELL | ${agentName} | ${cellLabel} | keywords=[${(parsed.keywords || []).join(', ')}]`);
  return finding;
}

/**
 * investigateBond — Two agents meet: search for REAL cross-domain connections
 */
async function investigateBond({ tick, cell, cellLabel, agent1Name, agent2Name, cell1Label, cell2Label, packName, cell1Keywords, cell2Keywords }) {
  console.log(`[RESEARCHER] BOND investigation: ${cell1Label} x ${cell2Label}`);

  const prompt = `Two researchers meet. Agent-1 carries keywords: [${(cell1Keywords || []).join(', ')}]. Agent-2 carries keywords: [${(cell2Keywords || []).join(', ')}].
Domain 1: ${cell1Label}. Domain 2: ${cell2Label}. Field: ${packName}.

Search the web and answer:
1. What real connection exists between these domains? (cite specific papers, mechanisms, evidence)
2. Has this specific combination been researched? (cite papers)
3. If not: what experiment would test it?
4. Score: novelty (0-100), feasibility (0-100), impact (0-100)
5. Verdict: HIGH-VALUE-GAP / CONFIRMED-DIRECTION / ALREADY-EXPLORED

Return JSON only, no markdown:
{
  "connection": "3-4 sentences describing the real connection. Names, mechanisms, evidence.",
  "source": "The actual paper or article",
  "exists": true or false,
  "existing_papers": [{"title": "...", "year": "..."}],
  "gap_confirmed": true or false,
  "proposed_experiment": "specific experiment to test this connection",
  "scores": {"novelty": 0, "feasibility": 0, "impact": 0},
  "verdict": "HIGH-VALUE-GAP or CONFIRMED-DIRECTION or ALREADY-EXPLORED"
}

Maximum 3 papers.`;

  const rawText = await callWithSearch(prompt, 1500);
  const parsed = parseJSON(rawText);

  if (!parsed || !parsed.connection) {
    console.log(`[RESEARCHER] Bond investigation returned no parseable result`);
    return null;
  }

  // Map scores to strength/novelty for backward compatibility
  const scores = parsed.scores || {};
  const noveltyVal = scores.novelty || 50;
  const novelty = noveltyVal >= 65 ? 'high' : noveltyVal >= 35 ? 'medium' : 'low';
  const strength = parsed.exists ? (noveltyVal < 35 ? 'weak' : 'moderate') : 'strong';

  const finding = saveFinding({
    type: 'bond',
    tick,
    agents: [agent1Name, agent2Name],
    cell,
    cells: [cell, cell],
    cellLabels: [cell1Label, cell2Label],
    pack: packName,
    connection: stripCitations(parsed.connection),
    source: parsed.source || '',
    strength,
    novelty,
    exists: !!parsed.exists,
    existing_papers: (parsed.existing_papers || []).slice(0, 3),
    gap_confirmed: parsed.gap_confirmed !== false,
    proposed_experiment: stripCitations(parsed.proposed_experiment || ''),
    scores: {
      novelty: scores.novelty || 0,
      feasibility: scores.feasibility || 0,
      impact: scores.impact || 0
    },
    verdict: parsed.verdict || 'CONFIRMED-DIRECTION',
    hypothesis: parsed.proposed_experiment || '',
    keywords: [...(cell1Keywords || []), ...(cell2Keywords || [])]
  });

  console.log(`[RESEARCHER] ${finding.id} | BOND | ${cell1Label} x ${cell2Label} | ${parsed.verdict} | N=${scores.novelty} F=${scores.feasibility} I=${scores.impact}`);
  return finding;
}

/**
 * investigateDiscovery — Cross-layer bond: data meets hypothesis
 */
async function investigateDiscovery({ tick, cell, cellLabel, agent1Name, agent2Name, layer0Cell, layer2Cell, packName, dataKeywords, hypothesisKeywords }) {
  console.log(`[RESEARCHER] DISCOVERY investigation: ${layer0Cell} (data) x ${layer2Cell} (hypothesis)`);

  const prompt = `A breakthrough moment: a data agent working on "${layer0Cell}" (keywords: [${(dataKeywords || []).join(', ')}]) has connected with a hypothesis agent working on "${layer2Cell}" (keywords: [${(hypothesisKeywords || []).join(', ')}]) in ${packName}.

Search the web for whether this data-hypothesis combination has been explored. Look for:
- Has anyone tested this combination before?
- What existing evidence supports or contradicts it?
- Which labs or researchers are closest to this intersection?

Return JSON only, no markdown:
{
  "discovery": "3-4 sentences. What new insight emerges from connecting this hard data with this frontier hypothesis? Be bold but grounded in what you found.",
  "existing_work": "What research already exists at this intersection? Who is working on it?",
  "gap": "What specific gap in knowledge does this connection reveal?",
  "source": "Most relevant paper or finding",
  "feasibility": "high/medium/low — could this be tested with current technology?",
  "impact": "high/medium/low — if confirmed, how significant would this be?",
  "proposed_experiment": "One specific experiment or study that could validate this"
}`;

  const rawText = await callWithSearch(prompt, 1500);
  const parsed = parseJSON(rawText);

  if (!parsed || !parsed.discovery) {
    console.log(`[RESEARCHER] Discovery investigation returned no parseable result`);
    return null;
  }

  const finding = saveFinding({
    type: 'discovery',
    tick,
    agents: [agent1Name, agent2Name],
    cell,
    cells: [cell, cell],
    cellLabels: [layer0Cell, layer2Cell],
    pack: packName,
    discovery: stripCitations(parsed.discovery),
    existing_work: stripCitations(parsed.existing_work || ''),
    gap: stripCitations(parsed.gap || ''),
    source: parsed.source || '',
    feasibility: parsed.feasibility || 'medium',
    impact: parsed.impact || 'medium',
    proposed_experiment: parsed.proposed_experiment || '',
    keywords: [...(dataKeywords || []), ...(hypothesisKeywords || [])]
  });

  console.log(`[RESEARCHER] ${finding.id} | DISCOVERY | ${layer0Cell} x ${layer2Cell} | feasibility=${parsed.feasibility} | impact=${parsed.impact}`);
  return finding;
}

/**
 * Read all findings
 */
function readFindings() {
  try {
    if (fs.existsSync(FINDINGS_FILE)) {
      return JSON.parse(fs.readFileSync(FINDINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[RESEARCHER] Read findings failed:', e.message);
  }
  return { findings: [] };
}

module.exports = {
  investigateCell,
  investigateBond,
  investigateDiscovery,
  readFindings
};
