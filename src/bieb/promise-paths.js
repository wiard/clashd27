'use strict';

const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_PROMISE_DIR = path.join(ROOT_DIR, 'data', 'promise-library');
const DEFAULT_GAP_LIBRARY_PATH = path.join(ROOT_DIR, 'data', 'gap-library.jsonl');
const LEGACY_BIEB_DIR = path.join(ROOT_DIR, 'data', 'bieb');

function resolvePromiseLibraryLayout(options = {}) {
  const rootDir = options.rootDir || DEFAULT_PROMISE_DIR;
  return {
    rootDir,
    beloftesFile: options.beloftesFile || path.join(rootDir, 'beloftes.jsonl'),
    latestCubeFile: options.latestCubeFile || path.join(rootDir, 'latest-cube.json'),
    runsFile: options.runsFile || path.join(rootDir, 'runs.jsonl'),
    exportsDir: options.exportsDir || path.join(rootDir, 'exports'),
    legacyBeloftesFile: options.legacyBeloftesFile || path.join(LEGACY_BIEB_DIR, 'beloftes.jsonl')
  };
}

module.exports = {
  DEFAULT_GAP_LIBRARY_PATH,
  resolvePromiseLibraryLayout
};
