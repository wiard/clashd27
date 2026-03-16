'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  BELOFTE_STATUS,
  BELOFTE_TREND,
  TYPE_LABELS,
  createBelofte,
  fingerprintBelofte
} = require('./belofte');
const { resolvePromiseLibraryLayout } = require('./promise-paths');

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function calculateTrend(previousScore, currentScore) {
  if (previousScore == null) return BELOFTE_TREND.STABLE;
  const delta = Number(currentScore || 0) - Number(previousScore || 0);
  if (delta > 0.05) return BELOFTE_TREND.RISING;
  if (delta < -0.05) return BELOFTE_TREND.FALLING;
  return BELOFTE_TREND.STABLE;
}

function deriveStatus(belofte) {
  if (belofte.status === BELOFTE_STATUS.ARCHIVED) return BELOFTE_STATUS.ARCHIVED;
  if ((belofte.bevestigd || 0) >= 5 && (belofte.score || 0) >= 0.7) return BELOFTE_STATUS.STRONG;
  if ((belofte.bevestigd || 0) >= 2) return BELOFTE_STATUS.CONFIRMED;
  return BELOFTE_STATUS.NEW;
}

function normalizeScoreHistory(candidate) {
  const raw = Array.isArray(candidate.scoreHistory) ? candidate.scoreHistory : [];
  if (raw.length > 0) {
    return raw.map((entry) => ({
      score: round(entry.score),
      runId: entry.runId || null,
      timestamp: entry.timestamp || entry.date || new Date().toISOString()
    }));
  }
  return [{
    score: round(candidate.score),
    runId: candidate.laatsteRunId || candidate.runId || null,
    timestamp: candidate.lastSeenAtIso || candidate.aangemaakt || new Date().toISOString()
  }];
}

function normalizeBelofte(candidate) {
  const base = createBelofte(candidate);
  return {
    ...base,
    centerLabel: candidate.centerLabel || base.titel,
    neighborLabels: Array.isArray(candidate.neighborLabels) ? candidate.neighborLabels.slice() : [],
    lastSeenAtIso: candidate.lastSeenAtIso || candidate.aangemaakt || new Date().toISOString(),
    laatsteRunId: candidate.laatsteRunId || candidate.runId || null,
    scoreHistory: normalizeScoreHistory(candidate)
  };
}

