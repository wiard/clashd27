'use strict';

const {
  CEL_14_INDEX,
  BUUR_INDICES,
  BUUR_LABELS,
  berekenShannonEntropie,
  normaliseerEntropie,
  extractBuurSignalen,
  meetEntropie
} = require('./entropie');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

// ─── Diagonale paren (0-based) ───────────────────────────
// Tegenoverliggende buren door cel 14:
//   cel 5 ↔ cel 23 (1-based) = 4 ↔ 22 (verleden ↔ toekomst)
//   cel 13 ↔ cel 15 (1-based) = 12 ↔ 14 (domein A ↔ domein B)
//   cel 11 ↔ cel 17 (1-based) = 10 ↔ 16 (structuur ↔ evidentie)
const DIAGONALE_PAREN = [
  { a: 4, b: 22, label: 'verleden-toekomst' },
  { a: 12, b: 14, label: 'domein-a-domein-b' },
  { a: 10, b: 16, label: 'structuur-evidentie' }
];

// ─── Vlakken door cel 14 (0-based) ──────────────────────
const VLAKKEN = {
  XY: [3, 4, 5, 12, 13, 14, 21, 22, 23],
  XZ: [1, 4, 7, 10, 13, 16, 19, 22, 25],
  YZ: [9, 10, 11, 12, 13, 14, 15, 16, 17]
};

// ─── Collision Detectie ──────────────────────────────────
function detecteerCollisions(cells, runId, options = {}) {
  const buurSignalen = extractBuurSignalen(cells);
  const patronen = buurSignalen.map((s) => s.patroon);
  const entropieMeting = meetEntropie(cells, runId, options);

  const collisions = [];

  // Tel patronen
  const patternCounts = {};
  for (const p of patronen) {
    patternCounts[p] = (patternCounts[p] || 0) + 1;
  }

  // Emergentie: 5-6 buren zelfde patroon
  for (const [patroon, count] of Object.entries(patternCounts)) {
    if (count >= 5) {
      const bronCellen = buurSignalen.filter((s) => s.patroon === patroon).map((s) => s.celIndex);
      const confidence = buurSignalen.filter((s) => s.patroon === patroon).reduce((s, c) => s + c.confidence, 0) / count;
      collisions.push({
        runId,
        type: 'emergentie',
        patroon,
        bronCellen,
        richtingen: count,
        sterkte: 0.85,
        novelty: round(1 - confidence),
        domeinen: Array.from(new Set(buurSignalen.filter((s) => s.patroon === patroon).map((s) => s.domein))),
        entropie: entropieMeting.H,
        expansie: false
      });
    }
  }

  // Directe botsing: 2-3 buren zelfde patroon
  for (const [patroon, count] of Object.entries(patternCounts)) {
    if (count >= 2 && count <= 3) {
      const bronCellen = buurSignalen.filter((s) => s.patroon === patroon).map((s) => s.celIndex);
      const avgConf = buurSignalen.filter((s) => s.patroon === patroon).reduce((s, c) => s + c.confidence, 0) / count;
      const baseSterkte = count === 2 ? 0.4 : 0.55;
      const sterkte = round(Math.min(1, baseSterkte + avgConf * 0.15));

      collisions.push({
        runId,
        type: 'collision',
        patroon,
        bronCellen,
        richtingen: count,
        sterkte,
        novelty: round(1 - avgConf),
        domeinen: Array.from(new Set(buurSignalen.filter((s) => s.patroon === patroon).map((s) => s.domein))),
        entropie: entropieMeting.H,
        expansie: false
      });
    }
  }

  // Diagonale resonantie: tegenoverliggende paren
  for (const paar of DIAGONALE_PAREN) {
    const signaalA = buurSignalen.find((s) => s.celIndex === paar.a);
    const signaalB = buurSignalen.find((s) => s.celIndex === paar.b);
    if (signaalA && signaalB && signaalA.patroon === signaalB.patroon && signaalA.patroon !== 'leeg') {
      const avgConf = (signaalA.confidence + signaalB.confidence) / 2;
      const baseSterkte = 0.4 + avgConf * 0.15;
      const sterkte = round(Math.min(1, baseSterkte * 1.8));

      collisions.push({
        runId,
        type: 'resonantie',
        patroon: signaalA.patroon,
        bronCellen: [paar.a, paar.b],
        richtingen: 2,
        sterkte,
        novelty: round(1 - avgConf),
        domeinen: Array.from(new Set([signaalA.domein, signaalB.domein])),
        entropie: entropieMeting.H,
        expansie: false
      });
    }
  }

  // Vlaktransformatie: zelfde patroon in 2+ vlakken
  if (Array.isArray(cells)) {
    const vlakPatronen = {};
    for (const [vlakNaam, indices] of Object.entries(VLAKKEN)) {
      const vlakCells = indices.filter((i) => i !== CEL_14_INDEX).map((i) => cells[i]).filter(Boolean);
      for (const cell of vlakCells) {
        const p = String(cell.domain || cell.label || 'onbekend').toLowerCase().trim();
        if (!vlakPatronen[p]) vlakPatronen[p] = new Set();
        vlakPatronen[p].add(vlakNaam);
      }
    }

    for (const [patroon, vlakken] of Object.entries(vlakPatronen)) {
      if (vlakken.size >= 2 && patroon !== 'concept' && patroon !== 'onbekend' && patroon !== 'leeg') {
        const bronCellen = [];
        for (const [vlakNaam, indices] of Object.entries(VLAKKEN)) {
          if (!vlakken.has(vlakNaam)) continue;
          for (const idx of indices) {
            if (idx === CEL_14_INDEX) continue;
            const cell = cells[idx];
            if (cell && String(cell.domain || cell.label || '').toLowerCase().trim() === patroon) {
              if (!bronCellen.includes(idx)) bronCellen.push(idx);
            }
          }
        }

        const sterkte = round(Math.min(1, 0.5 * 2.0));

        collisions.push({
          runId,
          type: 'vlak',
          patroon,
          bronCellen,
          richtingen: vlakken.size,
          sterkte,
          novelty: round(0.5),
          domeinen: [patroon],
          entropie: entropieMeting.H,
          expansie: false
        });
      }
    }
  }

  // Sorteer op sterkte (sterkste eerst)
  collisions.sort((a, b) => b.sterkte - a.sterkte);

  return {
    entropie: entropieMeting,
    collisions,
    sterksteCollision: collisions.length > 0 ? collisions[0] : null
  };
}

