#!/usr/bin/env node
'use strict';

const path = require('path');
const { config } = require('dotenv');

config({ path: path.join(__dirname, '..', '.env'), override: true });

async function main() {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    console.log('status=0 error=OPENAI_API_KEY not set');
    process.exit(1);
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'clashd27-smoke/1.0'
      }
    });

    if (res.status === 200) {
      console.log('status=200 ok');
      process.exit(0);
    }

    const body = await res.text().catch(() => 'unreadable');
    const msg = (body || '').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`status=${res.status} error=${msg}`);
    process.exit(1);
  } catch (err) {
    const msg = (err && err.message ? err.message : 'unknown').replace(/\s+/g, ' ').slice(0, 120);
    console.log(`status=0 error=${msg}`);
    process.exit(1);
  }
}

main();
