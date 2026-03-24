#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { laadEntropieHistory, laatsteEntropie, BUUR_LABELS } = require('../src/bieb/entropie');
const { ConfiguratieMemorie } = require('../src/bieb/configuratie-memorie');

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function sparkline(values) {
  const chars = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
  if (values.length === 0) return '';
  const max = Math.max(...values, 0.01);
  return values.map((v) => {
    const idx = Math.min(7, Math.floor((v / max) * 7));
    return chars[idx];
  }).join('');
}

function main() {
  const history = laadEntropieHistory();
  const laatste = laatsteEntropie();
  const confMemorie = new ConfiguratieMemorie();
  const confStats = confMemorie.stats();
  const topConf = confMemorie.topConfiguraties(1);

  console.log('');
  console.log('\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  CLASHD27 \u2014 Entropie Engine                               \u2551');
  console.log('\u2551  Cel 14 \u00b7 Centrale kracht \u00b7 Richting bewustzijn           \u2551');
  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');

  if (laatste) {
    console.log(`\u2551  Huidige entropie:  ${pad(laatste.H.toFixed(3), 8)} Fase: ${pad(laatste.fase, 17)}\u2551`);
    console.log(`\u2551  Threshold:         ${pad('0.85', 8)} Pulse gevuurd: ${pad(laatste.pulsGevuurd ? 'ja' : 'nee', 10)}\u2551`);
    const hasEmergentie = laatste.buurSignalen
      ? (() => { const counts = {}; laatste.buurSignalen.forEach((s) => { counts[s.patroon] = (counts[s.patroon] || 0) + 1; }); return Object.values(counts).some((c) => c >= 5); })()
      : false;
    console.log(`\u2551  Emergentie:        ${pad(hasEmergentie ? 'ja' : 'nee', 37)}\u2551`);
  } else {
    console.log('\u2551  Nog geen entropie metingen beschikbaar.                  \u2551');
  }

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  CEL 14 BUREN                                             \u2551');

  if (laatste && laatste.buurSignalen) {
    for (const signaal of laatste.buurSignalen) {
      const buurLabel = BUUR_LABELS[signaal.celIndex] || `cel ${signaal.celIndex + 1}`;
      const celNum = signaal.celIndex + 1; // 1-based for display
      console.log(`\u2551  Cel ${pad(celNum, 3)} (${pad(buurLabel, 11)}): ${pad(signaal.patroon, 14)} \u2014 conf ${pad(signaal.confidence.toFixed(2), 5)}\u2551`);
    }
  } else {
    console.log('\u2551  Geen buurdata beschikbaar.                               \u2551');
  }

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  ENTROPIE GESCHIEDENIS (laatste 10 runs)                  \u2551');

  const last10 = history.slice(-10);
  if (last10.length > 0) {
    const hNorms = last10.map((h) => h.genormaliseerd);
    const line = sparkline(hNorms);
    const pulseMarkers = last10.map((h) => h.pulsGevuurd ? '\u2605' : '\u2219').join('');
    console.log(`\u2551  ${pad(line, 20)} H_norm                                \u2551`);
    console.log(`\u2551  ${pad(pulseMarkers, 20)} pulse markers                         \u2551`);
  } else {
    console.log('\u2551  Geen geschiedenis beschikbaar.                            \u2551');
  }

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  CONFIGURATIEMEMORIE                                      \u2551');

  if (topConf.length > 0) {
    console.log(`\u2551  Sterkste configuratie: ${pad(topConf[0].configuratieId, 12)} \u2014 gewicht ${pad(topConf[0].gewicht.toFixed(2), 6)}\u2551`);
  } else {
    console.log('\u2551  Nog geen configuraties opgeslagen.                        \u2551');
  }
  console.log(`\u2551  Pulses totaal: ${pad(confStats.totalePulses, 6)} Emergenties totaal: ${pad(confStats.totaleBevestigingen, 8)}\u2551`);

  console.log('\u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563');
  console.log('\u2551  "Entropie is de kracht die ontdekking mogelijk maakt."   \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
}

main();
