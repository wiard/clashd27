'use strict';

const { normalizeText } = require('./paper-signal-extractor');
const { TOPICS } = require('../queue/topics');

function repoToSignal(repo) {
  const title = normalizeText(repo.title || repo.name || repo.fullName);
  const content = normalizeText(repo.content || repo.description || repo.summary);
  if (!title || !content) {
    return null;
  }
  const topics = Array.isArray(repo.topics) ? repo.topics.map((topic) => normalizeText(topic).toLowerCase()).filter(Boolean) : [];
  return {
    type: 'github-repo',
    domain: normalizeText(repo.domain || inferDomain(topics, title)).toLowerCase(),
    title,
    content,
    score: clamp(Number(repo.score) || deriveRepoScore(repo), 0, 1),
    source: 'github repo',
    sourceWeight: 1.2,
    timestamp: normalizeText(repo.timestamp || repo.updatedAt || new Date().toISOString()),
    sourceUrl: normalizeText(repo.url || ''),
    stars: Math.max(0, Number(repo.stars) || 0),
    forks: Math.max(0, Number(repo.forks) || 0),
    topics,
    repoId: normalizeText(repo.repoId || repo.fullName || repo.name || title.toLowerCase()),
    id: `github:${normalizeText(repo.repoId || repo.fullName || repo.name || title).replace(/[^a-zA-Z0-9._-]/g, '-')}`
  };
}

function enqueueGithubRepoSignals(queue, repos) {
  let emittedSignals = 0;
  for (const repo of Array.isArray(repos) ? repos : []) {
    const signal = repoToSignal(repo);
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

function deriveRepoScore(repo) {
  const stars = Math.max(0, Number(repo.stars) || 0);
  const forks = Math.max(0, Number(repo.forks) || 0);
  const boost = Math.min(0.24, (Math.log10(stars + 1) * 0.08) + (Math.log10(forks + 1) * 0.04));
  return 0.48 + boost;
}

function inferDomain(topics, title) {
  const joined = `${topics.join(' ')} ${title}`.toLowerCase();
  if (joined.includes('security')) return 'cybersecurity';
  if (joined.includes('distributed')) return 'distributed-systems';
  if (joined.includes('architecture')) return 'software-architecture';
  if (joined.includes('agent')) return 'multi-agent-systems';
  return 'software-architecture';
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = {
  enqueueGithubRepoSignals,
  repoToSignal
};
