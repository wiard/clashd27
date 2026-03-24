#!/usr/bin/env node
'use strict';

const path = require('path');
let dotenv = null;
try { dotenv = require('dotenv'); } catch (e) { dotenv = null; }
if (dotenv && typeof dotenv.config === 'function') {
  dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });
}

const { State, loadPack } = require('../lib/state');
const { TickEngine } = require('../lib/tick-engine');
const { publishDailyGapsIfNeeded } = require('../lib/gap-publisher');
const { readCube, shuffle } = require('../lib/shuffler');

const TICKS = parseInt(process.argv[2] || '30', 10);
const OFFLINE = process.argv.includes('--offline');

function seedFallbackGaps(minCount = 3) {
  const { readJSON, writeJSONAtomic } = (() => {
    const fs = require('fs');
    const path = require('path');
    return {
      readJSON: (p, f) => {
        try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
        return f;
      },
      writeJSONAtomic: (p, d) => {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
        fs.renameSync(tmp, p);
      }
    };
  })();

  const packs = require('../packs/ai-research.json');
  const gapsDir = path.join(__dirname, '..', 'data', 'gaps');
  const indexFile = path.join(gapsDir, 'index.json');
  const index = readJSON(indexFile, { date: new Date().toISOString().slice(0, 10), total: 0, gaps: [] });

  const combos = [
    [0, 13], [2, 15], [4, 21], [7, 14], [9, 23]
  ];
  let created = 0;
  for (const [a, b] of combos) {
    if (index.gaps.length >= minCount) break;
    const id = `seed-${a}-${b}-${Date.now()}`;
    const gap = {
      id,
      date: new Date().toISOString().slice(0, 10),
      corridor: `${packs.cells[String(a)].label}×${packs.cells[String(b)].label}`,
      methodAxis: 'computational × computational',
      surpriseBucket: 'deviation × anomalous',
      sources: ['seeded'],
      claim: `Missing experiment linking ${packs.cells[String(a)].label} to ${packs.cells[String(b)].label}. This connection remains untested.`,
      evidence: [
        `A → B: ${packs.cells[String(a)].description} — seeded reference`,
        `B → C: ${packs.cells[String(b)].description} — seeded reference`
      ],
      proposed_experiment: 'Create a benchmark and evaluate transfer between the two domains using a shared model family.',
      risks: ['Seeded placeholder — replace with real papers when pipeline runs'],
      references: ['Seeded placeholder references'],
      scoring: {
        collision: 0.58,
        methodDistance: 0.5,
        semanticDistance: 1.0,
        surpriseScore: 0.62,
        finalScore: 78
      },
      raw: { verdict: 'CONFIRMED DIRECTION', pack: 'ai-research', cellLabels: [packs.cells[String(a)].label, packs.cells[String(b)].label] }
    };
    writeJSONAtomic(path.join(gapsDir, `${gap.id}.json`), gap);
    index.gaps.push({
      id: gap.id,
      score: gap.scoring.finalScore,
      corridor: gap.corridor,
      methodAxis: gap.methodAxis,
      surpriseBucket: gap.surpriseBucket,
      sources: gap.sources,
      claim: gap.claim,
      date: gap.date
    });
    created++;
  }
  index.gaps.sort((x, y) => (y.score || 0) - (x.score || 0));
  index.total = index.gaps.length;
  writeJSONAtomic(indexFile, index);
  return created;
}

async function run() {
  if (!process.env.USE_CUBE) process.env.USE_CUBE = 'true';
  if (!process.env.MIN_COLLISION_SCORE) process.env.MIN_COLLISION_SCORE = '0.15';
  loadPack('ai-research');
  const state = new State();
  const engine = new TickEngine({ state, tickInterval: 1, useCube: true });

  engine.on('log', ({ level, msg }) => {
    if (level === 'error') console.error(msg);
    else console.log(msg);
  });
  engine.on('error', ({ phase, error }) => {
    console.error(`[${phase}] ${error.message}`);
  });

  if (!OFFLINE) {
    const cube = readCube();
    if (!cube) {
      console.log('[SEED-GAPS] No cube found. Generating cube now...');
      await shuffle(state.tick, 0, (f, t) => {
        if (f % 100 === 0) console.log(`[SEED-GAPS] Shuffle progress: ${f}/${t}`);
      });
    }

    console.log(`[SEED-GAPS] Running ${TICKS} ticks to seed gaps...`);
    for (let i = 0; i < TICKS; i++) {
      await engine._tickInner();
    }
    const pub = publishDailyGapsIfNeeded({ maxGaps: 5 });
    console.log(`[SEED-GAPS] Publish result: +${pub.published} (total today: ${pub.total})`);
  } else {
    const created = seedFallbackGaps(3);
    console.log(`[SEED-GAPS] OFFLINE seed created ${created} gaps`);
  }
  process.exit(0);
}

run().catch(e => {
  console.error(`[SEED-GAPS] Fatal: ${e.message}`);
  process.exit(1);
});
