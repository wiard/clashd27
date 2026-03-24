'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_VIVANT_DIR = path.join(ROOT_DIR, 'data', 'vivant');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

// ─── Constanten ──────────────────────────────────────────
// Spec gebruikt 1-based indexing: "cel 14" = center (1,1,1)
// In code: 0-based index 13
const CEL_14_INDEX = 13;
const BUUR_INDICES = [4, 10, 12, 14, 16, 22]; // 0-based
const LOG2_6 = Math.log2(6); // ≈ 2.585

const BUUR_LABELS = {
  4: 'verleden',
  10: 'structuur',
  12: 'domein A',
  14: 'domein B',
  16: 'evidentie',
  22: 'toekomst'
};

// ─── Fasen ───────────────────────────────────────────────
const ENTROPIE_FASEN = {
  KRISTALLISATIE: 'kristallisatie',
  KALIBRERING: 'kalibrering',
  SPANNING: 'spanning',
  KRITIEK: 'kritiek',
  PULSE: 'pulse',
  NIEUWE_ORDE: 'nieuwe orde'
};

function classificeerEntropieFase(hNorm, vorigePulse) {
  if (vorigePulse) return ENTROPIE_FASEN.NIEUWE_ORDE;
  if (hNorm > 0.85) return ENTROPIE_FASEN.PULSE;
  if (hNorm > 0.75) return ENTROPIE_FASEN.KRITIEK;
  if (hNorm > 0.5) return ENTROPIE_FASEN.SPANNING;
  if (hNorm > 0.2) return ENTROPIE_FASEN.KALIBRERING;
  return ENTROPIE_FASEN.KRISTALLISATIE;
}

// ─── Shannon entropie ────────────────────────────────────
// Berekent Shannon entropy over de distributie van patronen
// onder de 6 buren van cel 14.
//
// Als alle 6 buren hetzelfde patroon delen → H = 0 (emergentie)
// Als alle 6 buren een ander patroon dragen → H = log2(6) ≈ 2.585
function berekenShannonEntropie(patronen) {
  if (!Array.isArray(patronen) || patronen.length === 0) return 0;

  const counts = {};
  for (const p of patronen) {
    const key = String(p || 'onbekend').toLowerCase().trim();
    counts[key] = (counts[key] || 0) + 1;
  }

  const total = patronen.length;
  let H = 0;
  for (const count of Object.values(counts)) {
    const p = count / total;
    if (p > 0) {
      H -= p * Math.log2(p);
    }
  }

  return round(H);
}

function normaliseerEntropie(H) {
  if (LOG2_6 === 0) return 0;
  return round(Math.min(1, Math.max(0, H / LOG2_6)));
}

// ─── Buur signalen extraheren ────────────────────────────
// Haalt uit een cube snapshot de 6 buurcellen van cel 14
// en retourneert per buur het sterkste patroon + confidence
function extractBuurSignalen(cells) {
  if (!Array.isArray(cells)) return [];

  return BUUR_INDICES.map((idx) => {
    const cell = cells[idx];
    if (!cell) {
      return {
        celIndex: idx,
        label: BUUR_LABELS[idx] || `cel ${idx + 1}`,
        patroon: 'leeg',
        confidence: 0,
        domein: 'onbekend'
      };
    }
    return {
      celIndex: idx,
      label: BUUR_LABELS[idx] || `cel ${idx + 1}`,
      patroon: String(cell.domain || cell.label || 'onbekend').toLowerCase().trim(),
      confidence: round(Number(cell.score) || 0),
      domein: String(cell.domain || 'concept')
    };
  });
}

// ─── Entropie meting per run ─────────────────────────────
function meetEntropie(cells, runId, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const threshold = options.threshold || 0.85;
  const vorigePulse = options.vorigePulse || false;

  const buurSignalen = extractBuurSignalen(cells);
  const patronen = buurSignalen.map((s) => s.patroon);
  const H = berekenShannonEntropie(patronen);
  const genormaliseerd = normaliseerEntropie(H);
  const pulsGevuurd = genormaliseerd > threshold;
  const fase = classificeerEntropieFase(genormaliseerd, vorigePulse);

  return {
    runId,
    timestamp,
    H,
    genormaliseerd,
    fase,
    buurSignalen,
    threshold,
    pulsGevuurd
  };
}

// ─── Persistentie ────────────────────────────────────────
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function slaEntropieOp(meting, vivantDir) {
  const dir = vivantDir || DEFAULT_VIVANT_DIR;
  const entropieFile = path.join(dir, 'entropie.jsonl');
  const historyFile = path.join(dir, 'entropie-history.json');

  ensureDir(entropieFile);
  fs.appendFileSync(entropieFile, JSON.stringify(meting) + '\n');

  // Update history: laatste 50 runs
  let history = [];
  if (fs.existsSync(historyFile)) {
    try {
      history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch (_) {
      history = [];
    }
  }
  history.push(meting);
  if (history.length > 50) {
    history = history.slice(-50);
  }
  ensureDir(historyFile);
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

  return { entropieFile, historyFile };
}

function laadEntropieHistory(vivantDir) {
  const dir = vivantDir || DEFAULT_VIVANT_DIR;
  const historyFile = path.join(dir, 'entropie-history.json');
  if (!fs.existsSync(historyFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function laatsteEntropie(vivantDir) {
  const history = laadEntropieHistory(vivantDir);
  return history.length > 0 ? history[history.length - 1] : null;
}

module.exports = {
  CEL_14_INDEX,
  BUUR_INDICES,
  BUUR_LABELS,
  LOG2_6,
  ENTROPIE_FASEN,
  berekenShannonEntropie,
  normaliseerEntropie,
  classificeerEntropieFase,
  extractBuurSignalen,
  meetEntropie,
  slaEntropieOp,
  laadEntropieHistory,
  laatsteEntropie
};
