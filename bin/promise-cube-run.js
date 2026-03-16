#!/usr/bin/env node
'use strict';

const path = require('path');

const { runBelofteCube } = require('../src/bieb/belofte-cube');
const { BeloofteLibrary } = require('../src/bieb/belofte-library');
const { resolvePromiseLibraryLayout, DEFAULT_GAP_LIBRARY_PATH } = require('../src/bieb/promise-paths');

const layout = resolvePromiseLibraryLayout();
const bieb = new BeloofteLibrary(layout);

function padLabel(value, width = 30) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= width) return text.padEnd(width, ' ');
  return `${text.slice(0, width - 1)}…`;
}

function cellsForLayer(cells, layerIndex) {
  return cells
    .filter((cell) => cell.z === layerIndex)
    .sort((left, right) => left.row - right.row || left.column - right.column);
}

function printLayer(cells, layerIndex) {
  const layerName = ['historical', 'current', 'emerging'][layerIndex];
  console.log(`Layer ${layerIndex + 1} (${layerName}):`);
  const layerCells = cellsForLayer(cells, layerIndex);
  for (let row = 0; row < 3; row += 1) {
    const labels = layerCells
      .filter((cell) => cell.row === row)
      .sort((left, right) => left.column - right.column)
      .map((cell) => padLabel(cell.label, 30));
    console.log(labels.join(' | '));
  }
  console.log('');
}

function main() {
  const cubeRun = runBelofteCube({
    gapLibraryPath: DEFAULT_GAP_LIBRARY_PATH,
    maxRealGaps: 27
  });
  const belofteResult = bieb.addOrUpdateBeloftes(cubeRun);
  const libraryStats = bieb.stats();
  const savedRun = {
    ...cubeRun,
    libraryStats,
    beloftes: {
      found: cubeRun.topConstellations.length,
      new: belofteResult.created,
      confirmed: belofteResult.updated
    }
  };
  bieb.saveRun(savedRun);

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  CLASHD27 — Bieb vol Beloftes');
  console.log('  A discovery machine and a permanent gap library.');
  console.log('  AI observes. Humans decide.');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log(`Cube run: ${savedRun.runId}`);
  console.log(`Real gaps loaded: ${savedRun.summary.realGapsLoaded}`);
  console.log(`Fallback concepts used: ${savedRun.summary.fallbackConceptsUsed}`);
  console.log(`Domains represented: ${savedRun.summary.domainsRepresented.join(', ') || 'none'}`);
  console.log('');
  printLayer(savedRun.cells, 0);
  printLayer(savedRun.cells, 1);
  printLayer(savedRun.cells, 2);
  console.log('Top 3 constellations:');
  console.log('');
  savedRun.topConstellations.slice(0, 3).forEach((constellation, index) => {
    console.log(`#${index + 1} — ${constellation.type} — score ${constellation.score.toFixed(3)}`);
    console.log(`Center: ${constellation.centerLabel}`);
    console.log(`Domains: ${constellation.domains.join(', ') || 'none'}`);
    console.log(`Hypothesis: ${constellation.hypothesis}`);
    console.log('');
  });
  console.log(`Saved to: ${path.relative(process.cwd(), layout.rootDir)}/`);
}

main();
