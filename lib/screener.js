/**
 * CLASHD-27 — Haiku Screener
 * Two-stage screening: cheap Haiku YES/NO before expensive Sonnet discovery calls.
 * Follows researcher.js API call pattern.
 */

const budget = require('./budget');

const API_URL = 'http://localhost:3027/api/weigh';
const SCREENING_MODEL = 'claude-haiku-4-5-20251001';
const SCREEN_TIMEOUT_MS = 15_000;

/**
 * Screen a collision pair before investing in a full Sonnet investigateDiscovery call.
 *
 * @param {object} paperA - { label, keywords[], cubeDesc? }
 * @param {object} paperB - { label, keywords[], cubeDesc? }
 * @param {number} goldenScore - collision score (0–1)
 * @returns {{ pass: boolean, reason: string }}
 */
async function screenCollision(paperA, paperB, goldenScore) {
  const prompt = `You are a research collision screener. Two research domains are about to be investigated for cross-domain research gaps.

Domain A: ${paperA.label}${paperA.keywords?.length ? ` (keywords: ${paperA.keywords.slice(0, 5).join(', ')})` : ''}
Domain B: ${paperB.label}${paperB.keywords?.length ? ` (keywords: ${paperB.keywords.slice(0, 5).join(', ')})` : ''}
Collision score: ${goldenScore.toFixed(2)}

Could a meaningful, non-obvious cross-domain research gap exist between these two domains?
A good collision has: different methodologies, complementary knowledge, potential for novel hypotheses.
A bad collision has: domains too similar, no plausible bridge, trivially obvious overlap.

Answer with ONLY "YES" or "NO" followed by a single short reason (max 15 words).
Example: "YES — different imaging modalities could reveal unseen tumor biomarkers"
Example: "NO — both domains study the same pathway with identical methods"`;

  const estimatedInputTokens = budget.estimateTokens(prompt);
  if (!budget.canAffordCall(SCREENING_MODEL, estimatedInputTokens, 50)) {
    // Budget exhausted — default to passing (don't block research)
    return { pass: true, reason: 'budget_skip' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCREEN_TIMEOUT_MS);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SCREENING_MODEL,
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      // API error — default to passing
      return { pass: true, reason: 'api_error' };
    }

    const data = await response.json();

    if (data.error) {
      return { pass: true, reason: 'api_error' };
    }

    let text = '';
    if (data.content) {
      for (const block of data.content) {
        if (block.type === 'text') text += block.text;
      }
    }

    budget.trackCall(SCREENING_MODEL, estimatedInputTokens, budget.estimateTokens(text));

    const upper = text.trim().toUpperCase();
    const pass = upper.startsWith('YES');
    const reason = text.trim().replace(/^(YES|NO)\s*[—–\-:]*\s*/i, '').slice(0, 100);

    return { pass, reason: reason || (pass ? 'approved' : 'rejected') };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { pass: true, reason: 'timeout' };
    }
    return { pass: true, reason: `error: ${err.message}` };
  }
}

module.exports = { screenCollision };
