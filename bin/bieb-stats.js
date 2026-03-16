#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');
const { TYPE_LABELS } = require('../src/bieb/belofte');
const { resolveLibraryLayout } = require('../src/library/library-paths');
const { resolvePromiseLibraryLayout } = require('../src/bieb/promise-paths');
const { loadAanhaakpunten, computeBuffer } = require('../src/bieb/aanhaakpunt');

const LIBRARY_LAYOUT = resolveLibraryLayout();
const LATEST_RUN = path.join(LIBRARY_LAYOUT.reportsDir, 'latest.json');
const PROMISE_LAYOUT = resolvePromiseLibraryLayout();

function loadLatestRun() {
  if (!fs.existsSync(LATEST_RUN)) return null;
  try {
    return JSON.parse(fs.readFileSync(LATEST_RUN, 'utf8'));
  } catch (_) {
    return null;
  }
}

const bieb = new BeloofteLibrary(PROMISE_LAYOUT);
const stats = bieb.stats();
const latestRun = loadLatestRun();

const byType = stats.byType || {};
const verborgen = byType.verborgen_verbinding || 0;
const gemist = byType.gemiste_innovatie || 0;
const herhalend = byType.herhalende_probleemstructuur || 0;
const serendipiteit = byType.serendipiteit || 0;
const crossDomein = byType.cross_domein_botsing || 0;

console.log('');
console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('  Bieb vol Beloftes');
console.log('  A library of what could be discovered next.');
console.log('  AI observes. Humans decide.');
console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('');
console.log(`  Totaal beloftes:       ${stats.totalBeloftes}`);
console.log(`  Verborgen verbanden:   ${verborgen}`);
console.log(`  Gemiste innovaties:    ${gemist}`);
console.log(`  Herhalende structuren: ${herhalend}`);
console.log(`  Serendipiteit:         ${serendipiteit}`);
console.log(`  Cross-domain:          ${crossDomein}`);
console.log('');

if (stats.topBeloftes && stats.topBeloftes.length > 0) {
  console.log('  Sterkste beloftes:');
  stats.topBeloftes.slice(0, 3).forEach((belofte, index) => {
    const typeLabel = TYPE_LABELS[belofte.type] || belofte.type;
    const domeinen = belofte.domeinen.join(', ');
    console.log(`  ${index + 1}. ${belofte.titel} \u2014 ${typeLabel} \u2014 score ${belofte.score.toFixed(3)} \u2014 domeinen: ${domeinen}`);
  });
  console.log('');
}

const aanhaakpunten = loadAanhaakpunten();
if (aanhaakpunten.length > 0) {
  console.log('  Sterkste aanhaakpunten (brugwoorden):');
  aanhaakpunten.slice(0, 3).forEach((ap, index) => {
    const domeinCount = ap.domeinen.length;
    console.log(`  ${index + 1}. ${ap.woord} \u2014 ${domeinCount} domeinen \u2014 gewicht ${ap.gewicht.toFixed(1)} \u2014 buffer ${ap.buffer.toFixed(2)}`);
  });
  console.log('');
}

if (latestRun && latestRun.beloftes) {
  console.log(`  Laatste run: ${latestRun.completedAtIso}`);
  console.log(`  Beloftes gevonden: ${latestRun.beloftes.found} (${latestRun.beloftes.new} nieuw, ${latestRun.beloftes.confirmed} bevestigd)`);
} else if (stats.lastRunAt) {
  console.log(`  Laatste run: ${stats.lastRunAt}`);
  console.log(`  Totaal cube-runs: ${stats.totalRuns}`);
} else if (latestRun) {
  console.log(`  Laatste run: ${latestRun.completedAtIso}`);
} else {
  console.log('  Laatste run: none');
}

console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
