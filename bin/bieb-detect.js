#!/usr/bin/env node
'use strict';

const { GapLibrary } = require('../src/library/gap-library');
const { detectBeloftes } = require('../src/bieb/belofte-detector');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');

const library = new GapLibrary();
const allGaps = library.query({ limit: 9999 });
console.log(`[BIEB] Loaded ${allGaps.length} gaps from library`);

const candidates = detectBeloftes(allGaps);
console.log(`[BIEB] Detected ${candidates.length} belofte candidates`);

const bieb = new BeloofteLibrary();
let newCount = 0;
let confirmedCount = 0;

for (const candidate of candidates) {
  const result = bieb.addOrUpdate(candidate, 'manual-detect');
  if (result.isNew) newCount += 1;
  else confirmedCount += 1;
}

console.log(`[BIEB] Stored: ${newCount} new, ${confirmedCount} confirmed`);

const stats = bieb.stats();
console.log(`[BIEB] Total beloftes: ${stats.totalBeloftes}`);
console.log(`[BIEB] By type:`, JSON.stringify(stats.byType));

if (stats.topBeloftes.length > 0) {
  console.log(`[BIEB] Top belofte: ${stats.topBeloftes[0].titel} (score: ${stats.topBeloftes[0].score})`);
}
