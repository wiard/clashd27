#!/usr/bin/env node
'use strict';

const { Vivant } = require('../src/bieb/vivant');

function barChart(value, width = 10) {
  const filled = Math.round(value * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function trendArrow(trend) {
  if (trend === 'nauwer') return '\u2191 nauwer';
  if (trend === 'herleeft') return '\u2191 HERLEEFD (+skip)';
  if (trend === 'vervaagt') return '\u2193 (stilte)';
  return '  stabiel';
}

function main() {
  const vivant = new Vivant();
  const topNodes = vivant.topNodes(5);
  const history = vivant.bewegingHistory(20);

  console.log('');
  console.log('\u2550'.repeat(60));
  console.log('  VIVANT \u2014 Gewichtsbeweging');
  console.log('  Het bewegende netwerk zichtbaar gemaakt.');
  console.log('\u2550'.repeat(60));
  console.log('');

  if (topNodes.length === 0) {
    console.log('  Nog geen nodes in het netwerk.');
    console.log('  Voer eerst een run uit: npm run library:run');
    console.log('');
    return;
  }

  for (const node of topNodes) {
    console.log(`Patroon: ${node.patroon}`);
    console.log(`Fase: ${node.fase} | Domeinen: ${(node.domeinen || []).join(', ') || 'geen'}`);
    console.log('');

    const gewichtHistory = node.gewichtHistory || [];

    if (gewichtHistory.length === 0) {
      console.log('  Geen gewichtshistorie beschikbaar.');
    } else {
      // Find the corresponding movement entries for trend info
      const nodeUpdatesPerRun = new Map();
      for (const entry of history) {
        for (const update of (entry.nodeUpdates || [])) {
          if (update.nodeId === node.nodeId) {
            nodeUpdatesPerRun.set(entry.runId, update);
          }
        }
      }

      const runIds = history.map((h) => h.runId);

      for (let i = 0; i < gewichtHistory.length; i += 1) {
        const weight = gewichtHistory[i];
        const runLabel = `Run ${i + 1}`;
        const bar = barChart(weight);

        // Try to find trend for this run
        let trendInfo = '';
        if (i < runIds.length) {
          const update = nodeUpdatesPerRun.get(runIds[i]);
          if (update) {
            trendInfo = trendArrow(update.trend);
          }
        }

        console.log(`${runLabel.padStart(6)}:  ${bar} ${weight.toFixed(2)} ${trendInfo}`);
      }
    }

    console.log('');
    console.log('\u2500'.repeat(60));
    console.log('');
  }

  console.log('"Niet alles bewaren. Het juiste selecteren."');
  console.log('');
}

main();
