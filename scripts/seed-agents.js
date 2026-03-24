#!/usr/bin/env node
'use strict';

const path = require('path');
let dotenv = null;
try { dotenv = require('dotenv'); } catch (e) { dotenv = null; }
if (dotenv && typeof dotenv.config === 'function') {
  dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });
}

const { State, loadPack } = require('../lib/state');

const AGENTS = [
  { id: 'seed-0', name: 'SeedAgent-0', num: 0 },
  { id: 'seed-4', name: 'SeedAgent-4', num: 4 },
  { id: 'seed-8', name: 'SeedAgent-8', num: 8 },
  { id: 'seed-9', name: 'SeedAgent-9', num: 9 },
  { id: 'seed-13', name: 'SeedAgent-13', num: 13 },
  { id: 'seed-18', name: 'SeedAgent-18', num: 18 }
];

function main() {
  loadPack('ai-research');
  const state = new State();
  let added = 0;
  for (const a of AGENTS) {
    if (state.getAgent(a.id)) continue;
    const res = state.addAgent(a.id, a.name, a.num);
    if (res && res.ok) added++;
  }
  console.log(`[SEED-AGENTS] Added ${added} agents. Total now: ${state.agents.size}`);
  process.exit(0);
}

main();
