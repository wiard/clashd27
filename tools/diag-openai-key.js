#!/usr/bin/env node
/**
 * CLASHD-27 — OpenAI Key Diagnostic (SAFE: never prints full key)
 * Usage: node tools/diag-openai-key.js
 */
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: '/home/greenbanaanas/.secrets/clashd27.env', override: true });

const key = process.env.OPENAI_API_KEY || '';

if (!key) {
  console.error('[DIAG] FAIL — OPENAI_API_KEY is empty or not set');
  process.exit(1);
}

const sha = crypto.createHash('sha256').update(key).digest('hex').substring(0, 12);

console.log('[DIAG] OPENAI_API_KEY loaded');
console.log(`  len      : ${key.length}`);
console.log(`  prefix   : ${key.substring(0, 10)}...`);
console.log(`  suffix   : ...${key.slice(-4)}`);
console.log(`  sha256_12: ${sha}`);
console.log(`  has_ws   : ${/\s/.test(key)}`);
console.log(`  has_quote: ${/["']/.test(key)}`);
console.log('[DIAG] PASS');
