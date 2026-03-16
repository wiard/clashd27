'use strict';

const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

function resolveConfiguredPath(candidate, fallback) {
  if (candidate && typeof candidate === 'string') {
    return path.isAbsolute(candidate) ? candidate : path.join(ROOT_DIR, candidate);
  }
  return fallback;
}

function resolveLibraryRoot(options = {}) {
  const configuredRoot = options.libraryRoot
    || process.env.CLASHD27_LIBRARY_ROOT
    || 'data';
  return resolveConfiguredPath(configuredRoot, path.join(ROOT_DIR, 'data'));
}

function resolveLibraryLayout(options = {}) {
  const config = options.config || {};
  const rootDir = resolveLibraryRoot({
    libraryRoot: options.libraryRoot || config.libraryRoot
  });

  return {
    rootDir,
    libraryFile: resolveConfiguredPath(options.libraryFile || config.libraryFile, path.join(rootDir, 'gap-library.jsonl')),
    indexFile: resolveConfiguredPath(options.indexFile || config.libraryIndexFile || config.indexFile, path.join(rootDir, 'gap-library-index.json')),
    domainsDir: resolveConfiguredPath(options.domainsDir || config.domainsDir, path.join(rootDir, 'domains')),
    reportsDir: resolveConfiguredPath(options.runReportsDir || config.runReportsDir, path.join(rootDir, 'library-runs')),
    exportsDir: resolveConfiguredPath(options.exportsDir || config.exportsDir, path.join(rootDir, 'exports')),
    logsDir: resolveConfiguredPath(options.logsDir || config.logsDir, path.join(rootDir, 'logs')),
    stateFile: resolveConfiguredPath(options.stateFile || config.stateFile, path.join(rootDir, 'nightly-reader-cube-state.json')),
    backupDir: resolveConfiguredPath(
      options.backupDir || config.backupDir || process.env.CLASHD27_LIBRARY_BACKUP_DIR,
      path.join(ROOT_DIR, 'backups')
    )
  };
}

module.exports = {
  ROOT_DIR,
  resolveConfiguredPath,
  resolveLibraryLayout,
  resolveLibraryRoot
};
