// FLINK PLACEHOLDER — replace this module with Apache Flink
// when signal volume exceeds 50/hour
'use strict';

const { SIGNAL_TYPE_WEIGHTS, normalizeText } = require('../sources/paper-signal-extractor');
const { TOPICS } = require('./topics');

/**
 * Flink-compatible normalization stage.
 *
 * Reads from `raw-signals`, applies deterministic filtering, weighting,
 * deduplication, and window metadata, then writes to `normalized-signals`.
 */

/** @type {Map<string, number>} dedupe key → timestamp of first seen */
const _seenTitles = new Map();
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_SCORE = 0.3;
const MIN_CONTENT_LENGTH = 40;
const MAX_DEDUPE_CACHE_SIZE = parseInt(process.env.CLASHD27_DEDUPE_CACHE_SIZE || '50000', 10);
const MAX_CONTENT_LENGTH = parseInt(process.env.CLASHD27_NORMALIZED_CONTENT_LIMIT || '1200', 10);

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function isValid(signal) {
  if (typeof signal.score !== 'number' || signal.score < MIN_SCORE) return false;
  if (!signal.title || normalizeText(signal.title) === '') return false;
  if (!signal.content || normalizeText(signal.content).length < MIN_CONTENT_LENGTH) return false;
  return true;
}

function buildDedupeKey(signal) {
  return [
    normalizeText(signal.type).toLowerCase(),
    normalizeText(signal.title).toLowerCase(),
    normalizeText(signal.paperId || signal.repoId || signal.eventId || signal.sourceUrl).toLowerCase()
  ].join('|');
}

function isDuplicate(signal, nowMs) {
  const key = buildDedupeKey(signal);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // Evict stale entries
  for (const [t, ts] of _seenTitles) {
    if (now - ts > DEDUP_WINDOW_MS) _seenTitles.delete(t);
  }

  if (_seenTitles.has(key)) return true;
  _seenTitles.set(key, now);
  while (_seenTitles.size > MAX_DEDUPE_CACHE_SIZE) {
    const oldestKey = _seenTitles.keys().next().value;
    if (!oldestKey) break;
    _seenTitles.delete(oldestKey);
  }
  return false;
}

function normalizeSignal(signal) {
  const timestamp = normalizeTimestamp(signal.timestamp);
  return {
    ...signal,
    title: normalizeText(signal.title),
    content: String(signal.content || '').slice(0, MAX_CONTENT_LENGTH),
    score: clamp(Number(signal.score) || 0, 0, 1),
    sourceWeight: Number.isFinite(signal.sourceWeight)
      ? signal.sourceWeight
      : (SIGNAL_TYPE_WEIGHTS[String(signal.type || '').trim()] ?? 1),
    timestamp,
    windowStartIso: toHourWindow(timestamp),
    dedupeKey: buildDedupeKey(signal)
  };
}

/**
 * Process all waiting signals in "raw-signals" and move valid ones
 * to "normalized-signals".
 *
 * @param {import('./signal-queue').SignalQueue} queue
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ accepted: number, dropped: number, duplicates: number, lowQuality: number }}
 */
function normalizeQueue(queue, opts = {}) {
  const raw = queue.consumeAll(TOPICS.RAW_SIGNALS);
  let accepted = 0;
  let dropped = 0;
  let duplicates = 0;
  let lowQuality = 0;

  for (const signal of raw) {
    const normalized = normalizeSignal(signal);

    if (!isValid(normalized)) {
      dropped += 1;
      lowQuality += 1;
      continue;
    }

    if (isDuplicate(normalized, opts.nowMs)) {
      dropped += 1;
      duplicates += 1;
      continue;
    }

    queue.produce(TOPICS.NORMALIZED_SIGNALS, normalized);
    accepted += 1;
  }

  return { accepted, dropped, duplicates, lowQuality };
}

function normalizeTimestamp(value) {
  const text = normalizeText(value);
  if (!text) return new Date().toISOString();
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function toHourWindow(timestamp) {
  const date = new Date(timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

// Expose for testing
normalizeQueue._seenTitles = _seenTitles;

module.exports = { normalizeQueue };
