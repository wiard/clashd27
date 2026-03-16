'use strict';

const { normalizeText } = require('./paper-signal-extractor');
const { TOPICS } = require('../queue/topics');

function eventToSignal(event) {
  const title = normalizeText(event.title || event.type || event.eventId || 'internal system event');
  const content = normalizeText(event.content || event.summary || event.message || event.description);
  if (!title || !content) {
    return null;
  }
  return {
    type: 'internal-system',
    domain: normalizeText(event.domain || 'internal-system').toLowerCase(),
    title,
    content,
    score: clamp(Number(event.score) || 0.55, 0, 1),
    source: 'internal system',
    sourceWeight: 0.7,
    timestamp: normalizeText(event.timestamp || event.detectedAt || new Date().toISOString()),
    sourceUrl: normalizeText(event.sourceUrl || ''),
    eventId: normalizeText(event.eventId || event.id || title.toLowerCase().replace(/\s+/g, '-')),
    id: `internal:${normalizeText(event.eventId || event.id || title).replace(/[^a-zA-Z0-9._-]/g, '-')}`
  };
}

function enqueueInternalSystemSignals(queue, events) {
  let emittedSignals = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const signal = eventToSignal(event);
    if (!signal) continue;
    queue.produce(TOPICS.RAW_SIGNALS, signal);
    emittedSignals += 1;
  }
  return {
    fetched: emittedSignals,
    emittedSignals,
    queries: emittedSignals > 0 ? 1 : 0
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = {
  enqueueInternalSystemSignals,
  eventToSignal
};
