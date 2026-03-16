'use strict';

const fs = require('fs');
const path = require('path');

const nightlyConfig = require('../../config/nightly-reader.json');
const { Clashd27CubeEngine } = require('../../lib/clashd27-cube-engine');
const { publishGapProposalHandoffs } = require('../../lib/v2-knowledge-publisher');
const { loadDomains } = require('../domains/domain-config');
const { runDomainCycle } = require('../domains/domain-runner');
const { GapLibrary } = require('../library/gap-library');
const { libraryNeedsMigration, migrateLibrary } = require('../library/gap-library-migrator');
const { resolveLibraryLayout, resolveConfiguredPath } = require('../library/library-paths');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG = nightlyConfig.nightlyReader || {};

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function toAbsolute(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(ROOT_DIR, filePath);
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--domain' && argv[index + 1]) {
      options.domainId = argv[index + 1];
      index += 1;
    } else if (token === '--papers-per-query' && argv[index + 1]) {
      options.papersPerQuery = Number(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentGapRegistry(gatewayUrl, token) {
  if (!gatewayUrl || !token || typeof fetch !== 'function') {
    return [];
  }
  const response = await fetch(`${gatewayUrl.replace(/\/$/, '')}/api/gaps`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    return [];
  }
  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.gaps) ? data.gaps : [];
}

async function runNightlyReader(options = {}) {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const runId = options.runId || `nightly-${timestampId(startedAt)}`;

  const libraryLayout = resolveLibraryLayout({
    config: DEFAULT_CONFIG,
    libraryRoot: options.libraryRoot,
    libraryFile: options.libraryFile,
    indexFile: options.indexFile,
    domainsDir: options.domainsDir,
    runReportsDir: options.runReportsDir,
    stateFile: options.stateFile,
    exportsDir: options.exportsDir
  });
  const stateFile = libraryLayout.stateFile;
  const libraryFile = libraryLayout.libraryFile;
  const indexFile = libraryLayout.indexFile;
  const reportsDir = libraryLayout.reportsDir;
  const domainsDir = libraryLayout.domainsDir;
  const domains = options.domains || loadDomains({
    configFile: resolveConfiguredPath(options.domainsConfigFile || DEFAULT_CONFIG.domainsConfigFile, toAbsolute('config/domains.json')),
    domainId: options.domainId
  });

  ensureDir(path.dirname(stateFile));
  ensureDir(reportsDir);
  ensureDir(domainsDir);

  if (options.resetState === true && fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }

  const cubeEngine = options.cubeEngine || new Clashd27CubeEngine({
    stateFile
  });
  const migration = options.library
    ? { skipped: true, migratedEntries: 0, mergedDuplicates: 0, fingerprintedEntries: 0, reason: 'external_library_supplied' }
    : libraryNeedsMigration(libraryFile)
    ? await migrateLibrary({
      libraryFile,
      indexFile,
      domainsDir
    })
    : { skipped: true, migratedEntries: 0, mergedDuplicates: 0, fingerprintedEntries: 0 };
  const library = options.library || new GapLibrary({
    libraryFile,
    indexFile,
    domainsDir
  });

  const librarySizeBefore = library.stats().totalGaps;
  const results = [];
  const handoffsToPublish = [];

  console.log(`[NIGHTLY] Run ${runId} starting`);
  console.log(`[NIGHTLY] Domains: ${domains.map((domain) => domain.label).join(', ')}`);

  for (const domain of domains) {
    try {
      // Domain runner owns gap-library writes after each domain discovery cycle completes.
      const result = await runDomainCycle(domain, cubeEngine, {
        runId,
        papersPerQuery: Number.isFinite(options.papersPerQuery) ? options.papersPerQuery : 100,
        tick: Date.now(),
        library,
        fetchPapers: options.fetchPapers,
        normalizeQueue: options.normalizeQueue,
        runDiscoveryCycle: options.runDiscoveryCycle,
        referenceTime: startedAtIso
      });
      results.push(result);
      handoffsToPublish.push(...result.handoffs);
    } catch (error) {
      console.error(`[NIGHTLY] Domain ${domain.id} failed: ${error.message}`);
      results.push({
        domainId: domain.id,
        domainLabel: domain.label,
        papersAnalyzed: 0,
        signalsGenerated: 0,
        normalizedSignals: 0,
        gapsFound: 0,
        handoffs: [],
        error: error.message
      });
    }
  }

  const gatewayUrl = options.gatewayUrl || process.env.OPENCLASHD_GATEWAY_URL || process.env.OPENCLASHD_V2_URL;
  const token = options.token || process.env.OPENCLASHD_TOKEN;
  let delivery = {
    published: 0,
    deduped: 0,
    skipped: handoffsToPublish.length,
    failed: 0,
    results: []
  };

  if (gatewayUrl && token && handoffsToPublish.length > 0) {
    delivery = await publishGapProposalHandoffs(handoffsToPublish, {
      gatewayUrl,
      token
    });
    await sleep(250);
    const gaps = await fetchCurrentGapRegistry(gatewayUrl, token).catch(() => []);
    const relevant = gaps
      .filter((gap) => handoffsToPublish.some((handoff) => handoff.packetId === gap.sourcePacketId))
      .map((gap) => ({
        packetId: gap.sourcePacketId,
        sourcePacketId: gap.sourcePacketId,
        gapId: gap.gapId,
        status: gap.status,
        approvedAt: gap.approvedAtIso || null,
        deniedAt: gap.deniedAtIso || null
      }));
    if (relevant.length > 0) {
      library.recordHandoffs(relevant);
    }
  }

  const stats = library.stats();
  const crossDomain = library.findCrossDomainGaps({ limit: 5 });
  const report = {
    runId,
    startedAtIso,
    completedAtIso: new Date().toISOString(),
    libraryRoot: libraryLayout.rootDir,
    domains: results.map((result) => ({
      id: result.domainId,
      label: result.domainLabel,
      papers: result.papersAnalyzed,
      signals: result.normalizedSignals,
      gaps: result.gapsFound,
      handoffs: Array.isArray(result.handoffs) ? result.handoffs.length : 0,
      error: result.error || null
    })),
    totals: {
      papersAnalyzed: results.reduce((sum, result) => sum + (result.papersAnalyzed || 0), 0),
      signalsGenerated: results.reduce((sum, result) => sum + (result.signalsGenerated || 0), 0),
      normalizedSignals: results.reduce((sum, result) => sum + (result.normalizedSignals || 0), 0),
      gapsFound: results.reduce((sum, result) => sum + (result.gapsFound || 0), 0),
      handoffsPrepared: handoffsToPublish.length,
      crossDomainGaps: crossDomain.length,
      librarySize: stats.totalGaps,
      libraryGrowth: stats.totalGaps - librarySizeBefore
    },
    migration,
    topGaps: library.query({ limit: 10, sortBy: 'score' }),
    crossDomainGaps: crossDomain,
    delivery
  };

  const reportPath = path.join(reportsDir, `run-${timestampId(new Date())}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(reportsDir, 'latest.json'), JSON.stringify(report, null, 2));

  console.log(`[NIGHTLY] Complete.`);
  console.log(`[NIGHTLY] Papers analyzed: ${report.totals.papersAnalyzed}`);
  console.log(`[NIGHTLY] Gaps found: ${report.totals.gapsFound}`);
  console.log(`[NIGHTLY] Cross-domain gaps: ${report.totals.crossDomainGaps}`);
  console.log(`[NIGHTLY] Library size: ${report.totals.librarySize}`);
  console.log(`[NIGHTLY] Report saved: ${reportPath}`);

  return {
    report,
    reportPath,
    results,
    topGaps: report.topGaps,
    crossDomainGaps: report.crossDomainGaps
  };
}

module.exports = {
  fetchCurrentGapRegistry,
  parseArgs,
  runNightlyReader
};
