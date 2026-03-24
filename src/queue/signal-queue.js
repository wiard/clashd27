'use strict';

/**
 * Lightweight in-memory signal queue with a Kafka-compatible interface.
 *
 * Swap this module for a real Kafka producer/consumer when signal volume
 * warrants it — the interface stays the same.
 */
class SignalQueue {
  constructor() {
    /** @type {Map<string, Array<object>>} */
    this._topics = new Map();
  }

  /**
   * Add a signal to a named topic.
   * @param {string} topic
   * @param {object} signal - canonical signal object
   */
  produce(topic, signal) {
    if (!this._topics.has(topic)) this._topics.set(topic, []);
    this._topics.get(topic).push(signal);
  }

  /**
   * Return and remove the next signal from a topic (FIFO).
   * @param {string} topic
   * @returns {object|null}
   */
  consume(topic) {
    const q = this._topics.get(topic);
    if (!q || q.length === 0) return null;
    return q.shift();
  }

  /**
   * Return all waiting signals and flush the topic.
   * @param {string} topic
   * @returns {Array<object>}
   */
  consumeAll(topic) {
    const q = this._topics.get(topic);
    if (!q || q.length === 0) return [];
    const all = q.splice(0);
    return all;
  }

  /**
   * Count of waiting signals on a topic.
   * @param {string} topic
   * @returns {number}
   */
  size(topic) {
    const q = this._topics.get(topic);
    return q ? q.length : 0;
  }

  /**
   * List of active topic names.
   * @returns {string[]}
   */
  topics() {
    return [...this._topics.keys()];
  }
}

module.exports = { SignalQueue };
