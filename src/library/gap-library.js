'use strict';

const fs = require('fs');
const path = require('path');
const { resolveLibraryLayout } = require('./library-paths');

const {
  extractCells,
  extractHypothesis,
  fingerprintFromLibraryEntry,
  fingerprintGap,
  normalizeCollisionType,
  similarityScore
} = require('./gap-fingerprint');

const TREND_PRIORITY = {
  rising: 4,
  stable: 3,
  falling: 2,
  new: 1
};

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title) {
  return normalizeText(String(title || '').replace(/^Gap proposal:\s*/i, ''));
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((value) => normalizeText(value)).filter(Boolean)));
}

function uniqueSorted(values) {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function inferDomain(packet) {
  const signature = extractCells(packet);
  const primary = signature[0] || '';
  if (primary.startsWith('trust-model/')) return 'ai-safety';
  if (primary.startsWith('surface/')) return 'ai-research';
  if (primary.startsWith('architecture/')) return 'ai-governance';
  return 'ai-general';
}

function normalizeDomainRef(domain, packet) {
  if (typeof domain === 'string' && normalizeText(domain)) {
    return {
      domainId: normalizeText(domain),
      domainLabel: normalizeText(domain)
    };
  }

  if (domain && typeof domain === 'object') {
    return {
      domainId: normalizeText(domain.id || domain.domainId) || inferDomain(packet),
      domainLabel: normalizeText(domain.label || domain.domainLabel || domain.id || domain.domainId) || inferDomain(packet)
    };
  }

  const inferred = inferDomain(packet);
  return {
    domainId: inferred,
    domainLabel: inferred
  };
}

function buildDomainHistoryEntry(domainRef, runId, score, dateIso) {
  return {
    domainId: domainRef.domainId,
    domainLabel: domainRef.domainLabel,
    runId: normalizeText(runId) || null,
    score: round(score),
    date: normalizeText(dateIso) || new Date().toISOString()
  };
}

function normalizeDomainHistory(entry) {
  const fallbackDomain = normalizeDomainRef({
    id: entry.domainId || entry.domain,
    label: entry.domainLabel || entry.domainId || entry.domain
  });
  const discoveredAt = normalizeText(entry.discoveredAtIso || entry.lastSeenAtIso || entry.createdAtIso) || new Date().toISOString();
  const history = Array.isArray(entry.domainHistory) && entry.domainHistory.length > 0
    ? entry.domainHistory.map((item) => ({
      domainId: normalizeText(item.domainId || item.domain) || fallbackDomain.domainId,
      domainLabel: normalizeText(item.domainLabel || item.domainId || item.domain) || fallbackDomain.domainLabel,
      runId: normalizeText(item.runId) || null,
      score: round(item.score != null ? item.score : entry.score),
      date: normalizeText(item.date) || discoveredAt
    }))
    : [buildDomainHistoryEntry(fallbackDomain, entry.lastRunId, entry.score, discoveredAt)];

  history.sort((left, right) => String(left.date).localeCompare(String(right.date)));
  return history;
}

function uniqueDomainRefs(history, fallbackEntry) {
  const refs = [];
  const seen = new Set();
  for (const item of history || []) {
    const id = normalizeText(item.domainId || item.domain);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({
      domainId: id,
      domainLabel: normalizeText(item.domainLabel || id) || id
    });
  }

  if (refs.length === 0 && fallbackEntry) {
    const fallback = normalizeDomainRef({
      id: fallbackEntry.domainId || fallbackEntry.domain,
      label: fallbackEntry.domainLabel || fallbackEntry.domainId || fallbackEntry.domain
    });
    refs.push(fallback);
  }

  return refs;
}

function mergeDomainHistory(existingHistory, nextEntry) {
  const history = Array.isArray(existingHistory) ? existingHistory.slice() : [];
  const key = `${nextEntry.domainId}|${nextEntry.runId}|${nextEntry.date}`;
  const seen = new Set(history.map((entry) => `${entry.domainId}|${entry.runId}|${entry.date}`));
  if (!seen.has(key)) {
    history.push(nextEntry);
  }
  history.sort((left, right) => String(left.date).localeCompare(String(right.date)));
  return history;
}

function normalizeScoreHistory(entry) {
  const domainHistory = normalizeDomainHistory(entry);
  const rawHistory = Array.isArray(entry.scoreHistory) && entry.scoreHistory.length > 0
    ? entry.scoreHistory
    : [entry.score];

  const normalized = rawHistory.map((item, index) => {
    const fallback = domainHistory[Math.min(index, domainHistory.length - 1)] || domainHistory[0];
    if (item && typeof item === 'object') {
      return {
        score: round(item.score),
        runId: normalizeText(item.runId) || fallback.runId || entry.lastRunId || null,
        runDate: normalizeText(item.runDate || item.date) || fallback.date,
        domainId: normalizeText(item.domainId) || fallback.domainId,
        papersContributing: Number.isFinite(Number(item.papersContributing))
          ? Number(item.papersContributing)
          : Number(entry.paperCount || 0)
      };
    }
    return {
      score: round(item),
      runId: fallback.runId || entry.lastRunId || null,
      runDate: fallback.date,
      domainId: fallback.domainId,
      papersContributing: Number(entry.paperCount || 0)
    };
  }).filter((item) => Number.isFinite(item.score));

  normalized.sort((left, right) => String(left.runDate).localeCompare(String(right.runDate)));
  return normalized;
}

function trimScoreHistory(scoreHistory, archivedHistory = []) {
  const history = Array.isArray(scoreHistory) ? scoreHistory.slice() : [];
  const archive = Array.isArray(archivedHistory) ? archivedHistory.slice() : [];

  while (history.length > 50) {
    archive.push(...history.splice(0, Math.min(25, history.length - 50)));
  }

  return {
    scoreHistory: history,
    scoreHistoryArchive: archive
  };
}

function calculateTrend(scoreHistory) {
  if (!Array.isArray(scoreHistory) || scoreHistory.length < 2) return 'new';
  const recent = scoreHistory.slice(-3);
  const first = Number(recent[0].score || 0);
  const last = Number(recent[recent.length - 1].score || 0);
  const delta = last - first;
  if (delta > 0.05) return 'rising';
  if (delta < -0.05) return 'falling';
  return 'stable';
}

function computeLastSeenDaysAgo(entry, nowMs = Date.now()) {
  const seen = Date.parse(entry.lastSeenAtIso || entry.discoveredAtIso || '');
  if (!Number.isFinite(seen)) return 0;
  return Math.floor((nowMs - seen) / (1000 * 60 * 60 * 24));
}

function deriveStatus(entry, nowMs = Date.now()) {
  if (entry.deniedAt) return 'archived';
  if (entry.approvedAt) return 'strong';

  const lastSeenDaysAgo = Number.isFinite(entry.lastSeenDaysAgo)
    ? entry.lastSeenDaysAgo
    : computeLastSeenDaysAgo(entry, nowMs);

  if (lastSeenDaysAgo > 30 && (entry.runCount || 0) < 2) return 'archived';
  if (lastSeenDaysAgo > 14 && (entry.runCount || 0) < 3) return 'aging';
  if ((entry.runCount || 0) === 1) return 'new';
  if ((entry.runCount || 0) >= 2 && Number(entry.score || 0) >= 0.7) return 'strong';
  if ((entry.runCount || 0) >= 2) return 'confirmed';
  return 'confirmed';
}

function buildTags(entry) {
  return uniqueStrings([
    entry.fingerprint,
    entry.domainId,
    ...(entry.domains || []),
    ...(entry.cells || []),
    ...String(entry.title || '').toLowerCase().split(/\s+/).filter((token) => token.length >= 4).slice(0, 5)
  ]);
}

function sortEntries(entries, sortBy) {
  const copy = entries.slice();
  const sorter = sortBy || 'score';
  copy.sort((left, right) => {
    if (sorter === 'date') {
      return String(right.lastSeenAtIso).localeCompare(String(left.lastSeenAtIso));
    }
    if (sorter === 'runCount') {
      return (right.runCount || 0) - (left.runCount || 0) || (right.score || 0) - (left.score || 0);
    }
    if (sorter === 'trend') {
      return (TREND_PRIORITY[right.scoreTrend] || 0) - (TREND_PRIORITY[left.scoreTrend] || 0)
        || (right.score || 0) - (left.score || 0);
    }
    return (right.score || 0) - (left.score || 0) || String(right.lastSeenAtIso).localeCompare(String(left.lastSeenAtIso));
  });
  return copy;
}

function createBlankIndex() {
  return {
    byFingerprint: {},
    byDomain: {},
    byStatus: {},
    byScore: [],
    crossDomain: [],
    stats: {}
  };
}

class GapLibrary {
  constructor(options = {}) {
    const layout = resolveLibraryLayout(options);
    this.libraryRoot = layout.rootDir;
    this.libraryFile = layout.libraryFile;
    this.indexFile = layout.indexFile;
    this.domainsDir = layout.domainsDir;
    this.index = createBlankIndex();
    this._entriesByLibraryId = new Map();
    this._entriesByFingerprint = new Map();
    this._entriesBySourcePacketId = new Map();
    this._entries = [];
    this._load();
  }

  _normalizeEntry(entry, options = {}) {
    const normalized = {
      ...entry
    };
    normalized.title = normalizeTitle(entry.title || (entry.rendering && entry.rendering.title) || '');
    normalized.hypothesis = extractHypothesis(entry);
    normalized.cells = uniqueSorted(extractCells(entry));
    normalized.collisionType = normalizeCollisionType(entry);
    normalized.fingerprint = normalizeText(entry.fingerprint) || fingerprintFromLibraryEntry({
      ...entry,
      title: normalized.title,
      hypothesis: normalized.hypothesis,
      cells: normalized.cells,
      collisionType: normalized.collisionType
    });
    normalized.libraryId = normalizeText(entry.libraryId) || `lib-${normalized.fingerprint}`;
    normalized.gapId = normalizeText(entry.gapId || entry.packetId || entry.sourcePacketId) || `gap-${normalized.fingerprint}`;
    normalized.discoveredAtIso = normalizeText(entry.discoveredAtIso || entry.createdAtIso || entry.createdAt) || new Date().toISOString();
    normalized.lastSeenAtIso = normalizeText(entry.lastSeenAtIso || normalized.discoveredAtIso) || normalized.discoveredAtIso;
    normalized.domainHistory = normalizeDomainHistory(entry);
    const latestDomain = normalized.domainHistory[normalized.domainHistory.length - 1];
    normalized.domainId = normalizeText(entry.domainId || entry.domain || latestDomain.domainId) || latestDomain.domainId;
    normalized.domainLabel = normalizeText(entry.domainLabel || latestDomain.domainLabel) || latestDomain.domainLabel;
    normalized.domain = normalized.domainId;
    normalized.domains = uniqueDomainRefs(normalized.domainHistory, normalized).map((ref) => ref.domainId);
    normalized.crossDomain = normalized.domains.length > 1;
    normalized.sourcePacketIds = uniqueStrings([
      ...(Array.isArray(entry.sourcePacketIds) ? entry.sourcePacketIds : []),
      entry.gapId,
      entry.packetId,
      entry.sourcePacketId
    ]);
    normalized.handoffIds = uniqueStrings(entry.handoffIds || []);
    normalized.approvedAt = entry.approvedAt || null;
    normalized.deniedAt = entry.deniedAt || null;
    normalized.lastRunId = normalizeText(entry.lastRunId || latestDomain.runId) || null;
    normalized.runCount = Math.max(
      Number(entry.runCount || 0),
      Array.isArray(entry.scoreHistory) ? entry.scoreHistory.length : 0,
      normalized.domainHistory.length,
      1
    );
    normalized.score = round(entry.score != null ? entry.score : (
      entry.scores && entry.scores.total != null ? entry.scores.total : 0
    ));
    const trimmed = trimScoreHistory(normalizeScoreHistory({
      ...entry,
      domainHistory: normalized.domainHistory,
      domainId: normalized.domainId,
      domainLabel: normalized.domainLabel,
      score: normalized.score,
      paperCount: entry.paperCount
    }), entry.scoreHistoryArchive);
    normalized.scoreHistory = trimmed.scoreHistory;
    normalized.scoreHistoryArchive = trimmed.scoreHistoryArchive;
    if (normalized.scoreHistory.length > 0) {
      normalized.score = round(normalized.scoreHistory[normalized.scoreHistory.length - 1].score);
    }
    normalized.paperCount = Number.isFinite(Number(entry.paperCount))
      ? Number(entry.paperCount)
      : Array.isArray(entry.papers) ? entry.papers.length : 0;
    normalized.papers = Array.isArray(entry.papers) ? entry.papers.slice(0, 5) : [];
    normalized.mergeAudit = Array.isArray(entry.mergeAudit) ? entry.mergeAudit.slice(-25) : [];
    normalized.scoreTrend = calculateTrend(normalized.scoreHistory);
    normalized.lastSeenDaysAgo = computeLastSeenDaysAgo(normalized, options.nowMs);
    normalized.status = deriveStatus(normalized, options.nowMs);
    normalized.tags = buildTags(normalized);
    return normalized;
  }

  _saveIndex() {
    ensureDir(this.indexFile);
    fs.writeFileSync(this.indexFile, JSON.stringify({
      updatedAtIso: new Date().toISOString(),
      totalEntries: this._entries.length,
      index: this.index
    }, null, 2));
  }

  _clearIndex() {
    this.index = createBlankIndex();
    this._entriesByFingerprint.clear();
    this._entriesBySourcePacketId.clear();
  }

  _indexEntry(entry) {
    this._entriesByFingerprint.set(entry.fingerprint, entry);
    this.index.byFingerprint[entry.fingerprint] = entry;

    for (const domainId of entry.domains || []) {
      if (!this.index.byDomain[domainId]) this.index.byDomain[domainId] = [];
      if (!this.index.byDomain[domainId].includes(entry.fingerprint)) {
        this.index.byDomain[domainId].push(entry.fingerprint);
      }
    }

    if (!this.index.byStatus[entry.status]) this.index.byStatus[entry.status] = [];
    if (!this.index.byStatus[entry.status].includes(entry.fingerprint)) {
      this.index.byStatus[entry.status].push(entry.fingerprint);
    }

    this.index.byScore = this.index.byScore.filter((fingerprint) => fingerprint !== entry.fingerprint);
    this.index.byScore.push(entry.fingerprint);
    this.index.byScore.sort((left, right) => {
      const leftEntry = this._entriesByFingerprint.get(left);
      const rightEntry = this._entriesByFingerprint.get(right);
      return (rightEntry.score || 0) - (leftEntry.score || 0)
        || String(rightEntry.lastSeenAtIso).localeCompare(String(leftEntry.lastSeenAtIso));
    });

    if (entry.crossDomain && !this.index.crossDomain.includes(entry.fingerprint)) {
      this.index.crossDomain.push(entry.fingerprint);
    }
    if (!entry.crossDomain) {
      this.index.crossDomain = this.index.crossDomain.filter((fingerprint) => fingerprint !== entry.fingerprint);
    }

    for (const packetId of entry.sourcePacketIds || []) {
      this._entriesBySourcePacketId.set(packetId, entry);
    }
  }

  _unindexEntry(entry) {
    if (!entry) return;
    delete this.index.byFingerprint[entry.fingerprint];
    this._entriesByFingerprint.delete(entry.fingerprint);

    for (const domainId of Object.keys(this.index.byDomain)) {
      this.index.byDomain[domainId] = this.index.byDomain[domainId].filter((fingerprint) => fingerprint !== entry.fingerprint);
      if (this.index.byDomain[domainId].length === 0) delete this.index.byDomain[domainId];
    }

    for (const status of Object.keys(this.index.byStatus)) {
      this.index.byStatus[status] = this.index.byStatus[status].filter((fingerprint) => fingerprint !== entry.fingerprint);
      if (this.index.byStatus[status].length === 0) delete this.index.byStatus[status];
    }

    this.index.byScore = this.index.byScore.filter((fingerprint) => fingerprint !== entry.fingerprint);
    this.index.crossDomain = this.index.crossDomain.filter((fingerprint) => fingerprint !== entry.fingerprint);

    for (const packetId of entry.sourcePacketIds || []) {
      const current = this._entriesBySourcePacketId.get(packetId);
      if (current && current.fingerprint === entry.fingerprint) {
        this._entriesBySourcePacketId.delete(packetId);
      }
    }
  }

  _refreshStatsCache() {
    const byStatus = {};
    let scoreTotal = 0;
    let strongSignals = 0;

    for (const entry of this._entries) {
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
      scoreTotal += entry.score;
      if (entry.score >= 0.7) strongSignals += 1;
    }

    byStatus.confirmed = (byStatus.confirmed || 0) + (byStatus.strong || 0);
    this.index.stats = {
      totalGaps: this._entries.length,
      byStatus,
      avgScore: this._entries.length === 0 ? 0 : round(scoreTotal / this._entries.length),
      strongSignals,
      crossDomain: this.index.crossDomain.length
    };
  }

  _appendDomainViews(entry) {
    const domainRefs = uniqueDomainRefs(entry.domainHistory, entry);
    for (const domainRef of domainRefs) {
      const domainFile = path.join(this.domainsDir, domainRef.domainId, 'gaps.jsonl');
      ensureDir(domainFile);
      fs.appendFileSync(domainFile, `${JSON.stringify(entry)}\n`);
    }
  }

  _persistEntry(entry, previousEntry = null) {
    const normalized = this._normalizeEntry(entry);
    ensureDir(this.libraryFile);

    if (previousEntry) {
      this._unindexEntry(previousEntry);
    }

    fs.appendFileSync(this.libraryFile, `${JSON.stringify(normalized)}\n`);
    this._entriesByLibraryId.set(normalized.libraryId, normalized);
    this._entries = sortEntries(
      Array.from(this._entriesByLibraryId.values()),
      'score'
    );
    this._indexEntry(normalized);
    this._appendDomainViews(normalized);
    this._refreshStatsCache();
    this._saveIndex();
    return normalized;
  }

  _mergePaperRefs(existingPapers, nextPapers) {
    const merged = [];
    const seen = new Set();
    for (const paper of [...(existingPapers || []), ...(nextPapers || [])]) {
      const key = normalizeText(paper.url || paper.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(paper);
      if (merged.length >= 5) break;
    }
    return merged;
  }

  _mergeScoreHistory(existingHistory, nextHistory) {
    const merged = [];
    const seen = new Set();
    for (const item of [...(existingHistory || []), ...(nextHistory || [])]) {
      const normalized = {
        score: round(item.score),
        runId: normalizeText(item.runId) || null,
        runDate: normalizeText(item.runDate || item.date) || new Date().toISOString(),
        domainId: normalizeText(item.domainId) || 'ai-general',
        papersContributing: Number(item.papersContributing || 0)
      };
      const key = `${normalized.runId}|${normalized.runDate}|${normalized.domainId}|${normalized.score}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
    }
    merged.sort((left, right) => String(left.runDate).localeCompare(String(right.runDate)));
    return trimScoreHistory(merged).scoreHistory;
  }

  _mergeEntryData(baseEntry, incomingEntry, options = {}) {
    const mergedDomainHistory = (incomingEntry.domainHistory || []).reduce(
      (history, item) => mergeDomainHistory(history, item),
      baseEntry.domainHistory || []
    );
    const mergedScoreHistory = this._mergeScoreHistory(baseEntry.scoreHistory, incomingEntry.scoreHistory);
    const trimmed = trimScoreHistory(mergedScoreHistory, [
      ...(baseEntry.scoreHistoryArchive || []),
      ...(incomingEntry.scoreHistoryArchive || [])
    ]);
    const sourcePacketIds = uniqueStrings([...(baseEntry.sourcePacketIds || []), ...(incomingEntry.sourcePacketIds || []), incomingEntry.gapId]);
    const latestSeen = String(incomingEntry.lastSeenAtIso || '').localeCompare(String(baseEntry.lastSeenAtIso || '')) >= 0
      ? incomingEntry
      : baseEntry;
    const domains = uniqueDomainRefs(mergedDomainHistory, latestSeen).map((ref) => ref.domainId);
    const merged = {
      ...baseEntry,
      ...latestSeen,
      libraryId: baseEntry.libraryId,
      fingerprint: baseEntry.fingerprint,
      title: latestSeen.title || baseEntry.title,
      hypothesis: latestSeen.hypothesis || baseEntry.hypothesis,
      cells: uniqueSorted([...(baseEntry.cells || []), ...(incomingEntry.cells || [])]),
      collisionType: latestSeen.collisionType || baseEntry.collisionType,
      gapId: latestSeen.gapId || baseEntry.gapId,
      sourcePacketIds,
      handoffIds: uniqueStrings([...(baseEntry.handoffIds || []), ...(incomingEntry.handoffIds || [])]),
      approvedAt: incomingEntry.approvedAt || baseEntry.approvedAt || null,
      deniedAt: incomingEntry.deniedAt || baseEntry.deniedAt || null,
      domainHistory: mergedDomainHistory,
      domains,
      crossDomain: domains.length > 1,
      scoreHistory: trimmed.scoreHistory,
      scoreHistoryArchive: trimmed.scoreHistoryArchive,
      runCount: Math.max(baseEntry.runCount || 0, incomingEntry.runCount || 0, trimmed.scoreHistory.length, mergedDomainHistory.length),
      score: round(trimmed.scoreHistory[trimmed.scoreHistory.length - 1].score),
      paperCount: Math.max(baseEntry.paperCount || 0, incomingEntry.paperCount || 0),
      papers: this._mergePaperRefs(baseEntry.papers, incomingEntry.papers),
      lastSeenAtIso: latestSeen.lastSeenAtIso || baseEntry.lastSeenAtIso,
      discoveredAtIso: String(baseEntry.discoveredAtIso || '').localeCompare(String(incomingEntry.discoveredAtIso || '')) <= 0
        ? baseEntry.discoveredAtIso
        : incomingEntry.discoveredAtIso,
      lastRunId: latestSeen.lastRunId || baseEntry.lastRunId,
      mergeAudit: [
        ...(baseEntry.mergeAudit || []),
        ...(options.reason ? [{
          mergedAtIso: new Date().toISOString(),
          reason: options.reason,
          incomingFingerprint: incomingEntry.fingerprint,
          incomingLibraryId: incomingEntry.libraryId,
          runId: options.runId || incomingEntry.lastRunId || null,
          domainId: options.domainId || incomingEntry.domainId || null,
          similarity: Number.isFinite(options.similarity) ? round(options.similarity) : null
        }] : [])
      ].slice(-25)
    };
    return this._normalizeEntry(merged);
  }

  _selectPapers(packet, papers, domainRef) {
    const cellSet = new Set(extractCells(packet));
    return (papers || [])
      .map((paper) => {
        const paperCells = Array.isArray(paper.cells) ? paper.cells : [];
        const cellMatches = paperCells.reduce((count, cell) => count + (cellSet.has(cell) ? 1 : 0), 0);
        const domainBonus = normalizeText(paper.domain || paper.domainId) === domainRef.domainId ? 0.5 : 0;
        const score = cellMatches + domainBonus + Math.min(0.5, (Number(paper.signalCount) || 0) * 0.05);
        return { paper, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || (right.paper.citationCount || 0) - (left.paper.citationCount || 0))
      .slice(0, 5)
      .map(({ paper }) => ({
        title: paper.title,
        authors: Array.isArray(paper.authors) ? paper.authors.slice(0, 5) : [],
        url: paper.url || '',
        source: paper.source || 'paper'
      }));
  }

  _findNearDuplicate(value, fingerprint) {
    return this._findNearDuplicateInEntries(value, this._entries, fingerprint);
  }

  _findNearDuplicateInEntries(value, entries, fingerprint) {
    let best = null;
    let bestScore = 0;
    for (const entry of entries || []) {
      if (entry.fingerprint === fingerprint) continue;
      const score = similarityScore(value, entry);
      if (score > 0.85 && score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return best ? { entry: best, score: bestScore } : null;
  }

  _load() {
    ensureDir(this.libraryFile);
    ensureDir(this.indexFile);
    fs.mkdirSync(this.domainsDir, { recursive: true });
    this._entriesByLibraryId.clear();
    this._clearIndex();

    if (!fs.existsSync(this.libraryFile)) {
      this._entries = [];
      this._refreshStatsCache();
      this._saveIndex();
      return;
    }

    const rawLines = fs.readFileSync(this.libraryFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const latestByLibraryId = new Map();

    for (const line of rawLines) {
      try {
        const parsed = JSON.parse(line);
        const normalized = this._normalizeEntry(parsed);
        latestByLibraryId.set(normalized.libraryId, normalized);
      } catch (_) {
        // Ignore malformed historical lines so the library still loads.
      }
    }

    const stagedEntries = [];
    for (const normalized of latestByLibraryId.values()) {
      const exactIndex = stagedEntries.findIndex((entry) => entry.fingerprint === normalized.fingerprint);
      if (exactIndex >= 0) {
        stagedEntries[exactIndex] = this._mergeEntryData(stagedEntries[exactIndex], normalized, { reason: 'load-exact-merge' });
        continue;
      }

      const nearDuplicate = this._findNearDuplicateInEntries(normalized, stagedEntries, normalized.fingerprint);
      if (nearDuplicate) {
        const replaceIndex = stagedEntries.findIndex((entry) => entry.fingerprint === nearDuplicate.entry.fingerprint);
        stagedEntries[replaceIndex] = this._mergeEntryData(nearDuplicate.entry, normalized, {
          reason: 'load-near-duplicate',
          similarity: nearDuplicate.score
        });
        continue;
      }

      stagedEntries.push(normalized);
    }

    this._entries = sortEntries(stagedEntries, 'score');
    for (const entry of this._entries) {
      this._entriesByLibraryId.set(entry.libraryId, entry);
    }
    this._clearIndex();
    for (const entry of this._entries) {
      this._indexEntry(entry);
    }
    this._refreshStatsCache();
    this._saveIndex();
  }

  importEntry(entry, options = {}) {
    const normalized = this._normalizeEntry(entry);
    const exact = this._entriesByFingerprint.get(normalized.fingerprint);
    if (exact) {
      const merged = this._mergeEntryData(exact, normalized, {
        reason: 'migration-exact-merge',
        runId: options.runId || normalized.lastRunId,
        domainId: normalized.domainId
      });
      const saved = this._persistEntry(merged, exact);
      return { entry: saved, isNew: false, merged: true, reason: 'exact', fingerprint: saved.fingerprint };
    }

    const nearDuplicate = this._findNearDuplicate(normalized, normalized.fingerprint);
    if (nearDuplicate) {
      const merged = this._mergeEntryData(nearDuplicate.entry, normalized, {
        reason: 'migration-near-duplicate',
        runId: options.runId || normalized.lastRunId,
        domainId: normalized.domainId,
        similarity: nearDuplicate.score
      });
      const saved = this._persistEntry(merged, nearDuplicate.entry);
      return { entry: saved, isNew: false, merged: true, reason: 'near-duplicate', fingerprint: saved.fingerprint };
    }

    const saved = this._persistEntry(normalized);
    return { entry: saved, isNew: true, merged: false, reason: 'new', fingerprint: saved.fingerprint };
  }

  addOrUpdate(gapPacket, papers, runId, domain) {
    const fingerprint = fingerprintGap(gapPacket);
    const nowIso = normalizeText(gapPacket && gapPacket.createdAt) || new Date().toISOString();
    const score = round(gapPacket && gapPacket.scores ? gapPacket.scores.total : gapPacket && gapPacket.score);
    const domainRef = normalizeDomainRef(domain, gapPacket);
    const paperMatches = this._selectPapers(gapPacket, papers, domainRef);
    const papersContributing = paperMatches.length > 0 ? paperMatches.length : (Array.isArray(papers) ? papers.length : 0);
    const scoreEntry = {
      score,
      runId: normalizeText(runId) || null,
      runDate: nowIso,
      domainId: domainRef.domainId,
      papersContributing
    };
    const title = normalizeTitle(
      gapPacket && gapPacket.gapProposalHandoff && gapPacket.gapProposalHandoff.packet
        ? gapPacket.gapProposalHandoff.packet.title
        : gapPacket && gapPacket.candidate && gapPacket.candidate.explanation
    );
    const exact = this._entriesByFingerprint.get(fingerprint);

    if (exact) {
      const updated = this._mergeEntryData(exact, {
        ...exact,
        title: title || exact.title,
        hypothesis: extractHypothesis(gapPacket) || exact.hypothesis,
        cells: extractCells(gapPacket),
        collisionType: normalizeCollisionType(gapPacket),
        sourcePacketIds: uniqueStrings([...(exact.sourcePacketIds || []), gapPacket.packetId, gapPacket.gapId]),
        papers: this._mergePaperRefs(exact.papers, paperMatches),
        paperCount: Math.max(exact.paperCount || 0, paperMatches.length),
        domainHistory: mergeDomainHistory(exact.domainHistory, buildDomainHistoryEntry(domainRef, runId, score, nowIso)),
        scoreHistory: [...(exact.scoreHistory || []), scoreEntry],
        score,
        lastRunId: normalizeText(runId) || exact.lastRunId,
        lastSeenAtIso: nowIso
      }, {
        reason: 'fingerprint-match',
        runId,
        domainId: domainRef.domainId
      });
      const saved = this._persistEntry(updated, exact);
      return { entry: saved, isNew: false, isConfirmed: saved.runCount > 1 };
    }

    const nearDuplicate = this._findNearDuplicate(gapPacket, fingerprint);
    if (nearDuplicate) {
      const merged = this._mergeEntryData(nearDuplicate.entry, {
        libraryId: nearDuplicate.entry.libraryId,
        fingerprint: nearDuplicate.entry.fingerprint,
        gapId: normalizeText(gapPacket.packetId || gapPacket.gapId),
        sourcePacketIds: [gapPacket.packetId, gapPacket.gapId],
        title,
        hypothesis: extractHypothesis(gapPacket),
        cells: extractCells(gapPacket),
        collisionType: normalizeCollisionType(gapPacket),
        discoveredAtIso: nearDuplicate.entry.discoveredAtIso,
        lastSeenAtIso: nowIso,
        domainId: domainRef.domainId,
        domainLabel: domainRef.domainLabel,
        domainHistory: mergeDomainHistory(nearDuplicate.entry.domainHistory, buildDomainHistoryEntry(domainRef, runId, score, nowIso)),
        scoreHistory: [...(nearDuplicate.entry.scoreHistory || []), scoreEntry],
        score,
        paperCount: paperMatches.length,
        papers: paperMatches,
        runCount: (nearDuplicate.entry.runCount || 0) + 1,
        lastRunId: normalizeText(runId) || nearDuplicate.entry.lastRunId
      }, {
        reason: 'near-duplicate-merge',
        runId,
        domainId: domainRef.domainId,
        similarity: nearDuplicate.score
      });
      const saved = this._persistEntry(merged, nearDuplicate.entry);
      return { entry: saved, isNew: false, isConfirmed: saved.runCount > 1 };
    }

    const created = this._normalizeEntry({
      libraryId: `lib-${fingerprint}`,
      fingerprint,
      gapId: normalizeText(gapPacket && (gapPacket.packetId || gapPacket.gapId)) || `gap-${fingerprint}`,
      sourcePacketIds: [gapPacket && gapPacket.packetId, gapPacket && gapPacket.gapId],
      discoveredAtIso: nowIso,
      lastSeenAtIso: nowIso,
      runCount: 1,
      title,
      hypothesis: extractHypothesis(gapPacket),
      domain: domainRef.domainId,
      domainId: domainRef.domainId,
      domainLabel: domainRef.domainLabel,
      domainHistory: [buildDomainHistoryEntry(domainRef, runId, score, nowIso)],
      cells: extractCells(gapPacket),
      collisionType: normalizeCollisionType(gapPacket),
      score,
      scoreHistory: [scoreEntry],
      scoreHistoryArchive: [],
      papers: paperMatches,
      paperCount: paperMatches.length,
      handoffIds: [],
      approvedAt: null,
      deniedAt: null,
      lastRunId: normalizeText(runId) || null,
      mergeAudit: []
    });
    const saved = this._persistEntry(created);
    return { entry: saved, isNew: true, isConfirmed: false };
  }

  recordHandoffs(records = []) {
    let updatedCount = 0;
    for (const record of records) {
      if (!record || !record.sourcePacketId || !record.gapId) continue;
      const match = this._entriesBySourcePacketId.get(record.sourcePacketId)
        || this._entries.find((entry) => (entry.sourcePacketIds || []).includes(record.sourcePacketId));
      if (!match) continue;
      const updated = this._normalizeEntry({
        ...match,
        handoffIds: uniqueStrings([...(match.handoffIds || []), record.gapId]),
        approvedAt: record.status === 'approved' ? (record.approvedAt || match.approvedAt || null) : match.approvedAt || null,
        deniedAt: record.status === 'denied' ? (record.deniedAt || match.deniedAt || null) : match.deniedAt || null
      });
      this._persistEntry(updated, match);
      updatedCount += 1;
    }
    return updatedCount;
  }

  query(filters = {}) {
    let entries = this._entries.slice();

    if (filters.domain) {
      const fingerprints = this.index.byDomain[normalizeText(filters.domain)] || [];
      entries = fingerprints.map((fingerprint) => this._entriesByFingerprint.get(fingerprint)).filter(Boolean);
    }
    if (Number.isFinite(filters.minScore)) {
      entries = entries.filter((entry) => entry.score >= filters.minScore);
    }
    if (filters.status) {
      entries = entries.filter((entry) => entry.status === filters.status);
    }
    if (Array.isArray(filters.tags) && filters.tags.length > 0) {
      const required = new Set(filters.tags.map((tag) => normalizeText(tag).toLowerCase()));
      entries = entries.filter((entry) => {
        const entryTags = new Set((entry.tags || []).map((tag) => normalizeText(tag).toLowerCase()));
        for (const tag of required) {
          if (!entryTags.has(tag)) return false;
        }
        return true;
      });
    }

    entries = sortEntries(entries, filters.sortBy);
    const limit = Number.isFinite(filters.limit) ? Math.max(0, filters.limit) : entries.length;
    return entries.slice(0, limit);
  }

  queryByDomain(domainId, options = {}) {
    return this.query({
      ...options,
      domain: domainId
    });
  }

  findCrossDomainGaps(options = {}) {
    const minDomains = Number.isFinite(options.minDomains) ? options.minDomains : 2;
    const matches = this._entries.filter((entry) => (entry.domains || []).length >= minDomains);
    return sortEntries(matches, options.sortBy || 'score').slice(0, Number.isFinite(options.limit) ? options.limit : matches.length);
  }

  domainStats() {
    const byDomain = {};
    for (const entry of this._entries) {
      const refs = uniqueDomainRefs(entry.domainHistory, entry);
      for (const ref of refs) {
        if (!byDomain[ref.domainId]) {
          byDomain[ref.domainId] = {
            domainId: ref.domainId,
            domainLabel: ref.domainLabel,
            count: 0,
            avgScore: 0,
            strong: 0,
            topGaps: []
          };
        }
        byDomain[ref.domainId].count += 1;
        byDomain[ref.domainId].avgScore += entry.score;
        if (entry.score >= 0.7) byDomain[ref.domainId].strong += 1;
        byDomain[ref.domainId].topGaps.push(entry);
      }
    }

    for (const domainId of Object.keys(byDomain)) {
      const details = byDomain[domainId];
      details.avgScore = details.count === 0 ? 0 : round(details.avgScore / details.count);
      details.topGaps = sortEntries(details.topGaps, 'score').slice(0, 5);
    }

    return byDomain;
  }

  stats() {
    const byStatus = { ...(this.index.stats.byStatus || {}) };

    return {
      totalGaps: this._entries.length,
      byDomain: Object.fromEntries(Object.entries(this.domainStats()).map(([domainId, details]) => [
        domainId,
        {
          count: details.count,
          avgScore: details.avgScore
        }
      ])),
      byStatus,
      avgScore: this.index.stats.avgScore || 0,
      strongSignals: this.index.stats.strongSignals || 0,
      crossDomain: this.index.crossDomain.length,
      topGaps: this.query({ limit: 5, sortBy: 'score' }),
      domainDetails: this.domainStats(),
      fingerprinted: this._entries.filter((entry) => Boolean(entry.fingerprint)).length,
      scoreHistoryEntries: this._entries.reduce((sum, entry) => sum + (entry.scoreHistory || []).length, 0)
    };
  }

  export(format = 'json') {
    const entries = this._entries.slice();
    if (format === 'csv') {
      const header = [
        'libraryId',
        'fingerprint',
        'gapId',
        'title',
        'domain',
        'domainLabel',
        'crossDomain',
        'score',
        'status',
        'runCount',
        'scoreTrend',
        'lastSeenAtIso'
      ];
      const rows = entries.map((entry) => [
        entry.libraryId,
        entry.fingerprint,
        entry.gapId,
        entry.title,
        entry.domainId,
        entry.domainLabel,
        entry.crossDomain,
        entry.score,
        entry.status,
        entry.runCount,
        entry.scoreTrend,
        entry.lastSeenAtIso
      ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(','));
      return [header.join(','), ...rows].join('\n');
    }

    if (format === 'markdown') {
      return entries.map((entry) => {
        const domains = uniqueDomainRefs(entry.domainHistory, entry).map((ref) => ref.domainLabel).join(', ') || entry.domainLabel;
        const papers = (entry.papers || [])
          .map((paper) => `- ${paper.title} (${paper.source})`)
          .join('\n') || '- None recorded';
        return [
          `## ${entry.title}`,
          `**Score:** ${entry.score.toFixed(3)} · **Domain(s):** ${domains} · **Status:** ${entry.status} · **Fingerprint:** ${entry.fingerprint}`,
          '',
          `> ${entry.hypothesis}`,
          '',
          `**Evidence:** ${entry.paperCount} papers · **Confirmed:** ${entry.runCount} runs · **Trend:** ${entry.scoreTrend}`,
          '',
          '**Source papers:**',
          papers,
          '',
          '---'
        ].join('\n');
      }).join('\n\n');
    }

    return JSON.stringify(entries, null, 2);
  }
}

module.exports = {
  GapLibrary,
  calculateTrend,
  deriveStatus
};
