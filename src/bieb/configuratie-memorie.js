'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_VIVANT_DIR = path.join(ROOT_DIR, 'data', 'vivant');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

// ─── Configuratie vingerafdruk ───────────────────────────
// Hash van de buurpatronen rond cel 14
function configuratieFingerprint(buurPatronen) {
  const canonical = (buurPatronen || [])
    .map((p) => String(p || '').toLowerCase().trim())
    .join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// ─── Softmax ─────────────────────────────────────────────
function softmax(gewichten) {
  if (gewichten.length === 0) return [];
  const maxW = Math.max(...gewichten);
  const exps = gewichten.map((w) => Math.exp(w - maxW));
  const sum = exps.reduce((s, e) => s + e, 0);
  return exps.map((e) => round(e / sum));
}

// ─── Configuratiememorie ─────────────────────────────────
class ConfiguratieMemorie {
  constructor(options = {}) {
    this.vivantDir = options.vivantDir || DEFAULT_VIVANT_DIR;
    this.memorieFile = options.memorieFile || path.join(this.vivantDir, 'configuratie-memorie.json');
    this._configuraties = new Map();
    this._load();
  }

  _ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  _load() {
    this._configuraties = new Map();
    if (!fs.existsSync(this.memorieFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.memorieFile, 'utf8'));
      const entries = Array.isArray(raw) ? raw : (raw.configuraties || []);
      for (const entry of entries) {
        if (entry.configuratieId) {
          this._configuraties.set(entry.configuratieId, entry);
        }
      }
    } catch (_) {
      // Start fresh
    }
  }

  _save() {
    this._ensureDir(this.memorieFile);
    const entries = Array.from(this._configuraties.values());
    fs.writeFileSync(this.memorieFile, JSON.stringify(entries, null, 2));
  }

  // Registreer of update een configuratie na een run
  registreer(buurPatronen, runId) {
    const id = configuratieFingerprint(buurPatronen);
    const existing = this._configuraties.get(id);

    if (existing) {
      existing.laatsteRunId = runId;
      existing.aantalRuns = (existing.aantalRuns || 0) + 1;
      existing.laatsteUpdate = new Date().toISOString();
      this._configuraties.set(id, existing);
    } else {
      this._configuraties.set(id, {
        configuratieId: id,
        buurPatronen: (buurPatronen || []).map((p) => String(p || '').toLowerCase().trim()),
        gewicht: 0,
        aantalRuns: 1,
        pulsesCount: 0,
        bevestigingenCount: 0,
        eersteRunId: runId,
        laatsteRunId: runId,
        eersteGezien: new Date().toISOString(),
        laatsteUpdate: new Date().toISOString()
      });
    }

    this._save();
    return this._configuraties.get(id);
  }

  // Update gewicht na pulse: +0.30
  updatePulse(buurPatronen) {
    const id = configuratieFingerprint(buurPatronen);
    const config = this._configuraties.get(id);
    if (!config) return null;

    config.gewicht = round(config.gewicht + 0.30);
    config.pulsesCount = (config.pulsesCount || 0) + 1;
    config.laatsteUpdate = new Date().toISOString();
    this._save();
    return config;
  }

  // Update gewicht na VIVANT bevestiging: +0.15
  updateBevestiging(buurPatronen) {
    const id = configuratieFingerprint(buurPatronen);
    const config = this._configuraties.get(id);
    if (!config) return null;

    config.gewicht = round(config.gewicht + 0.15);
    config.bevestigingenCount = (config.bevestigingenCount || 0) + 1;
    config.laatsteUpdate = new Date().toISOString();
    this._save();
    return config;
  }

  // Update gewicht bij stilte: -0.05
  updateStilte(buurPatronen) {
    const id = configuratieFingerprint(buurPatronen);
    const config = this._configuraties.get(id);
    if (!config) return null;

    config.gewicht = round(Math.max(-1, config.gewicht - 0.05));
    config.laatsteUpdate = new Date().toISOString();
    this._save();
    return config;
  }

  // Vergeten: pas stilte toe op alle configuraties die niet in deze run actief waren
  vergetenInactieve(actieveIds) {
    const actieveSet = new Set(actieveIds || []);
    for (const [id, config] of this._configuraties) {
      if (!actieveSet.has(id)) {
        config.gewicht = round(Math.max(-1, config.gewicht - 0.05));
        config.laatsteUpdate = new Date().toISOString();
      }
    }
    this._save();
  }

  // Shuffle gewichten: 70% gewogen (softmax) + 30% random
  shuffleGewichten() {
    const entries = Array.from(this._configuraties.values());
    if (entries.length === 0) return [];

    const gewichten = entries.map((e) => e.gewicht);
    const kansen = softmax(gewichten);

    return entries.map((entry, i) => ({
      configuratieId: entry.configuratieId,
      buurPatronen: entry.buurPatronen,
      gewogenKans: kansen[i],
      effectieveKans: round(0.7 * kansen[i] + 0.3 * (1 / entries.length))
    }));
  }

  // Top configuraties op gewicht
  topConfiguraties(count = 5) {
    return Array.from(this._configuraties.values())
      .sort((a, b) => b.gewicht - a.gewicht)
      .slice(0, count);
  }

  getConfiguratie(buurPatronen) {
    const id = configuratieFingerprint(buurPatronen);
    return this._configuraties.get(id) || null;
  }

  stats() {
    const entries = Array.from(this._configuraties.values());
    const totalPulses = entries.reduce((s, e) => s + (e.pulsesCount || 0), 0);
    const totalBevestigingen = entries.reduce((s, e) => s + (e.bevestigingenCount || 0), 0);

    return {
      totaalConfiguraties: entries.length,
      totalePulses: totalPulses,
      totaleBevestigingen: totalBevestigingen,
      sterkste: entries.length > 0
        ? entries.sort((a, b) => b.gewicht - a.gewicht)[0]
        : null
    };
  }
}

module.exports = {
  ConfiguratieMemorie,
  configuratieFingerprint,
  softmax
};
