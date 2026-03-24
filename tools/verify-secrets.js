#!/usr/bin/env node
/**
 * CLASHD-27 — Secrets Verification Tool
 * Checks key presence + OpenAI connectivity. NEVER prints full keys.
 * Usage: node tools/verify-secrets.js
 * Exit 0 = OK, non-zero = problem.
 */

const SECRETS_PATH = '/home/greenbanaanas/.secrets/clashd27.env';

require('dotenv').config({ path: SECRETS_PATH, override: true });

// --- Redaction helpers (inline, no extra deps) ---
function redact(val) {
  if (!val) return '(empty)';
  return `len=${val.length} last4=...${val.slice(-4)}`;
}

function redactBody(text, maxLen) {
  // strip anything that looks like a key
  return text
    .replace(/sk-proj-[A-Za-z0-9_-]+/g, 'sk-proj-[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]')
    .substring(0, maxLen);
}

// --- Key presence check ---
const keys = {
  OPENAI_API_KEY:    process.env.OPENAI_API_KEY    || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY  || '',
  DISCORD_TOKEN:     process.env.DISCORD_TOKEN      || '',
};

console.log(`[VERIFY] Secrets source: ${SECRETS_PATH}`);
console.log('[VERIFY] Key status:');

let anyMissing = false;
for (const [name, val] of Object.entries(keys)) {
  const present = val.length > 0;
  if (!present) anyMissing = true;
  console.log(`  ${name}: present=${present} ${present ? redact(val) : ''}`);
}

if (!keys.OPENAI_API_KEY) {
  console.error('[VERIFY] FAIL — OPENAI_API_KEY is missing. Cannot test OpenAI.');
  process.exit(1);
}

// --- OpenAI connectivity test ---
async function testOpenAI() {
  console.log('\n[VERIFY] Testing OpenAI /v1/models ...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${keys.OPENAI_API_KEY}`,
        'User-Agent': 'clashd27-verify/1.0'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const body = await res.text();
    console.log(`  HTTP ${res.status}`);
    console.log(`  Body (120 chars, redacted): ${redactBody(body, 120)}`);

    if (res.status === 200) {
      console.log('[VERIFY] OPENAI PASS');
    } else if (res.status === 401) {
      console.error('[VERIFY] OPENAI FAIL — 401 invalid key. Rotate at https://platform.openai.com/api-keys');
      return false;
    } else if (res.status === 403) {
      console.error('[VERIFY] OPENAI FAIL — 403 forbidden. Check org/project permissions.');
      return false;
    } else {
      console.error(`[VERIFY] OPENAI FAIL — unexpected HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    clearTimeout(timeout);
    const code = err.cause?.code || err.code || err.name;
    console.error(`[VERIFY] OPENAI FAIL — ${code}: ${err.message}`);
    return false;
  }
}

// --- Anthropic check (skip — no cheap endpoint) ---
function checkAnthropic() {
  if (keys.ANTHROPIC_API_KEY) {
    console.log('\n[VERIFY] Anthropic key present — connectivity check skipped (no cheap public endpoint).');
  } else {
    console.log('\n[VERIFY] Anthropic key not set — skipped.');
  }
}

// --- Main ---
(async () => {
  const openaiOk = await testOpenAI();
  checkAnthropic();

  console.log('\n========== VERIFY SUMMARY ==========');
  console.log(`  OPENAI_API_KEY:    ${keys.OPENAI_API_KEY ? 'present' : 'MISSING'} ${openaiOk ? '(API OK)' : '(API FAIL)'}`);
  console.log(`  ANTHROPIC_API_KEY: ${keys.ANTHROPIC_API_KEY ? 'present' : 'MISSING'}`);
  console.log(`  DISCORD_TOKEN:     ${keys.DISCORD_TOKEN ? 'present' : 'MISSING'}`);
  console.log('=====================================');

  if (!openaiOk) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  if (anyMissing) {
    console.warn('RESULT: PARTIAL (some keys missing)');
    process.exit(0); // still exit 0 if OpenAI works
  }
  console.log('RESULT: ALL OK');
})();