// ─── Pulse en Expansie ───────────────────────────────────
function verwerkPulse(cells, runId, entropieMeting, collisions) {
  if (!entropieMeting.pulsGevuurd) return null;

  const timestamp = new Date().toISOString();

  // Zoek nieuwe verbindingen: patronen die in meerdere niet-aangrenzende cellen voorkomen
  const patternCells = {};
  if (Array.isArray(cells)) {
    for (let i = 0; i < cells.length; i += 1) {
      if (!cells[i]) continue;
      const p = String(cells[i].domain || cells[i].label || '').toLowerCase().trim();
      if (p && p !== 'concept' && p !== 'onbekend') {
        if (!patternCells[p]) patternCells[p] = [];
        patternCells[p].push(i);
      }
    }
  }

  const nieuwVerbindingen = [];
  for (const [patroon, indices] of Object.entries(patternCells)) {
    if (indices.length >= 2) {
      nieuwVerbindingen.push({
        patroon,
        cellen: indices,
        sterkte: round(indices.length / 27)
      });
    }
  }

  // Bereken expansieSterkte uit gemiddelde collision sterkte
  const avgSterkte = collisions.length > 0
    ? collisions.reduce((s, c) => s + c.sterkte, 0) / collisions.length
    : 0.5;

  // Entropie na pulse daalt (nieuwe orde)
  const entropieNaPulse = round(entropieMeting.genormaliseerd * 0.4);

  const expansie = {
    runId,
    timestamp,
    entropieVoorPulse: entropieMeting.genormaliseerd,
    entropieNaPulse,
    expansieSterkte: round(avgSterkte),
    nieuwVerbindingen,
    kubusFase: 'expanderend'
  };

  // Markeer sterkste collision als pulse met expansie
  const pulseSignal = {
    runId,
    type: 'pulse',
    patroon: collisions.length > 0 ? collisions[0].patroon : 'systeempulse',
    bronCellen: BUUR_INDICES.slice(),
    richtingen: 6,
    sterkte: round(Math.min(1, avgSterkte * 1.5)),
    novelty: round(nieuwVerbindingen.length / Math.max(1, Object.keys(patternCells).length)),
    domeinen: Array.from(new Set(collisions.flatMap((c) => c.domeinen))),
    entropie: entropieMeting.H,
    expansie: true
  };

  return { expansie, pulseSignal };
}

// ─── Volledige cel 14 verwerking ─────────────────────────
function verwerkCel14(cells, runId, options = {}) {
  const { entropie, collisions, sterksteCollision } = detecteerCollisions(cells, runId, options);
  const pulseResult = verwerkPulse(cells, runId, entropie, collisions);

  return {
    entropie,
    collisions,
    sterksteCollision,
    pulse: pulseResult ? pulseResult.pulseSignal : null,
    expansie: pulseResult ? pulseResult.expansie : null,
    pulsGevuurd: entropie.pulsGevuurd
  };
}

module.exports = {
  CEL_14_INDEX,
  BUUR_INDICES,
  DIAGONALE_PAREN,
  VLAKKEN,
  detecteerCollisions,
  verwerkPulse,
  verwerkCel14
};
