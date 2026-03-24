/**
 * Test script for OpenAI GPT-4o verifier.
 * Usage: node test-verifier.js
 */
require('dotenv').config({ path: '/home/greenbanaanas/.secrets/clashd27.env', override: true });

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[TEST] FAIL — OPENAI_API_KEY not set');
    process.exit(1);
  }
  console.log(`[TEST] OPENAI_API_KEY loaded (${apiKey.substring(0, 12)}...)`);

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
          { role: 'system', content: 'You are a test assistant. Reply with exactly: {"status":"ok"}' },
          { role: 'user', content: 'ping' }
        ],
        max_tokens: 20,
        temperature: 0
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unreadable');
      console.error(`[TEST] FAIL — HTTP ${response.status}: ${body.substring(0, 300)}`);
      process.exit(1);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '';
    console.log(`[TEST] GPT-4o replied: ${reply}`);
    console.log('[TEST] PASS — OpenAI verifier is working');
  } catch (err) {
    console.error(`[TEST] FAIL — ${err.message}`);
    process.exit(1);
  }
}

main();
