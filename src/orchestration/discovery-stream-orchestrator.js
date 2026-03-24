'use strict';

const { SignalQueue } = require('../queue/signal-queue');
const { normalizeQueue } = require('../queue/signal-normalizer');
const { TOPICS } = require('../queue/topics');
const { fetchArxivPapers } = require('../sources/arxiv-source');
const { fetchSemanticScholarPapers } = require('../sources/semantic-scholar-source');
const { fetchOpenAlexPapers } = require('../sources/openalex-source');
const { fetchCrossrefPapers } = require('../sources/crossref-source');
const { enqueueGithubRepoSignals } = require('../sources/github-repo-source');
const { enqueueInternalSystemSignals } = require('../sources/internal-system-source');

async function runSignalIngestionCycle(input = {}) {
  const queue = input.queue || new SignalQueue();
  const engine = input.engine || null;
  const tick = Number.isFinite(input.tick) ? input.tick : 0;
  const referenceTime = input.referenceTime || new Date().toISOString();
  const sourceRuns = [];

  const paperSources = input.paperSources || [
    fetchArxivPapers,
    fetchSemanticScholarPapers,
    fetchOpenAlexPapers,
    fetchCrossrefPapers
  ];

  for (const fetchSource of paperSources) {
    if (typeof fetchSource !== 'function') continue;
    try {
      const result = await fetchSource(queue, input.sourceOptions || {});
      sourceRuns.push({
        kind: 'paper',
        source: fetchSource.name || 'paper-source',
        fetched: Number(result && result.fetched) || 0,
        emittedSignals: Number(result && result.emittedSignals) || 0,
        queries: Number(result && result.queries) || 0
      });
    } catch (error) {
      sourceRuns.push({
        kind: 'paper',
        source: fetchSource.name || 'paper-source',
        fetched: 0,
        emittedSignals: 0,
        queries: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (Array.isArray(input.githubRepos) && input.githubRepos.length > 0) {
    const result = enqueueGithubRepoSignals(queue, input.githubRepos);
    sourceRuns.push({
      kind: 'github',
      source: 'github-repo-source',
      fetched: result.fetched,
      emittedSignals: result.emittedSignals,
      queries: result.queries
    });
  }

  if (Array.isArray(input.internalEvents) && input.internalEvents.length > 0) {
    const result = enqueueInternalSystemSignals(queue, input.internalEvents);
    sourceRuns.push({
      kind: 'internal',
      source: 'internal-system-source',
      fetched: result.fetched,
      emittedSignals: result.emittedSignals,
      queries: result.queries
    });
  }

  const queuedRawSignals = queue.size(TOPICS.RAW_SIGNALS);
  const normalization = normalizeQueue(queue, { nowMs: Date.parse(referenceTime) });
  const normalizedSignals = queue.consumeAll(TOPICS.NORMALIZED_SIGNALS);

  const activatedCells = new Set();
  if (engine && typeof engine.ingestSignal === 'function') {
    for (const signal of normalizedSignals) {
      engine.ingestSignal(signal, {
        tick,
        persist: false,
        referenceTime
      });
      const state = typeof engine.getState === 'function' ? engine.getState() : null;
      const latestSignal = state && Array.isArray(state.signals) ? state.signals[state.signals.length - 1] : null;
      if (latestSignal && Number.isInteger(latestSignal.cellId)) {
        activatedCells.add(latestSignal.cellId);
      }
    }
  }

  return {
    queue,
    normalizedSignals,
    report: {
      papersAnalyzed: sourceRuns
        .filter((entry) => entry.kind === 'paper')
        .reduce((sum, entry) => sum + entry.fetched, 0),
      rawSignalsQueued: queuedRawSignals,
      signalsGenerated: sourceRuns.reduce((sum, entry) => sum + entry.emittedSignals, 0),
      normalizedSignals: normalizedSignals.length,
      droppedSignals: normalization.dropped,
      duplicateSignals: normalization.duplicates,
      lowQualitySignals: normalization.lowQuality,
      cubeCellsActivated: activatedCells.size,
      sourceRuns,
      topicDepths: {
        rawSignals: queue.size(TOPICS.RAW_SIGNALS),
        normalizedSignals: queue.size(TOPICS.NORMALIZED_SIGNALS)
      }
    }
  };
}

module.exports = {
  runSignalIngestionCycle
};
