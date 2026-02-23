/**
 * CLASHD-27 Researcher Module
 * Makes agents do real research using the Anthropic API with web search.
 * Three functions: investigateCell, investigateBond, investigateDiscovery
 */

const fs = require('fs');
const path = require('path');
const { fetchPapersForDomains, verifyAbcChainSources, formatPaperContext } = require('./semantic-scholar');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const FINDINGS_FILE = path.join(__dirname, '..', 'data', 'findings.json');

const METRICS_FILE = path.join(__dirname, '..', 'data', 'metrics.json');

// --- Circuit breaker for Anthropic credit exhaustion ---
const CIRCUIT_BREAKER_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
let circuitBreakerTripped = 0; // timestamp when tripped, 0 = not tripped
let circuitBreakerWarned = 0;  // tick number of last warning (one warning per tick)

function isCircuitOpen() {
  if (!circuitBreakerTripped) return false;
  if (Date.now() - circuitBreakerTripped >= CIRCUIT_BREAKER_DURATION_MS) {
    console.log('[CIRCUIT-BREAKER] 6h cooldown elapsed — retrying API calls');
    circuitBreakerTripped = 0;
    circuitBreakerWarned = 0;
    return false;
  }
  return true;
}

function tripCircuitBreaker() {
  circuitBreakerTripped = Date.now();
  const resumeAt = new Date(circuitBreakerTripped + CIRCUIT_BREAKER_DURATION_MS).toISOString();
  console.log(`[CIRCUIT-BREAKER] Anthropic credits exhausted — pausing API calls until ${resumeAt}`);
}

function circuitBreakerWarn(tickNum) {
  if (circuitBreakerWarned === tickNum) return; // already warned this tick
  circuitBreakerWarned = tickNum;
  const resumeMs = CIRCUIT_BREAKER_DURATION_MS - (Date.now() - circuitBreakerTripped);
  const resumeMin = Math.ceil(resumeMs / 60000);
  console.log(`[CIRCUIT-BREAKER] API calls paused — resumes in ${resumeMin} min`);
}

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
  if (isCircuitOpen()) return null;
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
      if (data.error.message && data.error.message.includes('credit balance is too low')) {
        tripCircuitBreaker();
      }
      return null;
    }

    // Log response structure for debugging
    const blockTypes = (data.content || []).map(b => b.type);
    console.log(`[RESEARCHER] Response: stop=${data.stop_reason}, blocks=[${blockTypes.join(', ')}]`);

    // Track cost
    trackApiCall();

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
  if (isCircuitOpen()) return null;
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
      if (data.error.message && data.error.message.includes('credit balance is too low')) {
        tripCircuitBreaker();
      }
      return null;
    }

    // Track cost
    trackApiCall();

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
 * RED FLAG FILTERS — check for structural problems before assigning verdict
 */
function checkRedFlags(packet) {
  const flags = [];

  // Flag 1: Unsupported connector - any claim in abc_chain with evidence_strength="weak" or no source
  for (const link of packet.abc_chain || []) {
    if (!link.source || link.source === '' || link.evidence_strength === 'weak') {
      flags.push(`UNSUPPORTED_LINK: "${link.claim}" has no strong source`);
    }
  }

  // Flag 2: Bridge not labeled correctly
  if (packet.bridge && packet.bridge.status === 'speculative' && !packet.bridge.required_evidence) {
    flags.push('SPECULATIVE_BRIDGE_NO_EVIDENCE_PATH');
  }

  // Flag 3: No kill test
  if (!packet.kill_test || packet.kill_test.length < 20) {
    flags.push('NO_KILL_TEST');
  }

  // Flag 4: Hypothesis not falsifiable (too vague)
  if (packet.hypothesis && (!packet.hypothesis.includes('associated with') && !packet.hypothesis.includes('correlat') && !packet.hypothesis.includes('predict') && !packet.hypothesis.includes('increas') && !packet.hypothesis.includes('decreas') && !packet.hypothesis.includes('reduc'))) {
    flags.push('HYPOTHESIS_NOT_FALSIFIABLE');
  }

  // Flag 5: No limiting sources
  if (!packet.limiting_sources || packet.limiting_sources.length === 0) {
    flags.push('NO_LIMITING_SOURCES');
  }

  // Flag 6: Clinical impact without threshold
  if (packet.impact === 'high' && (!packet.clinical_relevance || packet.clinical_relevance.length < 20)) {
    flags.push('HIGH_IMPACT_NO_THRESHOLD');
  }

  return flags;
}

