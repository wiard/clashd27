#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function loadJson(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[HEALTH] Failed to read ${path.basename(p)}: ${e.message}`);
  }
  return fallback;
}

const state = loadJson(path.join(DATA, 'state.json'), {});
const metrics = loadJson(path.join(DATA, 'metrics.json'), {});
const findingsData = loadJson(path.join(DATA, 'findings.json'), { findings: [] });
const verifs = loadJson(path.join(DATA, 'verifications.json'), { verifications: [] });
const findings = Array.isArray(findingsData.findings) ? findingsData.findings : [];

const typeCounts = {};
for (const f of findings) {
  const t = f.type || 'unknown';
  typeCounts[t] = (typeCounts[t] || 0) + 1;
}

const attempts = findings.filter(f => f.type === 'attempt');
const discoveries = findings.filter(f => f.type === 'discovery');
const noGap = attempts.filter(a => a.result && a.result.outcome === 'no_gap');

let highValue = 0;
let confirmed = 0;
let needsWork = 0;
let lowPriority = 0;
for (const d of discoveries) {
  const v = (d.verdict && d.verdict.verdict) || d.verdict || '';
  if (v === 'HIGH-VALUE GAP') highValue++;
  else if (v === 'CONFIRMED DIRECTION') confirmed++;
  else if (v === 'NEEDS WORK') needsWork++;
  else if (v === 'LOW PRIORITY') lowPriority++;
}

const lockFile = path.join(DATA, '.tick.lock');
let lockInfo = 'absent';
if (fs.existsSync(lockFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const ageSec = Math.round((Date.now() - (raw.ts || 0)) / 1000);
    lockInfo = `present age=${ageSec}s pid=${raw.pid || 'n/a'}`;
  } catch (e) {
    lockInfo = 'present (unreadable)';
  }
}

console.log(`[HEALTH] tick=${state.tick ?? 'n/a'} agents=${(state.agents && Object.keys(state.agents).length) || 'n/a'}`);
console.log(`[HEALTH] counts_by_type=${JSON.stringify(typeCounts)}`);
console.log(`[HEALTH] attempts=${attempts.length} discoveries=${discoveries.length} no_gap=${noGap.length}`);
console.log(`[HEALTH] gpt_reviewed=${(verifs.verifications || []).length}`);
console.log(`[HEALTH] tick_lock=${lockInfo}`);

const errors = [];

// Invariant 1: attempts >= discoveries + no_gap
if (attempts.length < discoveries.length + noGap.length) {
  errors.push(`attempts < discoveries + no_gap (${attempts.length} < ${discoveries.length + noGap.length})`);
}

// Invariant 2: gap_rate 0..100
const gapRate = metrics.gap_rate;
if (typeof gapRate === 'number' && (gapRate < 0 || gapRate > 100)) {
  errors.push(`gap_rate out of bounds: ${gapRate}`);
}

// Invariant 3: HIGH-VALUE discoveries should have low speculation_leaps if present
for (const d of discoveries) {
  const v = (d.verdict && d.verdict.verdict) || d.verdict || '';
  const leaps = d.speculation_index && typeof d.speculation_index.leaps === 'number' ? d.speculation_index.leaps : null;
  if (v === 'HIGH-VALUE GAP' && leaps !== null && leaps > 1) {
    errors.push(`HIGH-VALUE discovery ${d.id} has speculation_leaps=${leaps}`);
    break;
  }
}

// Invariant 4: metrics totals match ground truth
const mismatches = [];
function checkMetric(key, actual) {
  if (typeof metrics[key] === 'number' && metrics[key] !== actual) {
    mismatches.push(`${key}=${metrics[key]} (expected ${actual})`);
  }
}
checkMetric('total_discovery_attempts', attempts.length);
checkMetric('total_discoveries', discoveries.length);
checkMetric('total_no_gap', noGap.length);
checkMetric('total_high_value', highValue);
checkMetric('total_confirmed_direction', confirmed);
checkMetric('total_needs_work', needsWork);
checkMetric('total_low_priority', lowPriority);
checkMetric('total_cell_findings', typeCounts.cell || 0);
if (Array.isArray(verifs.verifications)) {
  checkMetric('gpt_reviewed', verifs.verifications.length);
}
if (mismatches.length > 0) {
  errors.push(`metrics_mismatch: ${mismatches.join('; ')}`);
}

if (errors.length > 0) {
  console.error('[HEALTH] FAIL');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('[HEALTH] OK');
process.exit(0);
