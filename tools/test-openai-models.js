#!/usr/bin/env node
/**
 * CLASHD-27 — OpenAI /v1/models connectivity test (SAFE: no key in output)
 * Usage: node tools/test-openai-models.js
 */
require('dotenv').config({ path: '/home/greenbanaanas/.secrets/clashd27.env', override: true });

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[CONN] FAIL — OPENAI_API_KEY not set');
    process.exit(1);
  }

  console.log(`[CONN] Testing OpenAI API (key len=${apiKey.length}, ends=...${apiKey.slice(-4)})`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'clashd27-doctor/1.0'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const body = await res.text();
    console.log(`[CONN] HTTP ${res.status}`);
    console.log(`[CONN] Body (first 200 chars): ${body.substring(0, 200)}`);

    if (res.status === 200) {
      console.log('[CONN] PASS — OpenAI API reachable and key valid');
    } else if (res.status === 401) {
      console.error('[CONN] FAIL — 401 Invalid API key');
      console.error('');
      console.error('  Your key is invalid, revoked, or belongs to a different org.');
      console.error('  Steps to fix:');
      console.error('    1. Go to https://platform.openai.com/api-keys');
      console.error('    2. Create a new secret key (project key "sk-proj-..." recommended)');
      console.error('    3. Edit ~/clashd27/.env and replace OPENAI_API_KEY=<new key>');
      console.error('    4. Run: pm2 delete clashd27-bot && pm2 start ecosystem.config.js');
      console.error('    5. Re-run: npm run doctor');
      process.exit(1);
    } else {
      console.error(`[CONN] FAIL — Unexpected status ${res.status}`);
      process.exit(1);
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error('[CONN] FAIL — Request timed out (15s)');
    } else {
      const code = err.cause?.code || err.code || 'UNKNOWN';
      console.error(`[CONN] FAIL — ${code}: ${err.message}`);
      if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
        console.error('  This is a network error. Check DNS, firewall, or retry later.');
      }
    }
    process.exit(1);
  }
}

main();
