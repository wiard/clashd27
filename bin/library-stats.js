#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { loadDomains } = require('../src/domains/domain-config');
const { GapLibrary } = require('../src/library/gap-library');
const { resolveLibraryLayout } = require('../src/library/library-paths');

const LIBRARY_LAYOUT = resolveLibraryLayout();
const LATEST_RUN = `${LIBRARY_LAYOUT.reportsDir}/latest.json`;

function loadLatestRun() {
  if (!fs.existsSync(LATEST_RUN)) return null;
  try {
    return JSON.parse(fs.readFileSync(LATEST_RUN, 'utf8'));
  } catch (_) {
    return null;
  }
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

const library = new GapLibrary();
const stats = library.stats();
const domainStats = library.domainStats();
const latestRun = loadLatestRun();
const today = todayIsoDate();
const risingTrends = library.query({ sortBy: 'trend' }).filter((entry) => entry.scoreTrend === 'rising').length;
const strongSignals = library.query({ minScore: 0.7 }).length;
const configuredDomains = loadDomains();
const crossDomain = library.findCrossDomainGaps({ limit: 5 });

console.log('═══════════════════════════════════════════════');
console.log('  CLASHD27 Gap Library');
console.log('  AI observes. Humans decide.');
console.log('═══════════════════════════════════════════════');
console.log(`  Total gaps:        ${stats.totalGaps}`);
console.log(`  Cross-domain:      ${stats.crossDomain}`);
console.log(`  Strong signals:    ${strongSignals}`);
console.log(`  Rising trends:     ${risingTrends}`);
console.log('');
console.log('  By domain:');
configuredDomains.forEach((domain, index) => {
  const branch = index === configuredDomains.length - 1 ? '└' : '├';
  const current = domainStats[domain.id] || { count: 0, avgScore: 0, strong: 0 };
  console.log(`  ${branch} ${domain.label}:   ${current.count} gaps · avg ${Number(current.avgScore || 0).toFixed(2)} · ${current.strong || 0} strong`);
});
console.log('');
console.log('  Top 5 cross-domain gaps:');
if (crossDomain.length === 0) {
  console.log('  none yet');
} else {
  crossDomain.forEach((gap, index) => {
    const labels = (gap.domainHistory || [])
      .map((entry) => entry.domainLabel || entry.domainId)
      .filter((label, position, list) => label && list.indexOf(label) === position)
      .join(', ');
    console.log(`  ${index + 1}. ${gap.title} — domains: ${labels} — ${gap.score.toFixed(2)}`);
  });
}
console.log('');
if (latestRun) {
  console.log(`  Last run: ${latestRun.completedAtIso}`);
} else {
  console.log('  Last run: none');
}
console.log('  Next run: tonight at 03:00');
console.log('═══════════════════════════════════════════════');
