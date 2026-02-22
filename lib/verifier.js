/**
 * CLASHD-27 — Independent Verification Module
 * Uses OpenAI GPT-4o to challenge discoveries found by Claude.
 * Adversarial review: tries to DISPROVE research gap claims.
 */

const fs = require('fs');
const path = require('path');

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

async function callOpenAI(systemPrompt, userPrompt, retries = 2) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[VERIFIER] OPENAI_API_KEY not set — skipping verification');
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 2000,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (response.status === 429 && retries > 0) {
      console.log(`[VERIFIER] Rate limited by OpenAI, retrying in 30s (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 30000));
      return callOpenAI(systemPrompt, userPrompt, retries - 1);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unreadable');
      console.error(`[VERIFIER] OpenAI HTTP ${response.status}: ${errBody.substring(0, 300)}`);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[VERIFIER] OpenAI error: ${data.error.message}`);
      return null;
    }

    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[VERIFIER] OpenAI request timed out (60s)');
    } else {
      console.error(`[VERIFIER] OpenAI call failed: ${err.message}`);
    }
    return null;
  }
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

Your task:
1. Is this gap claim falsifiable? State it as a testable hypothesis.
2. Search your knowledge for papers that ALREADY cover this exact intersection.
3. What are fundamental reasons this combination might NOT work?
4. Are there labs or researchers already pursuing this?
5. Rate the evidence quality of the cited sources (0-5).
6. What is the cheapest experiment to test this? Be specific.
7. What would kill this hypothesis?

Return ONLY valid JSON:
{
  "falsifiable_claim": "one sentence testable hypothesis",
  "counter_evidence": ["paper or fact that challenges the gap"],
  "already_explored_by": ["lab or researcher name + what they did"],
  "fatal_flaws": ["fundamental problem with this combination"],
  "evidence_quality": 0-5,
  "cheapest_experiment": "specific experiment description",
  "kill_test": "what result would disprove this",
  "survives_scrutiny": true/false,
  "confidence": 0-100,
  "verdict": "CONFIRMED|WEAKENED|KILLED"
}`;

  console.log(`[VERIFIER] Sending ${discovery.id} to GPT-4o for adversarial review...`);
  lastVerificationTime = Date.now();

  const raw = await callOpenAI(systemPrompt, userPrompt);
  if (!raw) {
    return { error: 'OpenAI call failed or returned empty' };
  }

  const parsed = parseJSON(raw);
  if (!parsed) {
    console.error(`[VERIFIER] Failed to parse GPT response for ${discovery.id}`);
    return { error: 'Failed to parse GPT response', raw: raw.substring(0, 500) };
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
  console.log(`[VERIFIER] ${discovery.id} | Claude: ${entry.claude_verdict} (${entry.claude_score}) | GPT: ${entry.gpt_verdict} (${entry.gpt_confidence}) | ${survivesTag}`);

  return entry;
}

module.exports = {
  verifyGap,
  readVerifications,
  saveVerification
};
