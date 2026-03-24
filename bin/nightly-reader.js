#!/usr/bin/env node
'use strict';

const { parseArgs, runNightlyReader } = require('../src/scheduler/nightly-reader');

const cliOptions = parseArgs(process.argv.slice(2));

runNightlyReader(cliOptions).then(({ report, reportPath }) => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  CLASHD27 — Nightly Gap Discovery Run');
  console.log('  A permanent library of what AI frameworks are missing.');
  console.log('  AI observes. Humans decide.');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Tonight: reading ${report.totals.papersAnalyzed} papers across ${report.domains.length} domains.`);
  console.log('  Every gap found will be stored permanently.');
  console.log('  Promising gaps will wait for human approval.');
  console.log('═══════════════════════════════════════════════════');
  console.log(`Run report: ${reportPath}`);
  console.log(`Domains run: ${report.domains.length}`);
  console.log(`Papers analyzed: ${report.totals.papersAnalyzed}`);
  console.log(`Signals normalized: ${report.totals.normalizedSignals}`);
  console.log(`Gaps found: ${report.totals.gapsFound}`);
  console.log(`Cross-domain gaps: ${report.totals.crossDomainGaps}`);
  console.log(`Delivered: ${report.delivery.published}`);
  console.log(`Library size: ${report.totals.librarySize}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
