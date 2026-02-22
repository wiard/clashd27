/**
 * CLASHD-27 Deep Dive Module
 * Takes a discovery and performs a 3-step evaluation:
 *   1. existenceCheck — has this been researched?
 *   2. actionability — what would it take to investigate?
 *   3. relevanceScore — scored from steps 1+2
 *
 * Results saved to data/deep-dives.json
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const DEEP_DIVES_FILE = path.join(__dirname, '..', 'data', 'deep-dives.json');

// --- Helpers ---

function readDeepDives() {
  try {
    if (fs.existsSync(DEEP_DIVES_FILE)) {
      return JSON.parse(fs.readFileSync(DEEP_DIVES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[DEEP-DIVE] Read failed:', e.message);
  }
  return { dives: [] };
}

function saveDeepDive(dive) {
  const data = readDeepDives();
  // Replace if same discovery_id exists, otherwise append
  const idx = data.dives.findIndex(d => d.discovery_id === dive.discovery_id);
  if (idx !== -1) {
    data.dives[idx] = dive;
  } else {
    data.dives.push(dive);
  }
  // Keep last 200
  if (data.dives.length > 200) {
    data.dives = data.dives.slice(-200);
  }
  const dir = path.dirname(DEEP_DIVES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DEEP_DIVES_FILE, JSON.stringify(data, null, 2));
  return dive;
}

async function callWithSearch(prompt, maxTokens = 1500) {
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
      console.error(`[DEEP-DIVE] API HTTP error: ${response.status} — ${errBody.substring(0, 300)}`);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[DEEP-DIVE] API error: ${data.error.type} — ${data.error.message}`);
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
    console.error(`[DEEP-DIVE] API call failed: ${err.message}`);
    return null;
  }
}

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
    console.error(`[DEEP-DIVE] JSON parse failed: ${e.message}`);
  }
  return null;
}

// --- Step 1: Existence Check ---

async function existenceCheck(discovery) {
  const domains = discovery.cellLabels || [];
  const domain1 = domains[0] || 'unknown';
  const domain2 = domains[1] || 'unknown';
  const purpose = discovery.discovery || discovery.gap || '';

  console.log(`[DEEP-DIVE] Step 1: Existence check for ${domain1} × ${domain2}`);

  const prompt = `Has the specific combination of "${domain1}" and "${domain2}" for the purpose described below been researched?

Purpose: ${purpose}

Search for papers that combine BOTH topics. Be thorough — check PubMed, Google Scholar, preprint servers.

Return JSON only, no markdown:
{
  "exists": true or false,
  "papers": [{"title": "...", "year": "...", "journal": "..."}],
  "gap_confirmed": true or false,
  "closest_work": "description of the nearest existing research to this exact combination"
}

Maximum 3 papers. If nothing combines both topics, set exists to false and describe the closest work.`;

  const raw = await callWithSearch(prompt);
  const parsed = parseJSON(raw);

  if (!parsed) {
    console.log(`[DEEP-DIVE] Existence check returned no parseable result`);
    return { exists: false, papers: [], gap_confirmed: true, closest_work: 'Unable to determine' };
  }

  return {
    exists: !!parsed.exists,
    papers: (parsed.papers || []).slice(0, 3).map(p => ({
      title: stripCitations(p.title || ''),
      year: p.year || '',
      journal: stripCitations(p.journal || '')
    })),
    gap_confirmed: parsed.gap_confirmed !== false,
    closest_work: stripCitations(parsed.closest_work || '')
  };
}

// --- Step 2: Actionability ---

async function actionability(discovery, existence) {
  const desc = discovery.discovery || discovery.gap || '';
  const gapInfo = existence.gap_confirmed
    ? `This research gap has been confirmed — no existing work directly combines these areas.`
    : `Some related work exists: ${existence.closest_work}`;

  console.log(`[DEEP-DIVE] Step 2: Actionability assessment`);

  const prompt = `Given this research gap: "${desc}"

${gapInfo}

What would it take to investigate this? Search for active researchers, labs, and available tools.

Return JSON only, no markdown:
{
  "proposed_experiment": "specific description of what experiment or study would test this",
  "estimated_cost": "low or medium or high",
  "required_expertise": ["field1", "field2"],
  "active_labs": [{"name": "...", "institution": "...", "relevance": "..."}],
  "timeline": "estimated months",
  "existing_tools": ["tool1", "tool2"]
}

Maximum 3 labs. Be specific about real institutions and researchers.`;

  // Wait 180s between API calls for rate limiting
  console.log(`[DEEP-DIVE] Waiting 180s for rate limit...`);
  await new Promise(r => setTimeout(r, 180000));

  const raw = await callWithSearch(prompt);
  const parsed = parseJSON(raw);

  if (!parsed) {
    console.log(`[DEEP-DIVE] Actionability check returned no parseable result`);
    return {
      proposed_experiment: '',
      estimated_cost: 'medium',
      required_expertise: [],
      active_labs: [],
      timeline: 'unknown',
      existing_tools: []
    };
  }

  return {
    proposed_experiment: stripCitations(parsed.proposed_experiment || ''),
    estimated_cost: parsed.estimated_cost || 'medium',
    required_expertise: parsed.required_expertise || [],
    active_labs: (parsed.active_labs || []).slice(0, 3).map(l => ({
      name: stripCitations(l.name || ''),
      institution: stripCitations(l.institution || ''),
      relevance: stripCitations(l.relevance || '')
    })),
    timeline: parsed.timeline || 'unknown',
    existing_tools: parsed.existing_tools || []
  };
}

// --- Step 3: Relevance Score ---

function relevanceScore(discovery, existence, action) {
  // novelty_score (0-100): based on existence check
  let novelty = 50;
  if (!existence.exists && existence.gap_confirmed) {
    novelty = 90;
  } else if (!existence.exists) {
    novelty = 70;
  } else if (existence.papers.length <= 1) {
    novelty = 55;
  } else {
    novelty = 25; // well-explored
  }

  // feasibility_score (0-100): based on cost, tools, labs
  let feasibility = 50;
  const costMap = { low: 85, medium: 55, high: 25 };
  feasibility = costMap[action.estimated_cost] || 50;
  if (action.active_labs.length >= 2) feasibility += 15;
  else if (action.active_labs.length === 1) feasibility += 8;
  if (action.existing_tools.length >= 2) feasibility += 10;
  feasibility = Math.min(100, Math.max(0, feasibility));

  // impact_score (0-100): based on discovery's own impact field + gap significance
  let impact = 50;
  if (discovery.impact === 'high') impact = 85;
  else if (discovery.impact === 'medium') impact = 55;
  else if (discovery.impact === 'low') impact = 25;
  if (existence.gap_confirmed) impact += 10;
  impact = Math.min(100, Math.max(0, impact));

  // momentum_score (0-100): are both fields growing?
  let momentum = 50;
  const recentPapers = existence.papers.filter(p => {
    const year = parseInt(p.year);
    return year >= 2023;
  });
  if (recentPapers.length >= 2) momentum = 80;
  else if (recentPapers.length === 1) momentum = 65;
  if (action.active_labs.length >= 2) momentum += 10;
  momentum = Math.min(100, Math.max(0, momentum));

  // TOTAL: weighted average
  const total = Math.round(
    novelty * 0.30 +
    feasibility * 0.25 +
    impact * 0.30 +
    momentum * 0.15
  );

  return {
    novelty: Math.round(novelty),
    feasibility: Math.round(feasibility),
    impact: Math.round(impact),
    momentum: Math.round(momentum),
    total
  };
}

// --- Verdict ---

function getVerdict(scores, existence) {
  if (existence.exists && existence.papers.length >= 3) {
    return 'ALREADY EXPLORED';
  }
  if (scores.feasibility < 35) {
    return 'LOW FEASIBILITY';
  }
  if (scores.total >= 65 && existence.gap_confirmed) {
    return 'HIGH-VALUE GAP';
  }
  return 'CONFIRMED DIRECTION';
}

// --- Main: deepDive ---

async function deepDive(discovery) {
  if (!discovery || !discovery.id) {
    console.error('[DEEP-DIVE] No discovery provided');
    return null;
  }

  console.log(`[DEEP-DIVE] Starting deep dive on ${discovery.id}`);
  const startTime = Date.now();

  // Step 1
  const existence = await existenceCheck(discovery);
  console.log(`[DEEP-DIVE] Existence: exists=${existence.exists}, gap_confirmed=${existence.gap_confirmed}, papers=${existence.papers.length}`);

  // Step 2 (includes 60s rate-limit wait)
  const action = await actionability(discovery, existence);
  console.log(`[DEEP-DIVE] Actionability: cost=${action.estimated_cost}, labs=${action.active_labs.length}, tools=${action.existing_tools.length}`);

  // Step 3
  const scores = relevanceScore(discovery, existence, action);
  const verdict = getVerdict(scores, existence);
  console.log(`[DEEP-DIVE] Scores: N=${scores.novelty} F=${scores.feasibility} I=${scores.impact} M=${scores.momentum} T=${scores.total} | ${verdict}`);

  const dive = {
    discovery_id: discovery.id,
    existence,
    actionability: action,
    scores,
    verdict,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime
  };

  saveDeepDive(dive);
  console.log(`[DEEP-DIVE] ${discovery.id} complete: ${verdict} (${scores.total}/100) in ${Math.round(dive.duration_ms / 1000)}s`);
  return dive;
}

module.exports = {
  deepDive,
  readDeepDives,
  saveDeepDive
};