function cubeFingerprint(constellation) {
  const canonical = [
    constellation.type || '',
    (constellation.domains || []).slice().sort().join(','),
    String(constellation.hypothesis || '').trim()
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

class BeloofteLibrary {
  constructor(options = {}) {
    const layout = resolvePromiseLibraryLayout(options);
    this.beloftesFile = options.beloftesFile || layout.beloftesFile;
    this.indexFile = options.indexFile || path.join(layout.rootDir, 'beloftes-index.json');
    this.latestCubeFile = options.latestCubeFile || layout.latestCubeFile;
    this.runsFile = options.runsFile || layout.runsFile;
    this.legacyBeloftesFile = options.legacyBeloftesFile === false ? null : (options.legacyBeloftesFile || layout.legacyBeloftesFile);
    this._entries = [];
    this._byId = new Map();
    this._load();
  }

  _loadFile(filePath, latestById) {
    if (!filePath || !fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const belofte = normalizeBelofte(parsed);
        latestById.set(belofte.beloofteId, belofte);
      } catch (_) {
        // Skip malformed lines.
      }
    }
  }

  _load() {
    ensureDir(this.beloftesFile);
    ensureDir(this.indexFile);
    ensureDir(this.latestCubeFile);
    ensureDir(this.runsFile);
    this._entries = [];
    this._byId = new Map();

    const latestById = new Map();
    if (this.legacyBeloftesFile && this.legacyBeloftesFile !== this.beloftesFile) {
      this._loadFile(this.legacyBeloftesFile, latestById);
    }
    this._loadFile(this.beloftesFile, latestById);

    this._entries = Array.from(latestById.values()).sort((a, b) => b.score - a.score || b.bevestigd - a.bevestigd);
    for (const entry of this._entries) {
      this._byId.set(entry.beloofteId, entry);
    }
  }

  _persistBelofte(belofte) {
    ensureDir(this.beloftesFile);
    fs.appendFileSync(this.beloftesFile, JSON.stringify(belofte) + '\n');
  }

  _readRunsSummary() {
    if (!fs.existsSync(this.runsFile)) {
      return { totalRuns: 0, lastRunAt: null };
    }
    const lines = fs.readFileSync(this.runsFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return { totalRuns: 0, lastRunAt: null };
    }
    let lastRunAt = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]);
        lastRunAt = parsed.timestamp || parsed.completedAtIso || parsed.startedAtIso || null;
        break;
      } catch (_) {
        // Skip malformed lines.
      }
    }
    return { totalRuns: lines.length, lastRunAt };
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
      for (const domain of entry.domeinen || []) {
        counts[domain] = (counts[domain] || 0) + 1;
      }
    }
    return counts;
  }

  _saveIndex() {
    const runStats = this._readRunsSummary();
    ensureDir(this.indexFile);
    fs.writeFileSync(this.indexFile, JSON.stringify({
      updatedAtIso: new Date().toISOString(),
      totalBeloftes: this._entries.length,
      totalRuns: runStats.totalRuns,
      lastRunAt: runStats.lastRunAt,
      byType: this._countByType(),
      byDomain: this._countByDomain(),
      topBeloftes: this._entries.slice(0, 5).map((entry) => ({
        beloofteId: entry.beloofteId,
        titel: entry.titel,
        type: entry.type,
        score: entry.score,
        domeinen: entry.domeinen,
        bevestigd: entry.bevestigd,
        trend: entry.trend
      }))
    }, null, 2));
  }

  _upsertBelofte(belofte) {
    this._byId.set(belofte.beloofteId, belofte);
    const index = this._entries.findIndex((entry) => entry.beloofteId === belofte.beloofteId);
    if (index >= 0) {
      this._entries[index] = belofte;
    } else {
      this._entries.push(belofte);
    }
    this._entries.sort((a, b) => b.score - a.score || b.bevestigd - a.bevestigd);
    this._persistBelofte(belofte);
    this._saveIndex();
  }

  addOrUpdate(belofte, runId) {
    const id = belofte.beloofteId || fingerprintBelofte(belofte);
    const existing = this._byId.get(id);

    if (existing) {
      const nextHistory = (existing.scoreHistory || []).concat({
        score: round(belofte.score),
        runId: runId || belofte.runId || null,
        timestamp: belofte.lastSeenAtIso || new Date().toISOString()
      });
      const updated = normalizeBelofte({
        ...existing,
        ...belofte,
        beloofteId: id,
        score: round(belofte.score),
        scoreTrace: belofte.scoreTrace || existing.scoreTrace,
        bevestigd: (existing.bevestigd || 0) + 1,
        trend: calculateTrend(existing.score, belofte.score),
        status: deriveStatus({
          ...existing,
          bevestigd: (existing.bevestigd || 0) + 1,
          score: belofte.score
        }),
        laatsteRunId: runId || belofte.runId || existing.laatsteRunId || null,
        lastSeenAtIso: belofte.lastSeenAtIso || new Date().toISOString(),
        scoreHistory: nextHistory
      });

      this._upsertBelofte(updated);
      return { belofte: updated, isNew: false };
    }

    const created = normalizeBelofte({
      ...belofte,
      beloofteId: id,
      bevestigd: 1,
      status: deriveStatus({ ...belofte, bevestigd: 1 }),
      aangemaakt: belofte.aangemaakt || new Date().toISOString(),
      lastSeenAtIso: belofte.lastSeenAtIso || belofte.aangemaakt || new Date().toISOString(),
      laatsteRunId: runId || belofte.runId || null,
      trend: belofte.trend || BELOFTE_TREND.STABLE
    });

    this._upsertBelofte(created);
    return { belofte: created, isNew: true };
  }

  saveRun(cubeRun) {
    ensureDir(this.runsFile);
    ensureDir(this.latestCubeFile);
    fs.appendFileSync(this.runsFile, JSON.stringify(cubeRun) + '\n');
    fs.writeFileSync(this.latestCubeFile, JSON.stringify(cubeRun, null, 2));
    this._saveIndex();
    return cubeRun;
  }

  addOrUpdateBeloftes(cubeRun) {
    const constellations = Array.isArray(cubeRun.topConstellations) ? cubeRun.topConstellations : [];
    const results = [];
    let created = 0;
    let updated = 0;

    for (const constellation of constellations) {
      const belofte = {
        beloofteId: cubeFingerprint(constellation),
        titel: constellation.centerLabel || constellation.title || 'Unnamed belofte',
        type: constellation.type,
        domeinen: Array.isArray(constellation.domains) ? constellation.domains.slice() : [],
        cellen: Array.isArray(constellation.cells) ? constellation.cells.slice() : [],
        hypothese: constellation.hypothesis || '',
        verborgenVerband: constellation.explanation || '',
        bronnengaps: Array.isArray(constellation.sourceGapIds) ? constellation.sourceGapIds.slice() : [],
        score: round(constellation.score),
        scoreTrace: constellation.scoreBreakdown || {},
        centerLabel: constellation.centerLabel || '',
        neighborLabels: Array.isArray(constellation.neighborLabels) ? constellation.neighborLabels.slice() : [],
        runId: cubeRun.runId,
        lastSeenAtIso: cubeRun.timestamp || new Date().toISOString()
      };
      const result = this.addOrUpdate(belofte, cubeRun.runId);
      results.push(result.belofte);
      if (result.isNew) created += 1;
      else updated += 1;
    }

    return {
      entries: results,
      created,
      updated
    };
  }

  query(filters = {}) {
    let entries = this._entries.slice();

    if (filters.type) {
      entries = entries.filter((entry) => entry.type === filters.type);
    }
    if (Number.isFinite(filters.minScore)) {
      entries = entries.filter((entry) => entry.score >= filters.minScore);
    }
    if (Array.isArray(filters.domeinen) && filters.domeinen.length > 0) {
      const required = new Set(filters.domeinen);
      entries = entries.filter((entry) => (entry.domeinen || []).some((domain) => required.has(domain)));
    }
    if (filters.domain) {
      entries = entries.filter((entry) => (entry.domeinen || []).includes(filters.domain));
    }
    if (filters.status) {
      entries = entries.filter((entry) => entry.status === filters.status);
    }

    if (filters.sortBy === 'bevestigd') {
      entries.sort((a, b) => (b.bevestigd || 0) - (a.bevestigd || 0) || b.score - a.score);
    } else if (filters.sortBy === 'aangemaakt') {
      entries.sort((a, b) => String(b.aangemaakt).localeCompare(String(a.aangemaakt)));
    } else if (filters.sortBy === 'trend') {
      const priority = { rising: 3, stable: 2, falling: 1 };
      entries.sort((a, b) => (priority[b.trend] || 0) - (priority[a.trend] || 0) || b.score - a.score);
    } else {
      entries.sort((a, b) => b.score - a.score || (b.bevestigd || 0) - (a.bevestigd || 0));
    }

    const limit = Number.isFinite(filters.limit) ? Math.max(0, filters.limit) : entries.length;
    return entries.slice(0, limit);
  }

  stats() {
    const byType = this._countByType();
    const byDomain = this._countByDomain();
    const crossDomainCount = this._entries.filter((entry) => (entry.domeinen || []).length > 1).length;
    const runs = this._readRunsSummary();

    return {
      totalBeloftes: this._entries.length,
      byType,
      byDomain,
      crossDomainCount,
      topBeloftes: this._entries.slice(0, 5).map((entry) => ({
        beloofteId: entry.beloofteId,
        titel: entry.titel,
        type: entry.type,
        score: entry.score,
        domeinen: entry.domeinen,
        bevestigd: entry.bevestigd,
        trend: entry.trend
      })),
      totalRuns: runs.totalRuns,
      lastRunAt: runs.lastRunAt
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
          `**Score:** ${belofte.score.toFixed(3)} · **Domeinen:** ${belofte.domeinen.join(', ')} · **Bevestigd:** ${belofte.bevestigd} runs`,
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
  BeloofteLibrary,
  calculateTrend,
  deriveStatus
};
