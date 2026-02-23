/**
 * CLASHD-27 — Field Saturation Check
 * One API call per HIGH-VALUE GAP to detect if the "gap" is actually
 * a well-known research area reframed with different words.
 */

const fs = require('fs');
const path = require('path');

const API_URL = 'http://localhost:3027/api/weigh';
const MODEL = 'claude-sonnet-4-20250514';
const METRICS_FILE = path.join(__dirname, '..', 'data', 'metrics.json');

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
    console.error(`[SATURATION] JSON parse failed: ${e.message}`);
  }
  return null;
}

/**
 * Calculate field saturation score from API response fields.
 */
function calculateScore(parsed) {
  let score = 0;

  // Paper points
  const paperMap = { '0': 0, '1-10': 15, '10-50': 35, '50-200': 60, '200+': 85 };
  score += paperMap[parsed.paper_estimate_5y] || 0;

  // Trial points
  const trials = typeof parsed.trial_count === 'number' ? parsed.trial_count : 0;
  if (trials >= 20) score += 30;
  else if (trials >= 6) score += 20;
  else if (trials >= 1) score += 10;

  // Established field name
  if (parsed.established_field_name) score += 30;

  // Review articles
  const reviews = typeof parsed.review_articles === 'number' ? parsed.review_articles : 0;
  if (reviews > 3) score += 15;

  return Math.min(100, score);
}

/**
 * Check field saturation for a HIGH-VALUE GAP hypothesis.
 * Makes ONE Claude API call with web search.
 *
 * @param {string} hypothesis
 * @param {Array} abc_chain
 * @param {Object} bridge
 * @returns {Object|null} saturation result
 */
async function checkSaturation(hypothesis, abc_chain, bridge) {
  const domains = (abc_chain || []).map(l => l.claim || l.link || '').filter(Boolean).join(', ');
  const bridgeClaim = (bridge && bridge.claim) || '';

  const systemPrompt = 'You are a research field analyst. Given this hypothesis and supporting chain, determine if this is a KNOWN ACTIVE RESEARCH AREA or a TRUE GAP.';

  const userPrompt = `Hypothesis: ${hypothesis}
Bridge: ${bridgeClaim}
Domains: ${domains}

Search the web and estimate:
1. paper_estimate_5y: How many papers in the last 5 years directly address this intersection? Use categories: 0, 1-10, 10-50, 50-200, 200+
2. trial_count: How many active clinical trials on ClinicalTrials.gov relate to this specific intersection?
3. established_field_name: Does this intersection already have an established name as a research field? (e.g. 'precision oncology', 'pharmacogenomics', 'immunometabolism'). If yes, return the name. If no, return null.
4. review_articles: How many review/meta-analysis papers exist on this topic?

CRITICAL: If the intersection has an established field name, it is NOT a gap. It is existing research. If there are >50 papers in 5 years, the field is SATURATED. If there are >5 active trials, the topic is ACTIVELY STUDIED.

Return JSON only:
{
  "paper_estimate_5y": "0|1-10|10-50|50-200|200+",
  "trial_count": 0,
  "established_field_name": null,
  "review_articles": 0,
  "field_saturation_score": 0,
  "reasoning": "one sentence explaining your assessment"
}`;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      console.error(`[SATURATION] API HTTP error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data.error) {
      console.error(`[SATURATION] API error: ${data.error.type} — ${data.error.message}`);
      return null;
    }

    // Track cost
    trackCost();

    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') text += block.text;
      }
    }

    const parsed = parseJSON(text);
    if (!parsed) {
      console.error('[SATURATION] Failed to parse response');
      return null;
    }

    // Calculate our own score
    const calculatedScore = calculateScore(parsed);

    // API may also return a score — use the HIGHER (more conservative)
    const apiScore = typeof parsed.field_saturation_score === 'number' ? parsed.field_saturation_score : 0;
    const finalScore = Math.max(calculatedScore, apiScore);

    return {
      paper_estimate_5y: parsed.paper_estimate_5y || '0',
      trial_count: typeof parsed.trial_count === 'number' ? parsed.trial_count : 0,
      established_field_name: parsed.established_field_name || null,
      review_articles: typeof parsed.review_articles === 'number' ? parsed.review_articles : 0,
      field_saturation_score: finalScore,
      reasoning: stripCitations(parsed.reasoning || '')
    };
  } catch (err) {
    console.error(`[SATURATION] Check failed: ${err.message}`);
    return null;
  }
}

function trackCost() {
  try {
    let metrics = {};
    if (fs.existsSync(METRICS_FILE)) {
      metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    }
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
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
    const tmpFile = METRICS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(metrics, null, 2));
    fs.renameSync(tmpFile, METRICS_FILE);
  } catch (e) { /* non-fatal */ }
}

module.exports = { checkSaturation };
