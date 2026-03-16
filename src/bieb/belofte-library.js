'use strict';

const fs = require('fs');
const path = require('path');
const { BELOFTE_STATUS, BELOFTE_TREND, TYPE_LABELS, createBelofte, fingerprintBelofte } = require('./belofte');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_BELOFTES_FILE = path.join(ROOT_DIR, 'data', 'bieb', 'beloftes.jsonl');
const DEFAULT_INDEX_FILE = path.join(ROOT_DIR, 'data', 'bieb', 'beloftes-index.json');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function calculateTrend(previousScore, currentScore) {
  if (previousScore == null) return BELOFTE_TREND.STABLE;
  const delta = currentScore - previousScore;
  if (delta > 0.05) return BELOFTE_TREND.RISING;
  if (delta < -0.05) return BELOFTE_TREND.FALLING;
  return BELOFTE_TREND.STABLE;
}

function deriveStatus(belofte) {
  if (belofte.bevestigd >= 5 && belofte.score >= 0.7) return BELOFTE_STATUS.STRONG;
  if (belofte.bevestigd >= 2) return BELOFTE_STATUS.CONFIRMED;
  return BELOFTE_STATUS.NEW;
}

class BeloofteLibrary {
  constructor(options = {}) {
    this.beloftesFile = options.beloftesFile || DEFAULT_BELOFTES_FILE;
    this.indexFile = options.indexFile || DEFAULT_INDEX_FILE;
    this._entries = [];
    this._byId = new Map();
    this._load();
  }

  _load() {
    ensureDir(this.beloftesFile);
    ensureDir(this.indexFile);
    this._entries = [];
    this._byId = new Map();

    if (!fs.existsSync(this.beloftesFile)) return;

    const lines = fs.readFileSync(this.beloftesFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const latestById = new Map();
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const belofte = createBelofte(parsed);
        latestById.set(belofte.beloofteId, belofte);
      } catch (_) {
        // Skip malformed lines
      }
    }

    this._entries = Array.from(latestById.values());
    this._entries.sort((a, b) => b.score - a.score);
    for (const entry of this._entries) {
      this._byId.set(entry.beloofteId, entry);
    }
  }

  _persist(belofte) {
    ensureDir(this.beloftesFile);
    fs.appendFileSync(this.beloftesFile, JSON.stringify(belofte) + '\n');
  }

  _saveIndex() {
    ensureDir(this.indexFile);
    fs.writeFileSync(this.indexFile, JSON.stringify({
      updatedAtIso: new Date().toISOString(),
      totalBeloftes: this._entries.length,
      byType: this._countByType(),
      topBeloftes: this._entries.slice(0, 5).map((b) => ({
        beloofteId: b.beloofteId,
        titel: b.titel,
        type: b.type,
        score: b.score,
        domeinen: b.domeinen
      }))
    }, null, 2));
  }

  _countByType() {
    const counts = {};
    for (const entry of this._entries) {
      counts[entry.type] = (counts[entry.type] || 0) + 1;
    }
    return counts;
  }

  _countByDomain() {
    const counts = {};
    for (const entry of this._entries) {
      for (const domain of entry.domeinen) {
        counts[domain] = (counts[domain] || 0) + 1;
      }
    }
    return counts;
  }

  addOrUpdate(belofte, runId) {
    const id = belofte.beloofteId || fingerprintBelofte(belofte);
    const existing = this._byId.get(id);

    if (existing) {
      const previousScore = existing.score;
      const updated = createBelofte({
        ...existing,
        score: belofte.score,
        scoreTrace: belofte.scoreTrace || existing.scoreTrace,
        bevestigd: (existing.bevestigd || 0) + 1,
        trend: calculateTrend(previousScore, belofte.score),
        status: deriveStatus({
          ...existing,
          bevestigd: (existing.bevestigd || 0) + 1,
          score: belofte.score
        })
      });

      this._byId.set(id, updated);
      const index = this._entries.findIndex((e) => e.beloofteId === id);
      if (index >= 0) this._entries[index] = updated;
      this._entries.sort((a, b) => b.score - a.score);
      this._persist(updated);
      this._saveIndex();
      return { belofte: updated, isNew: false };
    }

    const created = createBelofte({
      ...belofte,
      beloofteId: id,
      bevestigd: 1,
      status: BELOFTE_STATUS.NEW,
      aangemaakt: belofte.aangemaakt || new Date().toISOString()
    });

    this._entries.push(created);
    this._entries.sort((a, b) => b.score - a.score);
    this._byId.set(id, created);
    this._persist(created);
    this._saveIndex();
    return { belofte: created, isNew: true };
  }

  query(filters = {}) {
    let entries = this._entries.slice();

    if (filters.type) {
      entries = entries.filter((e) => e.type === filters.type);
    }
    if (Number.isFinite(filters.minScore)) {
      entries = entries.filter((e) => e.score >= filters.minScore);
    }
    if (Array.isArray(filters.domeinen) && filters.domeinen.length > 0) {
      const required = new Set(filters.domeinen);
      entries = entries.filter((e) => e.domeinen.some((d) => required.has(d)));
    }
    if (filters.status) {
      entries = entries.filter((e) => e.status === filters.status);
    }

    if (filters.sortBy === 'bevestigd') {
      entries.sort((a, b) => (b.bevestigd || 0) - (a.bevestigd || 0) || b.score - a.score);
    } else if (filters.sortBy === 'aangemaakt') {
      entries.sort((a, b) => String(b.aangemaakt).localeCompare(String(a.aangemaakt)));
    } else {
      entries.sort((a, b) => b.score - a.score);
    }

    const limit = Number.isFinite(filters.limit) ? Math.max(0, filters.limit) : entries.length;
    return entries.slice(0, limit);
  }

  stats() {
    const byType = this._countByType();
    const byDomain = this._countByDomain();
    const crossDomainCount = this._entries.filter((e) => e.domeinen.length > 1).length;

    return {
      totalBeloftes: this._entries.length,
      byType,
      byDomain,
      crossDomainCount,
      topBeloftes: this._entries.slice(0, 5).map((b) => ({
        beloofteId: b.beloofteId,
        titel: b.titel,
        type: b.type,
        score: b.score,
        domeinen: b.domeinen,
        bevestigd: b.bevestigd,
        trend: b.trend
      }))
    };
  }

  export(format = 'json') {
    if (format === 'markdown') {
      return this._entries.map((belofte) => {
        const typeLabel = TYPE_LABELS[belofte.type] || belofte.type;
        return [
          `## ${belofte.titel}`,
          '',
          `**Type:** ${typeLabel}`,
          `**Score:** ${belofte.score.toFixed(3)} \u00b7 **Domeinen:** ${belofte.domeinen.join(', ')} \u00b7 **Bevestigd:** ${belofte.bevestigd} runs`,
          '',
          `> ${belofte.hypothese}`,
          '',
          '**Verborgen verband:**',
          belofte.verborgenVerband,
          '',
          `**Bronnengaps:** ${belofte.bronnengaps.length} onderliggende gaps`,
          `**Trend:** ${belofte.trend}`,
          '',
          '---'
        ].join('\n');
      }).join('\n\n');
    }

    return JSON.stringify(this._entries, null, 2);
  }

  getAll() {
    return this._entries.slice();
  }
}

module.exports = {
  BeloofteLibrary
};
