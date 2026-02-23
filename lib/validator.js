/**
 * CLASHD-27 — Pre-Experiment Validation Module
 * After a discovery gets HIGH-VALUE GAP and survives GPT scrutiny,
 * this module answers: "Can someone actually test this hypothesis right now?"
 *
 * 3 sequential API calls with 180s pauses:
 *   1. datasetDiscovery — find public datasets
 *   2. trialCheck — search clinical trials
 *   3. contactDiscovery — find researchers & labs
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const VALIDATIONS_FILE = path.join(__dirname, '..', 'data', 'validations.json');
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour between validations

let lastValidationTime = 0;

// --- File I/O ---

function readValidations() {
  try {
    if (fs.existsSync(VALIDATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(VALIDATIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[VALIDATOR] Read failed:', e.message);
  }
  return { validations: [] };
}

function saveValidation(entry) {
  const data = readValidations();
  const idx = data.validations.findIndex(v => v.discovery_id === entry.discovery_id);
  if (idx !== -1) {
    data.validations[idx] = entry;
  } else {
    data.validations.push(entry);
  }
  if (data.validations.length > 200) {
    data.validations = data.validations.slice(-200);
  }
  const dir = path.dirname(VALIDATIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = VALIDATIONS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, VALIDATIONS_FILE);
  return entry;
}

// --- API Call ---

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
      console.error(`[VALIDATOR] API HTTP ${response.status}: ${errBody.substring(0, 300)}`);
      return null;
    }

    const data = await response.json();
    if (data.error) {
      console.error(`[VALIDATOR] API error: ${data.error.type} — ${data.error.message}`);
      return null;
    }

    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') text += block.text;
      }
    }
    return text.trim() || null;
  } catch (err) {
    console.error(`[VALIDATOR] API call failed: ${err.message}`);
    return null;
  }
}

// --- JSON Parsing ---

function stripCitations(text) {
  if (!text) return text;
  return text.replace(/<cite[^>]*>/g, '').replace(/<\/cite>/g, '');
}

function parseJSON(text) {
  if (!text) return null;
  text = stripCitations(text);

  try { return JSON.parse(text); } catch (e) { /* fall through */ }

  try {
    const m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (m) return JSON.parse(m[1]);
  } catch (e) { /* fall through */ }

  try {
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0, end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) return JSON.parse(text.substring(start, end + 1));
    }
  } catch (e) {
    console.error(`[VALIDATOR] JSON parse failed: ${e.message}`);
  }
  return null;
}

function clean(v) {
  return typeof v === 'string' ? stripCitations(v) : v;
}

// --- Call 1: Dataset Discovery ---

async function datasetDiscovery(hypothesis, cheapestValidation) {
  const requiredData = (cheapestValidation?.required_data || []).join(', ') || 'not specified';

  console.log(`[VALIDATOR] Call 1/3: Dataset discovery`);

  const systemPrompt = 'You are a biomedical data specialist. Search for existing publicly available datasets that could test this hypothesis. Be specific — name the dataset, its size, what it contains, and how to access it.';

  const userPrompt = `Hypothesis: ${hypothesis}
Required data: ${requiredData}

Search for:
1. Does TCGA have relevant data? Which project? (e.g. TCGA-HNSC)
2. Does GEO (Gene Expression Omnibus) have relevant datasets? Give accession numbers.
3. Does UK Biobank have relevant data?
4. Are there other public cohorts with this combination of data?
5. What is missing — what data would need to be generated?

Return ONLY valid JSON:
{
  "datasets_found": [
    {
      "name": "TCGA-HNSC",
      "source": "https://portal.gdc.cancer.gov",
      "contains": "what relevant data it has",
      "sample_size": "N=...",
      "has_microbiome": true/false,
      "has_sequencing": true/false,
      "has_outcomes": true/false,
      "access": "open/controlled/application"
    }
  ],
  "data_completeness": "complete|partial|insufficient",
  "missing_data": ["what datasets don't exist yet"],
  "feasibility": "immediate|needs_combination|not_feasible"
}`;

  const raw = await callWithSystemPrompt(systemPrompt, userPrompt, 2000);
  const parsed = parseJSON(raw);

  if (!parsed) {
    console.log('[VALIDATOR] Dataset discovery returned no parseable result');
    return { datasets_found: [], data_completeness: 'insufficient', missing_data: ['Unable to determine'], feasibility: 'not_feasible' };
  }

  return {
    datasets_found: (parsed.datasets_found || []).map(d => ({
      name: clean(d.name || ''),
      source: clean(d.source || ''),
      contains: clean(d.contains || ''),
      sample_size: clean(d.sample_size || ''),
      has_microbiome: !!d.has_microbiome,
      has_sequencing: !!d.has_sequencing,
      has_outcomes: !!d.has_outcomes,
      access: d.access || 'unknown'
    })),
    data_completeness: parsed.data_completeness || 'insufficient',
    missing_data: (parsed.missing_data || []).map(clean),
    feasibility: parsed.feasibility || 'not_feasible'
  };
}

