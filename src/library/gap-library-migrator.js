'use strict';

const fs = require('fs');
const path = require('path');

const { GapLibrary } = require('./gap-library');
const { resolveLibraryLayout } = require('./library-paths');

function libraryNeedsMigration(libraryFile = resolveLibraryLayout().libraryFile) {
  if (!fs.existsSync(libraryFile)) return false;
  const lines = fs.readFileSync(libraryFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed.fingerprint) return true;
    } catch (_) {
      return true;
    }
  }

  return false;
}

function readLatestEntries(libraryFile) {
  const latestByLibraryId = new Map();
  const lines = fs.readFileSync(libraryFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const key = String(parsed.libraryId || parsed.gapId || `line-${latestByLibraryId.size}`);
      latestByLibraryId.set(key, parsed);
    } catch (_) {
      // Ignore malformed lines during migration input scan.
    }
  }

  return Array.from(latestByLibraryId.values());
}

async function migrateLibrary(options = {}) {
  const layout = resolveLibraryLayout(options);
  const libraryFile = path.resolve(layout.libraryFile);
  const indexFile = path.resolve(layout.indexFile);
  const domainsDir = path.resolve(layout.domainsDir);

  if (!fs.existsSync(libraryFile)) {
    return {
      migratedEntries: 0,
      mergedDuplicates: 0,
      skipped: true,
      reason: 'library_missing',
      fingerprintedEntries: 0
    };
  }

  const existingEntries = readLatestEntries(libraryFile);
  const v2File = path.join(path.dirname(libraryFile), 'gap-library-v2.jsonl');
  const backupFile = path.join(path.dirname(libraryFile), 'gap-library-v1-backup.jsonl');
  const v2IndexFile = path.join(path.dirname(indexFile), 'gap-library-index-v2.json');
  const v2DomainsDir = path.join(path.dirname(domainsDir), 'domains-v2');

  [v2File, v2IndexFile].forEach((file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  if (fs.existsSync(v2DomainsDir)) {
    fs.rmSync(v2DomainsDir, { recursive: true, force: true });
  }

  const migratedLibrary = new GapLibrary({
    libraryFile: v2File,
    indexFile: v2IndexFile,
    domainsDir: v2DomainsDir
  });

  let mergedDuplicates = 0;
  for (const entry of existingEntries) {
    const result = migratedLibrary.importEntry(entry, {
      runId: entry.lastRunId || null
    });
    if (result.merged) mergedDuplicates += 1;
  }

  if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
  fs.renameSync(libraryFile, backupFile);
  fs.renameSync(v2File, libraryFile);
  if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile);
  fs.renameSync(v2IndexFile, indexFile);
  if (fs.existsSync(domainsDir)) {
    fs.rmSync(domainsDir, { recursive: true, force: true });
  }
  fs.renameSync(v2DomainsDir, domainsDir);

  const finalLibrary = new GapLibrary({
    libraryFile,
    indexFile,
    domainsDir
  });
  const stats = finalLibrary.stats();

  return {
    migratedEntries: existingEntries.length,
    mergedDuplicates,
    skipped: false,
    backupFile,
    libraryFile,
    fingerprintedEntries: stats.fingerprinted,
    totalEntries: stats.totalGaps
  };
}

module.exports = {
  libraryNeedsMigration,
  migrateLibrary
};

if (require.main === module) {
  migrateLibrary().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
