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
 * Call the API with web search enabled + system prompt
 */
async function callWithSystemPrompt(systemPrompt, userPrompt, maxTokens = 1500) {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unreadable');
      console.error(`[RESEARCHER] API HTTP error: ${response.status} — ${errBody.substring(0, 300)}`);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[RESEARCHER] API error: ${data.error.type} — ${data.error.message}`);
      return null;
    }

    const blockTypes = (data.content || []).map(b => b.type);
    console.log(`[RESEARCHER] Response: stop=${data.stop_reason}, blocks=[${blockTypes.join(', ')}]`);

    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') text += block.text;
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
 * Validate a gap packet before saving as discovery.
 * Returns { valid, missing[] }
 */
function validateGapPacket(parsed) {
  const missing = [];

  // abc_chain must have at least 2 links
  const chain = parsed.abc_chain || [];
  if (chain.length < 2) {
    missing.push('abc_chain (need 2+ links)');
  } else {
    // Every link must have a non-empty source
    for (let i = 0; i < chain.length; i++) {
      if (!chain[i].source || chain[i].source.trim() === '') {
        missing.push(`abc_chain[${i}].source`);
      }
    }
  }

  // kill_test must not be empty
  if (!parsed.kill_test || parsed.kill_test.trim() === '') {
    missing.push('kill_test');
  }

  // At least 1 limiting_source
  const limiting = parsed.limiting_sources || [];
  if (limiting.length === 0) {
    missing.push('limiting_sources (need 1+)');
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Determine verdict from gap packet structure
 */
function getGapVerdict(parsed) {
  const chain = parsed.abc_chain || [];
  const bridge = parsed.bridge || {};
  const killTest = (parsed.kill_test || '').trim();

  // Check if all abc_chain links have "strong" evidence
  const allStrong = chain.length >= 2 && chain.every(l => l.evidence_strength === 'strong');

  // Check bridge status
  const bridgeUntested = bridge.status === 'untested';
  const bridgeSpeculative = bridge.status === 'speculative';

  // Check kill_test specificity (must start with "The hypothesis is falsified if")
  const killTestSpecific = killTest.length > 30;

  // Any chain link is "weak"
  const anyWeak = chain.some(l => l.evidence_strength === 'weak');

  // No limiting sources or vague kill test
  const noLimiting = !parsed.limiting_sources || parsed.limiting_sources.length === 0;
  const vagueKillTest = killTest.length < 20;

  if (noLimiting || vagueKillTest) {
    return 'NEEDS WORK';
  }

  if (allStrong && bridgeUntested && killTestSpecific) {
    return 'HIGH-VALUE GAP';
  }

  if (anyWeak || bridgeSpeculative) {
    return 'CONFIRMED DIRECTION';
  }

  // Default: check total evidence quality
  if (chain.length >= 2 && killTestSpecific) {
    return 'HIGH-VALUE GAP';
  }

  return 'CONFIRMED DIRECTION';
}

/**
 * investigateDiscovery — Cross-layer bond: data meets hypothesis
 * Enforces PI-grade gap packet output format.
 */
async function investigateDiscovery({ tick, cell, cellLabel, agent1Name, agent2Name, layer0Cell, layer2Cell, packName, dataKeywords, hypothesisKeywords, priorSummary }) {
  console.log(`[RESEARCHER] DISCOVERY investigation: ${layer0Cell} (data) x ${layer2Cell} (hypothesis)`);

  const priorClause = priorSummary
    ? `\n\nIMPORTANT: Previous discoveries on this intersection found: "${priorSummary}". Find something NEW and DIFFERENT — a different mechanism, pathway, gene, or clinical angle not covered above.\n`
    : '';

  const systemPrompt = 'You are a cross-domain research analyst. You find connections between separate research domains by searching real papers. You are STRICT: every claim must be sourced. You never speculate beyond what evidence supports. If a connection has no direct evidence, you label it as UNKNOWN, not as a finding.';

  const userPrompt = `Two research domains meet:
Domain A: ${layer0Cell} (keywords: [${(dataKeywords || []).join(', ')}])
Domain B: ${layer2Cell} (keywords: [${(hypothesisKeywords || []).join(', ')}])
Pack: ${packName}
${priorClause}
Search for real papers connecting these domains. Then produce a GAP PACKET in this exact JSON format:

{
  "hypothesis": "One sentence, falsifiable. Must contain: population, exposure/variable, outcome. Must be testable with existing data.",

  "abc_chain": [
    {
      "link": "A → B",
      "claim": "what A causes/correlates with",
      "source": "Author et al., Journal Year — specific finding",
      "evidence_strength": "strong|moderate|weak"
    },
    {
      "link": "B → C",
      "claim": "what B leads to",
      "source": "Author et al., Journal Year — specific finding",
      "evidence_strength": "strong|moderate|weak"
    }
  ],

  "bridge": {
    "claim": "The unknown connection between the two chains",
    "status": "untested|preliminary|speculative",
    "required_evidence": "What data would confirm this bridge exists"
  },

  "supporting_sources": [
    "Author et al., Journal Year — one line summary of relevant finding (max 3)"
  ],

  "limiting_sources": [
    "Author et al., Journal Year — why this might not work OR confounding factor (max 3)"
  ],

  "kill_test": "Specific result that would disprove this hypothesis. Start with: 'The hypothesis is falsified if...'",

  "cheapest_validation": {
    "method": "Retrospective cohort / meta-analysis / bioinformatics — no wet lab",
    "required_data": ["what datasets are needed"],
    "statistical_approach": "what analysis to run",
    "estimated_time": "days/weeks"
  },

  "clinical_relevance": "What must be true for this to matter: minimum effect size, actionable intervention, or changed clinical decision",

  "impact": "high|medium|low",
  "feasibility": "high|medium|low",
  "novelty": "high|medium|low"
}

RULES:
- Every claim in abc_chain MUST have a real source found via search. No source = do not include the claim.
- The bridge must be labeled 'untested' or 'speculative' unless you find direct evidence.
- limiting_sources must contain at least 1 confounding factor.
- kill_test must be specific and measurable, not vague.
- Do NOT include connector claims (genes, pathways, compounds) in the hypothesis unless you found direct evidence linking them to BOTH domains.
- If you cannot fill all fields with real evidence, set impact to 'low'.

Return ONLY valid JSON. No markdown, no explanation.`;

  // Use system+user prompt format via the proxy
  const rawText = await callWithSystemPrompt(systemPrompt, userPrompt, 2500);
  const parsed = parseJSON(rawText);

  if (!parsed || !parsed.hypothesis) {
    console.log(`[RESEARCHER] Discovery investigation returned no parseable result`);
    return null;
  }

  // Strip citations from all text fields
  const clean = (v) => typeof v === 'string' ? stripCitations(v) : v;
  const cleanArr = (arr) => (arr || []).map(s => typeof s === 'string' ? stripCitations(s) : s);
  const cleanChain = (chain) => (chain || []).map(l => ({
    link: clean(l.link || ''),
    claim: clean(l.claim || ''),
    source: clean(l.source || ''),
    evidence_strength: l.evidence_strength || 'weak'
  }));

  // Validate gap packet
  const validation = validateGapPacket(parsed);
  const verdict = validation.valid ? getGapVerdict(parsed) : 'NEEDS WORK';

  // Determine type based on validation
  const type = validation.valid ? 'discovery' : 'draft';
  if (!validation.valid) {
    console.log(`[RESEARCH] DRAFT (incomplete gap packet) — missing: [${validation.missing.join(', ')}]`);
  }

  const finding = saveFinding({
    type,
    tick,
    agents: [agent1Name, agent2Name],
    cell,
    cells: [cell, cell],
    cellLabels: [layer0Cell, layer2Cell],
    pack: packName,
    discovery: clean(parsed.hypothesis),
    hypothesis: clean(parsed.hypothesis),
    abc_chain: cleanChain(parsed.abc_chain),
    bridge: {
      claim: clean((parsed.bridge || {}).claim || ''),
      status: (parsed.bridge || {}).status || 'speculative',
      required_evidence: clean((parsed.bridge || {}).required_evidence || '')
    },
    supporting_sources: cleanArr(parsed.supporting_sources).slice(0, 3),
    limiting_sources: cleanArr(parsed.limiting_sources).slice(0, 3),
    kill_test: clean(parsed.kill_test || ''),
    cheapest_validation: {
      method: clean((parsed.cheapest_validation || {}).method || ''),
      required_data: cleanArr((parsed.cheapest_validation || {}).required_data),
      statistical_approach: clean((parsed.cheapest_validation || {}).statistical_approach || ''),
      estimated_time: clean((parsed.cheapest_validation || {}).estimated_time || '')
    },
    clinical_relevance: clean(parsed.clinical_relevance || ''),
    feasibility: parsed.feasibility || 'medium',
    impact: parsed.impact || 'medium',
    novelty: parsed.novelty || 'medium',
    verdict,
    source: cleanChain(parsed.abc_chain).map(l => l.source).filter(Boolean).join('; '),
    keywords: [...(dataKeywords || []), ...(hypothesisKeywords || [])]
  });

  console.log(`[RESEARCHER] ${finding.id} | ${type.toUpperCase()} | ${layer0Cell} x ${layer2Cell} | verdict=${verdict} | impact=${parsed.impact} | feasibility=${parsed.feasibility} | novelty=${parsed.novelty}`);
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

// --- Follow-up Queue ---

const FOLLOWUPS_FILE = path.join(__dirname, '..', 'data', 'followups.json');
let followUpCounter = 0;

function initFollowUpCounter() {
  try {
    if (fs.existsSync(FOLLOWUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(FOLLOWUPS_FILE, 'utf8'));
      followUpCounter = (data.queue || []).length;
    }
  } catch (e) {
    followUpCounter = 0;
  }
}
initFollowUpCounter();

function readFollowUps() {
  try {
    if (fs.existsSync(FOLLOWUPS_FILE)) {
      return JSON.parse(fs.readFileSync(FOLLOWUPS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[RESEARCHER] Read followups failed:', e.message);
  }
  return { queue: [] };
}

function saveFollowUps(data) {
  const dir = path.dirname(FOLLOWUPS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FOLLOWUPS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Extract follow-up questions from a discovery and queue them
 */
function queueFollowUps(discovery) {
  const data = readFollowUps();
  const keywords = discovery.keywords || [];
  const questions = discovery.questions || [];
  const discoveryText = discovery.discovery || discovery.gap || '';

  // Extract specific terms: gene names (uppercase 2-6 chars), pathways, compounds
  const specificTerms = keywords.filter(k =>
    /^[A-Z0-9][-A-Z0-9]{1,10}$/.test(k) || k.includes('-') || k.includes(' ')
  );

  // Build questions from the discovery content
  const autoQuestions = [];
  if (specificTerms.length >= 2) {
    autoQuestions.push(`What is the current clinical evidence for ${specificTerms[0]} interaction with ${specificTerms[1]} in cancer treatment?`);
  }
  if (discovery.proposed_experiment) {
    autoQuestions.push(`What recent studies have attempted: ${discovery.proposed_experiment}?`);
  }
  // Add any explicit questions from the discovery
  for (const q of questions) {
    autoQuestions.push(q);
  }

  const queued = [];
  for (const question of autoQuestions.slice(0, 3)) {
    followUpCounter++;
    const fu = {
      id: `fu-${String(followUpCounter).padStart(3, '0')}`,
      source_finding: discovery.id,
      question,
      keywords: specificTerms.slice(0, 5),
      status: 'pending',
      created: new Date().toISOString()
    };
    data.queue.push(fu);
    queued.push(fu);
  }

  // Keep queue manageable
  if (data.queue.length > 200) {
    data.queue = data.queue.slice(-200);
  }

  saveFollowUps(data);
  return queued;
}

/**
 * Get the next pending follow-up from the queue
 */
function getNextFollowUp() {
  const data = readFollowUps();
  const pending = data.queue.find(fu => fu.status === 'pending');
  return pending || null;
}

/**
 * Mark a follow-up as completed
 */
function completeFollowUp(fuId) {
  const data = readFollowUps();
  const fu = data.queue.find(f => f.id === fuId);
  if (fu) {
    fu.status = 'completed';
    fu.completed = new Date().toISOString();
    saveFollowUps(data);
  }
}

/**
 * investigateFollowUp — Research a follow-up question from a prior discovery
 */
async function investigateFollowUp({ tick, agentName, cell, cellLabel, packName, followUp }) {
  console.log(`[RESEARCHER] FOLLOW-UP ${followUp.id} from ${followUp.source_finding}: ${followUp.question}`);

  const prompt = `You are a research agent following up on a prior discovery. Your task: investigate this specific question that emerged from earlier research.

Question: ${followUp.question}
Keywords: [${(followUp.keywords || []).join(', ')}]
Domain: ${packName}
Cell context: ${cellLabel}

Search the web for the latest evidence, papers, and clinical data relevant to this specific question. Find REAL papers, REAL clinical results, REAL data from the last 12 months.

Return JSON only, no markdown:
{
  "finding": "3-4 sentences answering the question with specific evidence. Names, numbers, institutions, mechanisms.",
  "source": "The actual paper title, journal, or news source",
  "date": "Publication date if found",
  "keywords": ["3-5 specific technical keywords from this finding"],
  "questions": ["2 new specific questions this raises"],
  "answer_quality": "definitive/partial/inconclusive"
}`;

  const rawText = await callWithSearch(prompt);
  const parsed = parseJSON(rawText);

  if (!parsed || !parsed.finding) {
    console.log(`[RESEARCHER] Follow-up investigation returned no parseable result`);
    return null;
  }

  const finding = saveFinding({
    type: 'follow-up',
    tick,
    agent: agentName,
    cell,
    cellLabel,
    pack: packName,
    source_finding: followUp.source_finding,
    followup_id: followUp.id,
    question: followUp.question,
    finding: stripCitations(parsed.finding),
    source: parsed.source || '',
    date: parsed.date || '',
    keywords: parsed.keywords || [],
    questions: parsed.questions || [],
    answer_quality: parsed.answer_quality || 'partial'
  });

  completeFollowUp(followUp.id);
  console.log(`[RESEARCHER] ${finding.id} | FOLLOW-UP | ${followUp.id} | quality=${parsed.answer_quality || 'partial'}`);
  return finding;
}

/**
 * investigateVerification — Verify a specific claim from a discovery
 */
async function investigateVerification({ tick, agentName, cell, cellLabel, packName, claim, discoveryId }) {
  console.log(`[RESEARCHER] VERIFY claim from ${discoveryId}: ${claim.substring(0, 80)}...`);

  const prompt = `Verify this specific claim from a research discovery:

"${claim}"

Domain: ${packName}
Context: ${cellLabel}

Search for: primary sources, clinical trials, contradicting evidence. Be thorough — check PubMed, clinical trial registries, and recent preprints.

Return JSON only, no markdown:
{
  "finding": "3-4 sentences describing what evidence you found for or against this claim. Be specific — names, numbers, dates.",
  "source": "Primary source with date (paper title, journal, year)",
  "date": "Publication date if found",
  "verified": true or false,
  "confidence": 0-100,
  "contradictions": "Any opposing evidence found, or 'none' if claim is well-supported",
  "next_question": "What should be investigated next based on this verification?",
  "keywords": ["3-5 specific technical keywords"]
}`;

  const rawText = await callWithSearch(prompt);
  const parsed = parseJSON(rawText);

  if (!parsed || !parsed.finding) {
    console.log(`[RESEARCHER] Verification returned no parseable result`);
    return null;
  }

  const finding = saveFinding({
    type: 'verification',
    tick,
    agent: agentName,
    cell,
    cellLabel,
    pack: packName,
    source_discovery: discoveryId,
    claim,
    finding: stripCitations(parsed.finding),
    source: parsed.source || '',
    date: parsed.date || '',
    verified: !!parsed.verified,
    confidence: parsed.confidence || 0,
    contradictions: stripCitations(parsed.contradictions || ''),
    next_question: parsed.next_question || '',
    keywords: parsed.keywords || []
  });

  console.log(`[RESEARCHER] ${finding.id} | VERIFY | ${discoveryId} | verified=${parsed.verified} confidence=${parsed.confidence}`);
  return finding;
}

module.exports = {
  investigateCell,
  investigateBond,
  investigateDiscovery,
  investigateFollowUp,
  investigateVerification,
  readFindings,
  queueFollowUps,
  getNextFollowUp
};
