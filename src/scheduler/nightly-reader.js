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
const { detectBeloftes, scoreBelofteCandidate, classifyBelofte } = require('../bieb/belofte-detector');
const { BeloofteLibrary } = require('../bieb/belofte-library');
const { Vivant } = require('../bieb/vivant');
const { meetEntropie, slaEntropieOp, laatsteEntropie } = require('../bieb/entropie');
const { verwerkCel14 } = require('../bieb/cel14');
const { ConfiguratieMemorie } = require('../bieb/configuratie-memorie');

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

  // --- Bieb vol Beloftes: detect cross-domain promises ---
  let belofteReport = { found: 0, new: 0, confirmed: 0, topBelofte: null };
  try {
    const allGaps = library.query({ limit: 9999 });
    const belofteCandidates = detectBeloftes(allGaps);
    const beloofteLibrary = new BeloofteLibrary();
    let newCount = 0;
    let confirmedCount = 0;

    for (const candidate of belofteCandidates) {
      const result = beloofteLibrary.addOrUpdate(candidate, runId);
      if (result.isNew) newCount += 1;
      else confirmedCount += 1;
    }

    const topBeloftes = beloofteLibrary.query({ limit: 1 });
    const topBelofte = topBeloftes.length > 0
      ? { titel: topBeloftes[0].titel, type: topBeloftes[0].type, score: topBeloftes[0].score, domeinen: topBeloftes[0].domeinen }
      : null;

    belofteReport = {
      found: belofteCandidates.length,
      new: newCount,
      confirmed: confirmedCount,
      topBelofte,
      _candidates: belofteCandidates
    };
    console.log(`[NIGHTLY] Beloftes detected: ${belofteReport.found} (${belofteReport.new} new, ${belofteReport.confirmed} confirmed)`);
  } catch (belofteError) {
    console.error(`[NIGHTLY] Belofte detection failed: ${belofteError.message}`);
  }

  // --- VIVANT: update het levende netwerk ---
  let vivantReport = { actieveNodes: 0, herleefdeNodes: 0, sterksteNode: null, beweging: 'stabiel', gemiddeldePrecisie: 0 };
  try {
    const vivant = new Vivant();
    const actievePatronen = [];

    // Patronen uit beloftes
    for (const candidate of (belofteReport._candidates || [])) {
      if (candidate.titel) {
        actievePatronen.push({ patroon: candidate.titel, domeinen: candidate.domeinen || [] });
      }
    }

    // Patronen uit domain resultaten
    for (const result of results) {
      if (result.domainLabel) {
        actievePatronen.push({ patroon: result.domainLabel, domeinen: [result.domainId] });
      }
    }

    if (actievePatronen.length > 0) {
      const snapshot = vivant.updateNetwerk(actievePatronen, runId);
      vivantReport = {
        actieveNodes: snapshot.actieveNodes,
        herleefdeNodes: snapshot.herleefdeNodes,
        sterksteNode: snapshot.sterksteNode ? `${snapshot.sterksteNode.patroon} (precisie ${snapshot.sterksteNode.precisie})` : null,
        beweging: snapshot.beweging,
        gemiddeldePrecisie: snapshot.gemiddeldePrecisie
      };
      console.log(`[NIGHTLY] VIVANT: ${snapshot.actieveNodes} active nodes, ${snapshot.herleefdeNodes} revived, movement: ${snapshot.beweging}`);
    }
  } catch (vivantError) {
    console.error(`[NIGHTLY] VIVANT update failed: ${vivantError.message}`);
  }

  // --- Entropie engine: cel 14 collision detectie ---
  let entropieReport = { H: 0, genormaliseerd: 0, fase: 'kristallisatie', pulsGevuurd: false, emergentie: false, nieuwVerbindingen: 0 };
  try {
    const fs = require('fs');
    const latestCubePath = require('path').join(ROOT_DIR, 'data', 'promise-library', 'latest-cube.json');
    if (fs.existsSync(latestCubePath)) {
      const cubeData = JSON.parse(fs.readFileSync(latestCubePath, 'utf8'));
      const cells = Array.isArray(cubeData.cells) ? cubeData.cells : [];
      const vorigeEntropie = laatsteEntropie();
      const vorigePulse = vorigeEntropie ? vorigeEntropie.pulsGevuurd : false;

      const cel14Result = verwerkCel14(cells, runId, { vorigePulse });
      slaEntropieOp(cel14Result.entropie);

      // Configuratiememorie update
      const confMemorie = new ConfiguratieMemorie();
      const buurPatronen = cel14Result.entropie.buurSignalen.map((s) => s.patroon);
      confMemorie.registreer(buurPatronen, runId);

      if (cel14Result.pulsGevuurd) {
        confMemorie.updatePulse(buurPatronen);
        // Feed pulse to VIVANT
        if (cel14Result.expansie) {
          try {
            const vivant = new Vivant();
            const pulsePatronen = cel14Result.expansie.nieuwVerbindingen.map((v) => ({
              patroon: v.patroon,
              domeinen: [v.patroon]
            }));
            if (pulsePatronen.length > 0) {
              vivant.updateNetwerk(pulsePatronen, `${runId}-pulse`);
            }
          } catch (_) { /* VIVANT pulse feed is best-effort */ }
        }
      } else if (cel14Result.collisions.length > 0 && cel14Result.collisions[0].sterkte > 0.5) {
        confMemorie.updateBevestiging(buurPatronen);
      }

      const hasEmergentie = cel14Result.collisions.some((c) => c.type === 'emergentie');

      entropieReport = {
        H: cel14Result.entropie.H,
        genormaliseerd: cel14Result.entropie.genormaliseerd,
        fase: cel14Result.entropie.fase,
        pulsGevuurd: cel14Result.pulsGevuurd,
        emergentie: hasEmergentie,
        nieuwVerbindingen: cel14Result.expansie ? cel14Result.expansie.nieuwVerbindingen.length : 0,
        collisions: cel14Result.collisions.length,
        sterksteCollision: cel14Result.sterksteCollision ? cel14Result.sterksteCollision.type : null
      };

      console.log(`[NIGHTLY] Entropie: H=${cel14Result.entropie.H} fase=${cel14Result.entropie.fase} pulse=${cel14Result.pulsGevuurd}`);
    }
  } catch (entropieError) {
    console.error(`[NIGHTLY] Entropie engine failed: ${entropieError.message}`);
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
    delivery,
    beloftes: belofteReport,
    vivant: vivantReport,
    entropie: entropieReport
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