// --- Call 2: Trial Check ---

async function trialCheck(hypothesis, cellLabels) {
  const domains = (cellLabels || []).join(', ');

  console.log(`[VALIDATOR] Call 2/3: Trial check`);

  const systemPrompt = 'You are a clinical trial researcher. Search ClinicalTrials.gov and WHO ICTRP for active or completed trials testing this or closely related hypotheses.';

  const userPrompt = `Hypothesis: ${hypothesis}
Domains: ${domains}

Search for:
1. Any active clinical trials testing this exact combination
2. Any completed trials with relevant results
3. Any planned/recruiting studies in adjacent space
4. Is anyone already working on this?

Return ONLY valid JSON:
{
  "active_trials": [
    {
      "id": "NCT...",
      "title": "...",
      "status": "recruiting|completed|planned",
      "relevance": "direct|adjacent|tangential",
      "sponsor": "...",
      "estimated_completion": "..."
    }
  ],
  "gap_status": "open|partially_explored|actively_studied",
  "competition_risk": "none|low|moderate|high"
}`;

  const raw = await callWithSystemPrompt(systemPrompt, userPrompt, 1500);
  const parsed = parseJSON(raw);

  if (!parsed) {
    console.log('[VALIDATOR] Trial check returned no parseable result');
    return { active_trials: [], gap_status: 'open', competition_risk: 'none' };
  }

  return {
    active_trials: (parsed.active_trials || []).map(t => ({
      id: clean(t.id || ''),
      title: clean(t.title || ''),
      status: t.status || 'unknown',
      relevance: t.relevance || 'tangential',
      sponsor: clean(t.sponsor || ''),
      estimated_completion: clean(t.estimated_completion || '')
    })),
    gap_status: parsed.gap_status || 'open',
    competition_risk: parsed.competition_risk || 'none'
  };
}

// --- Call 3: Contact Discovery ---

async function contactDiscovery(hypothesis, cellLabels, abcChain) {
  const chainSummary = (abcChain || []).map(l => `${l.link}: ${l.claim}`).join(' → ');

  console.log(`[VALIDATOR] Call 3/3: Contact discovery`);

  const systemPrompt = 'You are an academic network analyst. Find real researchers and labs who publish in both domains and could test this hypothesis.';

  const userPrompt = `Hypothesis: ${hypothesis}
Domain A: ${cellLabels[0] || 'unknown'}
Domain B: ${cellLabels[1] || 'unknown'}
A-B-C chain: ${chainSummary}

Search for:
1. Researchers who publish in BOTH domains (name, institution, recent paper)
2. Labs with the required infrastructure (sequencing + microbiome + clinical data)
3. Funding bodies that have funded related work
4. Conferences where both domains overlap

Return ONLY valid JSON:
{
  "cross_domain_researchers": [
    {
      "name": "Dr. ...",
      "institution": "...",
      "relevant_work": "their paper that spans both domains",
      "email_domain": "university.edu"
    }
  ],
  "capable_labs": [
    {
      "name": "...",
      "institution": "...",
      "capability": "what they can do"
    }
  ],
  "relevant_funding": ["NIH R01 in ...", "ERC grant on ..."],
  "conferences": ["AACR", "ASH"],
  "collaboration_readiness": "high|medium|low"
}`;

  const raw = await callWithSystemPrompt(systemPrompt, userPrompt, 1500);
  const parsed = parseJSON(raw);

  if (!parsed) {
    console.log('[VALIDATOR] Contact discovery returned no parseable result');
    return { cross_domain_researchers: [], capable_labs: [], relevant_funding: [], conferences: [], collaboration_readiness: 'low' };
  }

  return {
    cross_domain_researchers: (parsed.cross_domain_researchers || []).map(r => ({
      name: clean(r.name || ''),
      institution: clean(r.institution || ''),
      relevant_work: clean(r.relevant_work || ''),
      email_domain: clean(r.email_domain || '')
    })),
    capable_labs: (parsed.capable_labs || []).map(l => ({
      name: clean(l.name || ''),
      institution: clean(l.institution || ''),
      capability: clean(l.capability || '')
    })),
    relevant_funding: (parsed.relevant_funding || []).map(clean),
    conferences: (parsed.conferences || []).map(clean),
    collaboration_readiness: parsed.collaboration_readiness || 'low'
  };
}

