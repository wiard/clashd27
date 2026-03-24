'use strict';

const fs = require('fs');
const path = require('path');

const { mapChipSignalToCube, normalizeChipAction } = require('./chip-cube-mapper.js');

const DEFAULT_CHIP_DATA_DIR = process.env.CLASHD27_CHIP_DATA_DIR || '/root/openclashd-v2/data/chip';
const DEFAULT_CHIP_RUNS_PATH = path.join(DEFAULT_CHIP_DATA_DIR, 'runs.jsonl');
const DEFAULT_CHIP_OUTCOMES_PATH = path.join(DEFAULT_CHIP_DATA_DIR, 'outcomes.jsonl');
const DEFAULT_CHIP_HYPOTHESES_PATH = path.join(DEFAULT_CHIP_DATA_DIR, 'hypotheses.jsonl');

const SEVERITY_WEIGHT = Object.freeze({
  critical: 2,
  violation: 1,
  margin: 0.5,
  surprise: 1.5
});

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function sortByTimestampDesc(rows, field = 'timestamp') {
  return [...(rows || [])].sort((left, right) => {
    const a = Date.parse(left?.[field] || left?.created_at || 0);
    const b = Date.parse(right?.[field] || right?.created_at || 0);
    return b - a;
  });
}

function buildLatestByPath(rows, field = 'timestamp') {
  const map = new Map();
  for (const row of sortByTimestampDesc(rows, field)) {
    const key = String(row?.path_key || '').trim();
    if (!key || map.has(key)) continue;
    map.set(key, row);
  }
  return map;
}

function effectiveSlackMagnitude(signal) {
  const slackNs = safeNumber(signal.slack_ns);
  if (slackNs < 0) return Math.abs(slackNs);
  if (slackNs <= 0.5) return Math.max(slackNs, 0.05);
  return 0.1;
}

function computePatternScore(signals) {
  const rows = signals || [];
  const frequency = rows.length;
  const severityWeight = rows.reduce((max, row) => {
    const mapped = row.cube || mapChipSignalToCube(row);
    return Math.max(max, SEVERITY_WEIGHT[mapped.severity] || 0.5);
  }, 0.5);
  const slackMagnitude = rows.length > 0
    ? rows.reduce((sum, row) => sum + effectiveSlackMagnitude(row), 0) / rows.length
    : 0;
  return round(severityWeight * frequency * slackMagnitude);
}

function preferredAction(signal) {
  return normalizeChipAction(signal.proposed_action) || signal.cube.action_hint;
}

function signalToCubeRecord(signal, extra = {}) {
  const cube = mapChipSignalToCube(signal);
  return {
    ...signal,
    ...extra,
    cube,
    cell_id: cube.cell_id,
    action_axis: preferredAction({ ...signal, cube, ...extra })
  };
}

function loadChipData(options = {}) {
  const runs = sortByTimestampDesc(readJsonl(options.runsPath || DEFAULT_CHIP_RUNS_PATH), 'created_at');
  const outcomes = readJsonl(options.outcomesPath || DEFAULT_CHIP_OUTCOMES_PATH);
  const hypotheses = readJsonl(options.hypothesesPath || DEFAULT_CHIP_HYPOTHESES_PATH);
  return { runs, outcomes, hypotheses };
}

function materializeSignals(data, options = {}) {
  const runs = (data.runs || []).slice(0, Number.isFinite(options.maxRuns) ? options.maxRuns : 4);
  const outcomeByPath = buildLatestByPath(data.outcomes || []);
  const hypothesisByPath = buildLatestByPath(data.hypotheses || []);
  const latestRunId = runs[0]?.run_id || null;
  const latestSignals = [];
  const allSignals = [];

  for (const run of runs) {
    for (const pathEntry of run.paths || []) {
      const pathKey = String(pathEntry.path_key || '').trim();
      if (!pathKey) continue;
      const hypothesis = hypothesisByPath.get(pathKey) || null;
      const outcome = outcomeByPath.get(pathKey) || null;
      const baseSignal = signalToCubeRecord({
        path_key: pathKey,
        classification: pathEntry.subdomain || 'timing-path',
        slack_ns: pathEntry.slack_ns,
        blocking: pathEntry.blocking === true,
        subdomain: pathEntry.subdomain || null,
        proposed_action: hypothesis?.proposed_action || null,
        outcome: outcome?.outcome || null,
        slack_delta_ns: outcome?.slack_delta_ns ?? null,
        run_id: run.run_id,
        design: run.design,
        platform: run.platform,
        report_path: run.report_path,
        created_at: run.created_at
      });
      allSignals.push(baseSignal);
      if (run.run_id === latestRunId) {
        latestSignals.push(baseSignal);
      }
    }
  }

  return {
    latestRun: runs[0] || null,
    latestSignals,
    signals: allSignals
  };
}

function buildAxes(records, actionSelector = (row) => row.action_axis) {
  return Array.from(new Map((records || []).map((row) => [
    `${row.cube.what}/${row.cube.severity}/${actionSelector(row)}`,
    {
      what: row.cube.what,
      severity: row.cube.severity,
      action: actionSelector(row)
    }
  ])).values());
}

