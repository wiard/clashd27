/**
 * CLASHD-27 — Independent Verification Module
 * Uses OpenAI GPT-4o to challenge discoveries found by Claude.
 * Adversarial review: tries to DISPROVE research gap claims.
 */

const fs = require('fs');
const path = require('path');

// Ensure secrets are loaded even when called standalone (e.g. doctor script)
if (!process.env.OPENAI_API_KEY) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });
}

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o';
const VERIFICATIONS_FILE = path.join(__dirname, '..', 'data', 'verifications.json');
const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes between verifications

let lastVerificationTime = 0;

// --- File I/O ---

function readVerifications() {
  try {
    if (fs.existsSync(VERIFICATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(VERIFICATIONS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[VERIFIER] Read failed:', e.message);
  }
  return { verifications: [] };
}

function saveVerification(entry) {
  const data = readVerifications();
  // Replace if same discovery_id exists, otherwise append
  const idx = data.verifications.findIndex(v => v.discovery_id === entry.discovery_id);
  if (idx !== -1) {
    data.verifications[idx] = entry;
  } else {
    data.verifications.push(entry);
  }
  // Keep last 200
  if (data.verifications.length > 200) {
    data.verifications = data.verifications.slice(-200);
  }
  const dir = path.dirname(VERIFICATIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VERIFICATIONS_FILE, JSON.stringify(data, null, 2));
  return entry;
}

// --- JSON Parsing ---

function parseJSON(text) {
  if (!text) return null;

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
    console.error(`[VERIFIER] JSON parse failed: ${e.message}`);
  }
  return null;
}

// --- OpenAI API Call ---

const RETRYABLE_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'];

function isRetryableNetworkError(err) {
  const code = err.cause?.code || err.code || '';
  const msg = err.message || '';
  return RETRYABLE_ERRORS.some(e => code.includes(e) || msg.includes(e))
    || msg.includes('socket hang up');
}

async function callOpenAI(systemPrompt, userPrompt, retries = 2) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[VERIFIER] OPENAI_API_KEY not set — skipping verification');
    return { error: 'missing_api_key', category: 'missing_api_key' };
  }

  const reqBody = JSON.stringify({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 2000,
    temperature: 0.3
  });

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      console.log(`[VERIFIER] OpenAI request attempt=${attempt + 1}/3`);
      const response = await fetch(OPENAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'clashd27-verifier/1.0'
        },
        body: reqBody,
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        const errBody = await response.text().catch(() => 'unreadable');
        console.error(`[VERIFIER] OpenAI auth error ${response.status}: ${errBody.substring(0, 200)}`);
        return { error: `auth_error_${response.status}`, category: 'auth', status: response.status };
      }

      if (response.status === 429 && retries > 0) {
        console.log(`[VERIFIER] Rate limited by OpenAI, retrying in 30s (${retries} retries left)`);
        await new Promise(r => setTimeout(r, 30000));
        return callOpenAI(systemPrompt, userPrompt, retries - 1);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => 'unreadable');
        console.error(`[VERIFIER] OpenAI HTTP ${response.status}: ${errBody.substring(0, 300)}`);
        return { error: `http_${response.status}`, category: 'http', status: response.status, detail: errBody.substring(0, 120) };
      }

      const data = await response.json();

      if (data.error) {
        console.error(`[VERIFIER] OpenAI error: ${data.error.message}`);
        return { error: 'api_error', category: 'api', detail: data.error.message };
      }

      return { content: data.choices?.[0]?.message?.content?.trim() || '' };
    } catch (err) {
      clearTimeout(timeout);

      if (err.name === 'AbortError') {
        console.error('[VERIFIER] OpenAI request timed out (60s)');
        return { error: 'timeout', category: 'timeout' }; // timeout is not retryable
      }

      if (isRetryableNetworkError(err) && attempt < 2) {
        const delay = attempt === 0 ? 500 : 1500;
        const code = err.cause?.code || err.code || err.message;
        console.warn(`[VERIFIER] Network error (${code}), retry in ${delay}ms (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      console.error(`[VERIFIER] OpenAI call failed: ${err.message}`);
      return { error: err.message, category: 'network' };
    }
  }

  return { error: 'unknown', category: 'unknown' };
}

// --- Main: verifyGap ---

async function verifyGap(discovery, deepDive) {
  // Rate limit check
  const now = Date.now();
  if (now - lastVerificationTime < RATE_LIMIT_MS) {
    const waitSec = Math.round((RATE_LIMIT_MS - (now - lastVerificationTime)) / 1000);
    console.log(`[VERIFIER] Rate limited — next verification in ${waitSec}s`);
    return null;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn('[VERIFIER] OPENAI_API_KEY not set — skipping verification');
    return null;
  }

  const systemPrompt = 'You are a skeptical research reviewer. Your job is to DISPROVE the following research gap claim. Be adversarial. Search for reasons this gap is invalid, already explored, or infeasible.';

  const domains = (discovery.cellLabels || []).join(', ');
  const source = discovery.source || 'not cited';
  const scores = deepDive.scores || {};

  const userPrompt = `A research coordination system claims this gap exists:

CLAIM: ${discovery.discovery || discovery.gap || ''}
DOMAINS: ${domains}
CITED SOURCES: ${source}
SYSTEM SCORE: novelty=${scores.novelty || 0}, impact=${scores.impact || 0}, feasibility=${scores.feasibility || 0}
SYSTEM TOTAL: ${scores.total || 0}/100
BRIDGE SCORE: ${scores.bridge || 0}/20

Your task:
1. Is this gap claim falsifiable? State it as a testable hypothesis.
2. Search your knowledge for papers that ALREADY cover this exact intersection.
3. What are fundamental reasons this combination might NOT work?
4. Are there labs or researchers already pursuing this?
5. Rate the evidence quality of the cited sources (0-5 for each, then average).
6. What is the cheapest experiment to test this? Be specific.
7. What would kill this hypothesis?

Also evaluate:
- evidence_quality: 0-5 for each cited source (return the average)
- bridge_strength_override: 0-20 (your assessment of bridge strength)
- speculation_leaps: how many inferential leaps you count
- score_reduction: how many points you would subtract from the total score and why

The final score will be the LOWER of the two models' assessments.

Return ONLY valid JSON:
{
  "falsifiable_claim": "one sentence testable hypothesis",
  "counter_evidence": ["paper or fact that challenges the gap"],
  "already_explored_by": ["lab or researcher name + what they did"],
  "fatal_flaws": ["fundamental problem with this combination"],
  "evidence_quality": 0-5,
  "bridge_strength_override": 0-20,
  "speculation_leaps": 0,
  "score_reduction": 0,
  "score_reduction_reason": "why points should be subtracted",
  "cheapest_experiment": "specific experiment description",
  "kill_test": "what result would disprove this",
  "survives_scrutiny": true/false,
  "confidence": 0-100,
  "verdict": "CONFIRMED|WEAKENED|KILLED"
}`;

  console.log(`[VERIFIER] REVIEWING ${discovery.id} — GPT-4o adversarial review starting...`);
  lastVerificationTime = Date.now();

  const res = await callOpenAI(systemPrompt, userPrompt);
  if (!res || res.error) {
    return { error: res?.error || 'OpenAI call failed', category: res?.category || 'unknown' };
  }

  const parsed = parseJSON(res.content || '');
  if (!parsed) {
    console.error(`[VERIFIER] Failed to parse GPT response for ${discovery.id}`);
    return { error: 'Failed to parse GPT response', category: 'parse_error', raw: (res.content || '').substring(0, 500) };
  }

  // Build verification entry
  const entry = {
    discovery_id: discovery.id,
    claude_verdict: deepDive.verdict,
    claude_score: scores.total || 0,
    gpt_verdict: parsed.verdict || 'UNKNOWN',
    gpt_confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    survives_scrutiny: !!parsed.survives_scrutiny,
    evidence_quality: typeof parsed.evidence_quality === 'number' ? parsed.evidence_quality : 0,
    bridge_strength_override: typeof parsed.bridge_strength_override === 'number' ? parsed.bridge_strength_override : null,
    speculation_leaps: typeof parsed.speculation_leaps === 'number' ? parsed.speculation_leaps : 0,
    score_reduction: typeof parsed.score_reduction === 'number' ? parsed.score_reduction : 0,
    score_reduction_reason: parsed.score_reduction_reason || '',
    falsifiable_claim: parsed.falsifiable_claim || '',
    counter_evidence: parsed.counter_evidence || [],
    already_explored_by: parsed.already_explored_by || [],
    fatal_flaws: parsed.fatal_flaws || [],
    kill_test: parsed.kill_test || '',
    cheapest_experiment: parsed.cheapest_experiment || '',
    timestamp: new Date().toISOString()
  };

  saveVerification(entry);

  const survivesTag = entry.survives_scrutiny ? 'SURVIVES' : 'CHALLENGED';
  console.log(`[VERIFIER] RESULT ${discovery.id} | Claude: ${entry.claude_verdict} (${entry.claude_score}) | GPT: ${entry.gpt_verdict} (conf=${entry.gpt_confidence}) | ${survivesTag}`);

  return entry;
}

async function verifierSelfTest() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' };
  try {
    const res = await callOpenAI('Respond with exactly: OK', 'Test');
    if (res && res.length > 0) return { ok: true, response: res.substring(0, 50) };
    return { ok: false, error: 'Empty response from OpenAI' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  verifyGap,
  verifierSelfTest,
  readVerifications,
  saveVerification
};