// --- Main: validateGap ---

async function validateGap(discovery) {
  // Rate limit check
  const now = Date.now();
  if (now - lastValidationTime < RATE_LIMIT_MS) {
    const waitMin = Math.round((RATE_LIMIT_MS - (now - lastValidationTime)) / 60000);
    console.log(`[VALIDATOR] Rate limited — next validation in ${waitMin}min`);
    return null;
  }

  lastValidationTime = Date.now();
  const hypothesis = discovery.hypothesis || discovery.discovery || '';
  const cellLabels = discovery.cellLabels || [];

  console.log(`[VALIDATOR] Starting validation for ${discovery.id}: ${hypothesis.substring(0, 80)}...`);

  // Call 1: Dataset discovery
  const datasets = await datasetDiscovery(hypothesis, discovery.cheapest_validation);

  // 180s pause
  console.log('[VALIDATOR] Waiting 180s for rate limit...');
  await new Promise(r => setTimeout(r, 180000));

  // Call 2: Trial check
  const trials = await trialCheck(hypothesis, cellLabels);

  // 180s pause
  console.log('[VALIDATOR] Waiting 180s for rate limit...');
  await new Promise(r => setTimeout(r, 180000));

  // Call 3: Contact discovery
  const contacts = await contactDiscovery(hypothesis, cellLabels, discovery.abc_chain);

  // Determine overall feasibility
  let overallFeasibility = 'blocked';
  if (datasets.feasibility === 'immediate' && trials.gap_status === 'open') {
    overallFeasibility = 'ready_to_test';
  } else if (datasets.feasibility === 'needs_combination' || datasets.data_completeness === 'partial') {
    overallFeasibility = 'needs_data';
  } else if (datasets.data_completeness === 'complete') {
    overallFeasibility = trials.gap_status === 'actively_studied' ? 'needs_data' : 'ready_to_test';
  }

  // Build action summary
  const datasetNames = datasets.datasets_found.map(d => d.name).filter(Boolean).join(', ');
  const researcherNames = contacts.cross_domain_researchers.map(r => `${r.name} (${r.institution})`).slice(0, 3).join(', ');
  const trialCount = trials.active_trials.length;
  const labCount = contacts.capable_labs.length;

  let actionSummary = '';
  if (overallFeasibility === 'ready_to_test') {
    actionSummary = `This hypothesis can be tested immediately. Datasets available: ${datasetNames || 'see list'}. `;
    if (researcherNames) actionSummary += `Contact: ${researcherNames}. `;
    if (trialCount === 0) actionSummary += 'No competing trials found — the gap is open. ';
    actionSummary += `Recommended: start with a retrospective analysis using ${datasetNames.split(',')[0] || 'available cohort data'}.`;
  } else if (overallFeasibility === 'needs_data') {
    actionSummary = `Partial data exists (${datasetNames || 'limited'}), but combination of datasets is needed. `;
    const missing = datasets.missing_data.join(', ');
    if (missing) actionSummary += `Missing: ${missing}. `;
    if (researcherNames) actionSummary += `Researchers working in adjacent space: ${researcherNames}. `;
    actionSummary += `${labCount} capable lab(s) identified for collaboration.`;
  } else {
    actionSummary = 'Insufficient public data to test this hypothesis directly. ';
    const missing = datasets.missing_data.join(', ');
    if (missing) actionSummary += `Required: ${missing}. `;
    if (researcherNames) actionSummary += `Potential collaborators: ${researcherNames}.`;
  }

  const entry = {
    discovery_id: discovery.id,
    hypothesis,
    datasets,
    trials,
    contacts,
    overall_feasibility: overallFeasibility,
    action_summary: actionSummary,
    timestamp: new Date().toISOString()
  };

  saveValidation(entry);

  const dsCount = datasets.datasets_found.length;
  const ctCount = contacts.cross_domain_researchers.length;
  const feasLabel = overallFeasibility.toUpperCase().replace(/_/g, ' ');
  console.log(`[VALIDATOR] ${discovery.id} | datasets=${dsCount} | trials=${trialCount} | contacts=${ctCount} | ${feasLabel}`);

  return entry;
}

module.exports = {
  validateGap,
  readValidations,
  saveValidation
};
