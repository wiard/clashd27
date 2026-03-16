#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const defaultTests = [
  'scripts/test-clashd27-cube-engine.js',
  'tests/cube-engine.test.js',
  'tests/discovery-candidates.test.js',
  'tests/gap-pipeline.test.js',
  'tests/paper-ingestion.test.js',
  'tests/discovery-stream-orchestrator.test.js',
  'tests/gap-runtime.test.js'
];

const selected = process.argv.slice(2);
const targets = selected.length > 0 ? selected : defaultTests;

for (const target of targets) {
  const result = spawnSync(process.execPath, [path.resolve(target)], {
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
