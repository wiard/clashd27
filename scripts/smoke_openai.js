#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/models';

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('status=missing_api_key');
    process.exit(1);
  }

  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (response.status === 200) {
      console.log('status=200');
      process.exit(0);
    }

    const body = await response.text().catch(() => 'unreadable');
    console.log(`status=${response.status}`);
    console.log(body.substring(0, 120));
    process.exit(1);
  } catch (err) {
    console.log('status=error');
    console.log(String(err.message || err).substring(0, 120));
    process.exit(1);
  }
}

main();