function makeCandidateId(prefix, key) {
  return `${prefix}-${String(key || 'unknown').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

function describeAction(action) {
  if (action === 'retime') return 'retiming';
  if (action === 'buffer') return 'buffering';
  if (action === 'resize') return 'resizing';
  if (action === 'delay') return 'delay insertion';
  return 'monitoring';
}

function detectRepeatedViolations(records, latestRun) {
  const buckets = new Map();
  for (const row of records || []) {
    if (!(row.cube.severity === 'critical' || row.cube.severity === 'violation')) continue;
    const key = row.cell_id;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  return Array.from(buckets.entries())
    .filter(([, rows]) => rows.length >= 2)
    .map(([key, rows]) => {
      const lead = rows[0];
      const platform = lead.platform || latestRun?.platform || 'chip';
      return {
        candidateId: makeCandidateId('chip-repeat', key),
        outcomeType: 'DISCOVERY',
        score: computePatternScore(rows),
        axes: buildAxes(rows, (row) => row.cube.action_hint),
        explanation: `${lead.cube.severity.charAt(0).toUpperCase()}${lead.cube.severity.slice(1)} ${lead.cube.what} paths repeatedly require ${describeAction(lead.action_axis)} in ${platform}`,
        source: 'chip_timing',
        pattern: 'repeated_violations',
        groupedBy: key,
        frequency: rows.length,
        paths: rows.map((row) => row.path_key)
      };
    });
}

function detectActionClusters(records, latestRun) {
  const buckets = new Map();
  for (const row of records || []) {
    const key = row.action_axis;
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  return Array.from(buckets.entries())
    .filter(([, rows]) => new Set(rows.map((row) => row.cell_id)).size >= 2)
    .map(([action, rows]) => ({
      candidateId: makeCandidateId('chip-action', action),
      outcomeType: 'DISCOVERY',
      score: computePatternScore(rows),
      axes: buildAxes(rows),
      explanation: `${action.charAt(0).toUpperCase()}${action.slice(1)} pressure clusters across ${new Set(rows.map((row) => row.cell_id)).size} chip cells in ${latestRun?.platform || 'sky130hd'}`,
      source: 'chip_timing',
      pattern: 'action_clusters',
      groupedBy: action,
      frequency: rows.length,
      paths: rows.map((row) => row.path_key)
    }));
}

function detectCrossAxisConflicts(records) {
  const byAction = new Map();
  for (const row of records || []) {
    const key = row.action_axis;
    if (!key) continue;
    if (!byAction.has(key)) byAction.set(key, []);
    byAction.get(key).push(row);
  }

  const candidates = [];
  for (const [action, rows] of byAction.entries()) {
    const whats = new Set(rows.map((row) => row.cube.what));
    if (whats.size >= 2) {
      candidates.push({
        candidateId: makeCandidateId('chip-cross-axis', action),
        outcomeType: 'SURPRISE',
        score: computePatternScore(rows),
        axes: buildAxes(rows),
        explanation: `${action.charAt(0).toUpperCase()}${action.slice(1)} spans conflicting timing axes: ${Array.from(whats).join(' and ')}`,
        source: 'chip_timing',
        pattern: 'cross_axis_conflicts',
        groupedBy: action,
        frequency: rows.length,
        paths: rows.map((row) => row.path_key)
      });
    }
  }

  const byWhat = new Map();
  for (const row of records || []) {
    if (!(row.cube.severity === 'critical' || row.cube.severity === 'violation')) continue;
    const key = row.cube.what;
    if (!byWhat.has(key)) byWhat.set(key, []);
    byWhat.get(key).push(row);
  }

  for (const [what, rows] of byWhat.entries()) {
    const actions = new Set(rows.map((row) => row.action_axis));
    if (actions.size >= 2) {
      candidates.push({
        candidateId: makeCandidateId('chip-gap', `${what}-${Array.from(actions).join('-')}`),
        outcomeType: 'GAP',
        score: computePatternScore(rows),
        axes: buildAxes(rows),
        explanation: `${what.charAt(0).toUpperCase()}${what.slice(1)} repair pressure splits between ${Array.from(actions).join(' and ')}, suggesting a local chip strategy gap`,
        source: 'chip_timing',
        pattern: 'cross_axis_conflicts',
        groupedBy: what,
        frequency: rows.length,
        paths: rows.map((row) => row.path_key)
      });
    }
  }

  return candidates;
}

function summarizePatterns(discoveries) {
  const counts = new Map();
  for (const item of discoveries || []) {
    counts.set(item.pattern, (counts.get(item.pattern) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([pattern, count]) => ({ pattern, count }));
}

function generateChipCubeDiscoveries(options = {}) {
  const data = loadChipData(options);
  const materialized = materializeSignals(data, options);
  const latestSignals = materialized.latestSignals;
  const allSignals = materialized.signals;

  const candidates = [
    ...detectRepeatedViolations(allSignals, materialized.latestRun),
    ...detectActionClusters(latestSignals, materialized.latestRun),
    ...detectCrossAxisConflicts(latestSignals)
  ]
    .sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId));

  const limit = Number.isFinite(options.limit) ? options.limit : 10;
  const topDiscoveries = candidates.slice(0, limit);

  return {
    source: 'chip_timing',
    generated_at: new Date().toISOString(),
    latest_run_id: materialized.latestRun?.run_id || null,
    latest_report_path: materialized.latestRun?.report_path || null,
    signal_count: allSignals.length,
    latest_signal_count: latestSignals.length,
    grouped: summarizePatterns(topDiscoveries),
    discoveries: topDiscoveries
  };
}

module.exports = {
  DEFAULT_CHIP_DATA_DIR,
  DEFAULT_CHIP_HYPOTHESES_PATH,
  DEFAULT_CHIP_OUTCOMES_PATH,
  DEFAULT_CHIP_RUNS_PATH,
  computePatternScore,
  generateChipCubeDiscoveries,
  loadChipData,
  materializeSignals
};