/**
 * SPECULATION INDEX — count inferential leaps in the bridge
 */
function speculationIndex(packet) {
  let leaps = 0;

  // Count abc_chain links with weak or no evidence
  for (const link of packet.abc_chain || []) {
    if (link.evidence_strength !== 'strong') leaps++;
  }

  // Bridge itself is always 1 leap if untested
  if (packet.bridge && packet.bridge.status !== 'confirmed') leaps++;

  // Connector claims in hypothesis without direct source
  const chainSources = (packet.abc_chain || []).map(l => l.source || '').join(' ');
  const hypWords = (packet.hypothesis || '').split(/\s+/);
  const technicalTerms = hypWords.filter(w => /^[A-Z]{2,}[0-9]*$/.test(w) || /^[a-z]+[A-Z]/.test(w));
  for (const term of technicalTerms) {
    if (!chainSources.includes(term)) leaps++;
  }

  return {
    leaps,
    penalty: leaps <= 1 ? 0 : leaps === 2 ? -3 : leaps === 3 ? -6 : -10,
    autoDowngrade: leaps > 3
  };
}

/**
 * SCORING RUBRIC — structured 0-100 scoring
 */
function scoreGapPacket(packet, specIndex) {
  const scores = {};

  // I. Structural Rigor (0-20)
  let structural = 0;
  if (packet.hypothesis && packet.hypothesis.length > 30) structural += 4;
  if (packet.abc_chain && packet.abc_chain.length >= 2) structural += 4;
  if (packet.supporting_sources && packet.supporting_sources.length >= 2) structural += 3;
  if (packet.limiting_sources && packet.limiting_sources.length >= 1) structural += 3;
  if (packet.kill_test && packet.kill_test.length > 20) structural += 3;
  if (packet.cheapest_validation && packet.cheapest_validation.method) structural += 3;
  scores.structural = structural;

  // II. Evidence Quality (0-20)
  let evidence = 0;
  const strongLinks = (packet.abc_chain || []).filter(l => l.evidence_strength === 'strong').length;
  const moderateLinks = (packet.abc_chain || []).filter(l => l.evidence_strength === 'moderate').length;
  evidence += strongLinks * 6;
  evidence += moderateLinks * 3;
  if (packet.supporting_sources && packet.supporting_sources.length >= 3) evidence += 4;
  if (packet.limiting_sources && packet.limiting_sources.length >= 2) evidence += 2;
  // S2 DOI verification bonus: +2 per verified source (max +4)
  const verifiedLinks = (packet.abc_chain || []).filter(l => l.doi_verified).length;
  evidence += Math.min(4, verifiedLinks * 2);
  scores.evidence = Math.min(20, evidence);

  // III. Bridge Strength (0-20)
  let bridge = 0;
  if (packet.bridge) {
    if (packet.bridge.status === 'confirmed') bridge = 16;
    else if (packet.bridge.status === 'preliminary') bridge = 10;
    else if (packet.bridge.status === 'untested') bridge = 6;
    else bridge = 2; // speculative
    if (packet.bridge.required_evidence && packet.bridge.required_evidence.length > 20) bridge += 4;
  }
  scores.bridge = Math.min(20, bridge);

  // IV. Testability (0-15)
  let testability = 0;
  if (packet.cheapest_validation) {
    if (packet.cheapest_validation.method) testability += 5;
    if (packet.cheapest_validation.required_data && packet.cheapest_validation.required_data.length > 0) testability += 4;
    if (packet.cheapest_validation.statistical_approach) testability += 3;
    if (packet.cheapest_validation.estimated_time) testability += 3;
  }
  scores.testability = testability;

  // V. Clinical Relevance (0-15)
  let clinical = 0;
  if (packet.clinical_relevance && packet.clinical_relevance.length > 30) clinical += 8;
  if (packet.impact === 'high') clinical += 4;
  if (packet.feasibility === 'high') clinical += 3;
  scores.clinical = clinical;

  // VI. Novelty Calibration (0-10)
  let novelty = 0;
  if (packet.bridge && packet.bridge.status === 'untested') novelty += 5;
  if (packet.limiting_sources && packet.limiting_sources.length >= 1) novelty += 3;
  if (packet.abc_chain && packet.abc_chain.every(l => l.evidence_strength === 'strong')) novelty += 2;
  scores.novelty = novelty;

  // Apply speculation penalty
  const rawTotal = scores.structural + scores.evidence + scores.bridge + scores.testability + scores.clinical + scores.novelty;
  scores.speculation_penalty = specIndex.penalty;
  scores.total = Math.max(0, rawTotal + specIndex.penalty);

  return scores;
}

