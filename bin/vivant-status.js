#!/usr/bin/env node
'use strict';

const { Vivant } = require('../src/bieb/vivant');

const FASE_LABELS = {
  opkomend: 'opkomend',
  actief: 'actief',
  gevestigd: 'gevestigd',
  slapend: 'slapend',
  herleefd: 'herleefd'
};

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function main() {
  const vivant = new Vivant();
  const allNodes = vivant.getAllNodes();
  const stats = vivant.stats();
  const laatste = vivant.lastBeweging();

  console.log('');
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  VIVANT \u2014 Het Levende Netwerk                             \u2551');
  console.log('\u2551  Bieb der Beloftes \u00b7 Richting bewustzijn                  \u2551');
  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');

  console.log(`\u2551  Nodes actief:      ${pad(stats.actieveNodes, 6)} Nodes slapend:    ${pad(stats.slapendeNodes, 10)}\u2551`);
  console.log(`\u2551  Gem. gewicht:      ${pad(stats.gemiddeldGewicht.toFixed(3), 6)} Gem. precisie:    ${pad(stats.gemiddeldePrecisie.toFixed(3), 10)}\u2551`);
  console.log(`\u2551  Herlevingens:      ${pad(stats.herleefdeNodes || 0, 6)} Beweging: ${pad(stats.beweging, 17)}\u2551`);

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  STERKSTE NODES (hoogste precisie)                        \u2551');

  const topNodes = vivant.topNodes(5);
  topNodes.forEach((node, index) => {
    const faseLabel = FASE_LABELS[node.fase] || node.fase;
    console.log(`\u2551  ${index + 1}. ${pad(node.patroon, 20)} \u2014 precisie ${node.precisie.toFixed(3)} \u2014 fase: ${pad(faseLabel, 10)}\u2551`);
    console.log(`\u2551     gewicht ${node.gewicht.toFixed(3)} \u2014 ${node.aantalRuns} runs \u2014 ${node.herlevingenCount} herlevingens${' '.repeat(13)}\u2551`);
  });

  if (topNodes.length === 0) {
    console.log('\u2551  Nog geen nodes in het netwerk.                            \u2551');
  }

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  BEWEGING DEZE RUN                                         \u2551');

  if (laatste) {
    const herleefd = laatste.herleefdeNodes || [];
    const vervaagd = laatste.vervaagdeNodes || [];
    const nieuw = laatste.nieuweNodes || [];

    if (herleefd.length > 0) {
      console.log(`\u2551  Herleefd:  ${pad(herleefd.join(', '), 44)}\u2551`);
    }
    if (vervaagd.length > 0) {
      console.log(`\u2551  Vervaagd:  ${pad(vervaagd.join(', '), 44)}\u2551`);
    }
    if (nieuw.length > 0) {
      console.log(`\u2551  Nieuw:     ${pad(nieuw.join(', '), 44)}\u2551`);
    }
    if (herleefd.length === 0 && vervaagd.length === 0 && nieuw.length === 0) {
      console.log('\u2551  Geen beweging in laatste run.                             \u2551');
    }
  } else {
    console.log('\u2551  Geen bewegingsdata beschikbaar.                           \u2551');
  }

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');

  if (laatste && laatste.snapshot) {
    console.log(`\u2551  Laatste run: ${pad(laatste.timestamp || 'onbekend', 42)}\u2551`);
  } else {
    console.log('\u2551  Laatste run: geen                                         \u2551');
  }
  console.log('\u2551  "Niet alles bewaren. Het juiste selecteren."              \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
}

main();
