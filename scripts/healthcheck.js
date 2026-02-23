#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

const dataDir = path.join(__dirname, '..', 'data');
const stateFile = path.join(dataDir, 'state.json');
const metricsFile = path.join(dataDir, 'metrics.json');
const findingsFile = path.join(dataDir, 'findings.json');
const lockFile = path.join(dataDir, '.tick.lock');

const state = readJson(stateFile) || {};
const metrics = readJson(metricsFile) || {};
const findingsData = readJson(findingsFile) || { findings: [] };
const findings = findingsData.findings || [];

const types = {};
for (const f of findings) {
  const t = f.type || '?';
  types[t] = (types[t] || 0) + 1;
}

const attempts = findings.filter(f => f.type === 'attempt');
const countAttempts = attempts.length;
const countNoGap = attempts.filter(a => a.result && a.result.outcome === 'no_gap').length;
const countDiscoveries = findings.filter(f => f.type === 'discovery').length;

const gptReviewed = typeof metrics.gpt_reviewed === 'number' ? metrics.gpt_reviewed : 0;

const lockExists = fs.existsSync(lockFile);

console.log(`tick: ${state.tick || 0}`);
console.log(`types: ${JSON.stringify(types)}`);
console.log(`attempts: ${countAttempts} discoveries: ${countDiscoveries} no_gap: ${countNoGap}`);
console.log(`gpt_reviewed: ${gptReviewed}`);
console.log(`tick_lock: ${lockExists ? 'present' : 'absent'}`);

let ok = true;
const issues = [];

if (countAttempts < (countDiscoveries + countNoGap)) {
  ok = false;
  issues.push('attempts < discoveries + no_gap');
}

if (typeof metrics.gap_rate === 'number') {
  if (metrics.gap_rate < 0 || metrics.gap_rate > 100) {
    ok = false;
    issues.push('gap_rate out of range');
  }
}

// High-value discoveries must have speculation_leaps <= 1 if present
for (const d of findings) {
  if (d.type !== 'discovery') continue;
  const v = (d.verdict && d.verdict.verdict) || d.verdict || '';
  if (v === 'HIGH-VALUE GAP' && d.speculation_index && typeof d.speculation_index.leaps === 'number') {
    if (d.speculation_index.leaps > 1) {
      ok = false;
      issues.push(`high_value_leaps>1 id=${d.id}`);
      break;
    }
  }
}

// Metrics totals match ground truth counts (subset)
if (typeof metrics.total_discovery_attempts === 'number' && metrics.total_discovery_attempts !== countAttempts) {
  ok = false;
  issues.push('metrics.total_discovery_attempts mismatch');
}
if (typeof metrics.total_discoveries === 'number' && metrics.total_discoveries !== countDiscoveries) {
  ok = false;
  issues.push('metrics.total_discoveries mismatch');
}
if (typeof metrics.total_no_gap === 'number' && metrics.total_no_gap !== countNoGap) {
  ok = false;
  issues.push('metrics.total_no_gap mismatch');
}

if (!ok) {
  console.log(`healthcheck: FAIL (${issues.join('; ')})`);
  process.exit(1);
}

console.log('healthcheck: OK');
process.exit(0);