/**
 * VERDICT LOGIC — replaces old getGapVerdict
 */
function determineVerdict(scores, redFlags, specIndex) {
  // Hard stops
  if (redFlags.length > 0) {
    return { verdict: 'NEEDS WORK', reason: `Red flags: ${redFlags.join(', ')}` };
  }
  if (specIndex.autoDowngrade) {
    return { verdict: 'NEEDS WORK', reason: `Speculation index too high: ${specIndex.leaps} leaps` };
  }

  // MAX ONE INFERENTIAL LEAP rule: >1 leap caps verdict at NEEDS WORK
  if (specIndex.leaps > 1) {
    console.log(`[SPECULATION] hard-cap applied: ${specIndex.leaps} leaps > 1, verdict forced to NEEDS WORK`);
    return { verdict: 'NEEDS WORK', reason: `Speculation hard-cap: ${specIndex.leaps} leaps (max 1 allowed for HIGH-VALUE)` };
  }

  // Score thresholds
  if (scores.total >= 75 && scores.bridge >= 12) {
    return { verdict: 'HIGH-VALUE GAP', reason: `Score ${scores.total}/100, bridge ${scores.bridge}/20` };
  }
  if (scores.total >= 50) {
    return { verdict: 'CONFIRMED DIRECTION', reason: `Score ${scores.total}/100` };
  }
  return { verdict: 'LOW PRIORITY', reason: `Score ${scores.total}/100` };
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

  // ── Semantic Scholar pre-fetch ──
  let paperContext = null;
  let paperContextStr = '';
  try {
    paperContext = await fetchPapersForDomains(layer0Cell, layer2Cell, dataKeywords, hypothesisKeywords);
    paperContextStr = formatPaperContext(paperContext);
    if (paperContextStr) {
      console.log(`[S2] Pre-fetched ${paperContext.total_papers} papers for ${layer0Cell} × ${layer2Cell}`);
    }
  } catch (e) {
    console.error(`[S2] Pre-fetch failed (non-fatal): ${e.message}`);
  }

  const systemPrompt = `You are a cross-domain research analyst. You find connections between separate research domains by searching real papers. You are STRICT: every claim must be sourced. You never speculate beyond what evidence supports. If a connection has no direct evidence, you label it as UNKNOWN, not as a finding.

HARD RULES:
1. MAX ONE INFERENTIAL LEAP: Your A-B-C chain may contain at most ONE link where evidence_strength is not 'strong'. If you cannot find strong evidence for at least 2 of the links, do NOT produce a gap packet — return {"no_gap": true, "reason": "insufficient evidence for cross-domain bridge"} instead.
2. CONFOUNDER AWARENESS: You MUST identify at least 2 potential confounders that could explain the observed connection without the proposed mechanism. Add these as a 'confounders' array in your JSON.
3. EFFECT SIZE: You MUST estimate the expected effect size. Add 'expected_effect_size' to your JSON with: metric (e.g. 'hazard ratio', 'odds ratio', 'correlation coefficient'), estimate (number), basis (which source informs this estimate).
4. STATISTICAL TEST: In cheapest_validation, you MUST specify the exact statistical test (e.g. 'logistic regression adjusted for age and sex', 'Cox proportional hazards', 'Fisher exact test'), required sample size estimate, and expected power.
5. NO DECORATIVE CONNECTORS: Do NOT mention genes, pathways, variants, or compounds in the hypothesis unless they appear in at least ONE of your abc_chain sources with evidence_strength 'strong'. If a connector has only weak/indirect evidence, it goes in 'future_investigation' NOT in the hypothesis.
6. BRIDGE JUSTIFICATION: For the bridge claim, you must cite at least one source that provides indirect evidence for the connection, or explicitly state 'no supporting evidence found' and set bridge status to 'speculative'.`;

  const meetingPoint = cellLabel || '';

  const userPrompt = `Three research domains intersect:
Domain A: ${layer0Cell} (keywords: [${(dataKeywords || []).join(', ')}])
Domain B: ${layer2Cell} (keywords: [${(hypothesisKeywords || []).join(', ')}])
Meeting point: ${meetingPoint}
Find connections involving at least 2 of these 3 domains.
Pack: ${packName}
${priorClause}
${paperContextStr ? `\n--- REAL PAPERS FROM SEMANTIC SCHOLAR (use these as primary sources) ---\n${paperContextStr}\n--- END PAPERS ---\nPrioritize citing the papers above. Use their DOIs when available. You may also search for additional papers.\n` : ''}
Search for real papers connecting these domains. If you cannot find strong evidence for at least 2 links in the A-B-C chain, return: {"no_gap": true, "reason": "your explanation"} instead.

Otherwise produce a GAP PACKET in this exact JSON format:

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
    "required_evidence": "What data would confirm this bridge exists",
    "source": "indirect evidence source, or 'no supporting evidence found'"
  },

  "supporting_sources": [
    "Author et al., Journal Year — one line summary of relevant finding (max 3)"
  ],

  "limiting_sources": [
    "Author et al., Journal Year — why this might not work OR confounding factor (max 3)"
  ],

  "confounders": [
    "Age is a confounder because both X and Y increase with age",
    "Treatment dose could independently explain both outcomes"
  ],

  "expected_effect_size": {
    "metric": "hazard ratio|odds ratio|correlation coefficient|risk difference",
    "estimate": 0.0,
    "basis": "Based on Author et al. finding X for similar association"
  },

  "kill_test": "Specific result that would disprove this hypothesis. Start with: 'The hypothesis is falsified if...'",

  "cheapest_validation": {
    "method": "Retrospective cohort / meta-analysis / bioinformatics — no wet lab",
    "required_data": ["what datasets are needed"],
    "statistical_approach": "exact test name, e.g. Cox proportional hazards adjusted for age, sex, stage",
    "sample_size_estimate": "N needed for 80% power",
    "estimated_time": "days/weeks"
  },

  "clinical_relevance": "What must be true for this to matter: minimum effect size, actionable intervention, or changed clinical decision",

  "future_investigation": ["items removed from hypothesis due to insufficient evidence"],

  "no_gap": false,
  "impact": "high|medium|low",
  "feasibility": "high|medium|low",
  "novelty": "high|medium|low"
}

RULES:
- Every claim in abc_chain MUST have a real source found via search. No source = do not include the claim.
- The bridge must be labeled 'untested' or 'speculative' unless you find direct evidence. Cite at least one indirect source or state 'no supporting evidence found'.
- limiting_sources must contain at least 1 confounding factor.
- confounders must contain at least 2 potential confounders.
- kill_test must be specific and measurable, not vague.
- Do NOT mention genes, pathways, variants, or compounds in the hypothesis unless they appear in at least one abc_chain source with evidence_strength 'strong'. Move weakly-evidenced connectors to future_investigation.
- If you cannot fill all fields with real evidence, set impact to 'low'.
- If you cannot find strong evidence for at least 2 of the abc_chain links, return {"no_gap": true, "reason": "..."} instead.

Return ONLY valid JSON. No markdown, no explanation.`;

  // Use system+user prompt format via the proxy
  const rawText = await callWithSystemPrompt(systemPrompt, userPrompt, 2500);
  const parsed = parseJSON(rawText);

  if (!parsed) {
    console.log(`[RESEARCHER] Discovery investigation returned no parseable result`);
    return null;
  }

  // Handle no_gap response — the model correctly rejected weak evidence
  if (parsed.no_gap === true) {
    console.log(`[RESEARCH] NO GAP: ${layer0Cell} × ${layer2Cell} — ${parsed.reason || 'insufficient evidence for bridge'}`);
    return { type: 'no_gap', reason: parsed.reason || 'insufficient evidence', layer0Cell, layer2Cell };
  }

  if (!parsed.hypothesis) {
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

  // Reproducibility check — detect duplicate hypotheses
  const existingFindings = readFindings();
  const reproCheck = checkReproducibility(parsed.hypothesis, existingFindings.findings || []);
  if (reproCheck.duplicate) {
    console.log(`[REPRODUCIBILITY] New hypothesis is ${reproCheck.similarity}% similar to ${reproCheck.similar_to} — DUPLICATE`);
  }

  // Validate gap packet
  const validation = validateGapPacket(parsed);

  // Build cleaned packet for scoring
  const cleanedPacket = {
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
    impact: parsed.impact || 'medium',
    feasibility: parsed.feasibility || 'medium'
  };

  // ── Semantic Scholar DOI verification ──
  let s2Metadata = null;
  try {
    const verifiedChain = await verifyAbcChainSources(cleanedPacket.abc_chain);
    const verifiedCount = verifiedChain.filter(l => l.doi_verified).length;
    const totalLinks = verifiedChain.length;
    cleanedPacket.abc_chain = verifiedChain;
    s2Metadata = {
      papers_prefetched: paperContext ? paperContext.total_papers : 0,
      sources_verified: verifiedCount,
      sources_total: totalLinks,
      verification_rate: totalLinks > 0 ? Math.round((verifiedCount / totalLinks) * 100) : 0,
      search_queries: paperContext ? paperContext.search_queries : []
    };
    console.log(`[S2] DOI verification: ${verifiedCount}/${totalLinks} sources verified (${s2Metadata.verification_rate}%)`);
  } catch (e) {
    console.error(`[S2] DOI verification failed (non-fatal): ${e.message}`);
  }

  // Run red flag checks
  const redFlags = checkRedFlags(cleanedPacket);

  // Compute speculation index
  const specIndex = speculationIndex(cleanedPacket);

  // Compute structured scores
  const scores = scoreGapPacket(cleanedPacket, specIndex);

  // Determine verdict using new logic
  let verdictResult;
  if (!validation.valid) {
    verdictResult = { verdict: 'NEEDS WORK', reason: `Incomplete packet: ${validation.missing.join(', ')}` };
  } else {
    verdictResult = determineVerdict(scores, redFlags, specIndex);
  }

  const verdict = verdictResult.verdict;

  // Determine type based on validation and reproducibility
  let type;
  if (reproCheck.duplicate) {
    type = 'duplicate';
  } else if (validation.valid) {
    type = 'discovery';
  } else {
    type = 'draft';
  }
  if (!validation.valid && type !== 'duplicate') {
    console.log(`[RESEARCH] DRAFT (incomplete gap packet) — missing: [${validation.missing.join(', ')}]`);
  }

  // Log scoring details
  const findingIdPreview = `find-${String(findingCounter + 1).padStart(4, '0')}`;
  console.log(`[SCORE] ${findingIdPreview} | S=${scores.structural} E=${scores.evidence} B=${scores.bridge} T=${scores.testability} C=${scores.clinical} N=${scores.novelty} spec=${scores.speculation_penalty} | Total=${scores.total}`);
  console.log(`[RED-FLAG] ${findingIdPreview} | ${redFlags.length} flags${redFlags.length > 0 ? ': ' + redFlags.map(f => f.split(':')[0]).join(', ') : ''} | ${redFlags.length === 0 ? 'PASS' : 'FAIL → ' + verdict}`);
  console.log(`[SPECULATION] ${findingIdPreview} | leaps=${specIndex.leaps}, penalty=${specIndex.penalty}`);
  console.log(`[VERDICT] ${findingIdPreview} | ${verdict} (${scores.total}/100${scores.bridge < 12 ? ', bridge ' + scores.bridge + '/20 < 12 threshold' : ''})`);

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
    abc_chain: cleanedPacket.abc_chain,
    bridge: cleanedPacket.bridge,
    supporting_sources: cleanedPacket.supporting_sources,
    limiting_sources: cleanedPacket.limiting_sources,
    kill_test: cleanedPacket.kill_test,
    cheapest_validation: cleanedPacket.cheapest_validation,
    clinical_relevance: cleanedPacket.clinical_relevance,
    confounders: cleanArr(parsed.confounders || []),
    expected_effect_size: parsed.expected_effect_size ? {
      metric: clean((parsed.expected_effect_size || {}).metric || ''),
      estimate: parsed.expected_effect_size.estimate || 0,
      basis: clean((parsed.expected_effect_size || {}).basis || '')
    } : null,
    future_investigation: cleanArr(parsed.future_investigation || []),
    feasibility: parsed.feasibility || 'medium',
    impact: parsed.impact || 'medium',
    novelty: parsed.novelty || 'medium',
    scores,
    red_flags: redFlags,
    speculation_index: specIndex,
    verdict: verdictResult,
    reproducibility: reproCheck.duplicate ? { similar_to: reproCheck.similar_to, similarity: reproCheck.similarity } : null,
    s2_metadata: s2Metadata,
    source: cleanedPacket.abc_chain.map(l => l.source).filter(Boolean).join('; '),
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

/**
 * Check if a new hypothesis is a duplicate of an existing one
 */
function checkReproducibility(newHypothesis, findings) {
  const discoveries = findings.filter(f => f.type === 'discovery' && f.hypothesis);
  for (const d of discoveries) {
    const newWords = new Set(newHypothesis.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const oldWords = new Set(d.hypothesis.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    const overlap = [...newWords].filter(w => oldWords.has(w)).length;
    const similarity = overlap / Math.max(newWords.size, oldWords.size);
    if (similarity > 0.5) {
      return { duplicate: true, similar_to: d.id, similarity: Math.round(similarity * 100) };
    }
  }
  return { duplicate: false };
}

/**
 * Track API call cost
 */
function trackApiCall() {
  try {
    let metrics = {};
    if (fs.existsSync(METRICS_FILE)) {
      metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    }

    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    // Reset daily counters if day changed
    if (metrics._cost_date !== todayKey) {
      metrics._cost_date = todayKey;
      metrics.api_calls_today = 0;
      metrics.estimated_cost_today = 0;
    }

    metrics.api_calls_total = (metrics.api_calls_total || 0) + 1;
    metrics.api_calls_today = (metrics.api_calls_today || 0) + 1;
    metrics.estimated_cost_total = Math.round(((metrics.estimated_cost_total || 0) + 0.02) * 100) / 100;
    metrics.estimated_cost_today = Math.round(((metrics.estimated_cost_today || 0) + 0.02) * 100) / 100;
    metrics.last_updated = now.toISOString();

    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpFile = METRICS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(metrics, null, 2));
    fs.renameSync(tmpFile, METRICS_FILE);

    // Cost warning
    if (metrics.estimated_cost_today > 5.00) {
      console.log(`[COST] WARNING $${metrics.estimated_cost_today.toFixed(2)} today — entering low-spend mode`);
    }
  } catch (e) {
    // Non-fatal — don't break research for metrics
  }
}

module.exports = {
  investigateCell,
  investigateBond,
  investigateDiscovery,
  investigateFollowUp,
  investigateVerification,
  readFindings,
  queueFollowUps,
  getNextFollowUp,
  checkRedFlags,
  speculationIndex,
  scoreGapPacket,
  determineVerdict,
  checkReproducibility,
  trackApiCall,
  isCircuitOpen,
  circuitBreakerWarn
};
