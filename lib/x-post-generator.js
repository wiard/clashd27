/**
 * CLASHD-27 — X Post Generator
 *
 * Generates draft tweets and threads for research gaps.
 * 6 psychologically distinct templates with virality scoring.
 *
 * NEVER auto-posts. Draft-only.
 */

'use strict';

// ── Utilities ────────────────────────────────────────────────

function trimToLimit(text, limit) {
  if (text.length <= limit) return text;
  const trimmed = text.slice(0, limit - 1).trim();
  return `${trimmed}\u2026`;
}

function normalizeHandle(handle) {
  if (!handle) return null;
  const clean = handle.trim();
  if (!clean) return null;
  return clean.startsWith('@') ? clean : `@${clean}`;
}

function extractSummary(gap) {
  return gap?.claim || gap?.summary || gap?.hypothesis || 'A new research gap has been identified.';
}

function extractProposal(gap) {
  const raw = gap?.proposal || gap?.suggested_experiment || gap?.proposed_experiment || gap?.experiment || 'Run a focused pilot to validate the missing link.';
  return typeof raw === 'string' ? raw : (typeof raw === 'object' ? (raw.title || JSON.stringify(raw).slice(0, 200)) : String(raw));
}

function buildLink(gap) {
  const id = gap?.id || 'unknown';
  return `https://clashd27.com/gap/${id}`;
}

function extractNumber(gap) {
  // Try to pull a concrete number from evidence or experiment
  let text = gap?.experiment || gap?.claim || gap?.missing || '';
  // Handle object experiments (e.g. from find-openclaw-gap.js)
  if (typeof text === 'object') {
    text = gap?.proposed_experiment || gap?.claim || gap?.missing || '';
  }
  if (typeof text !== 'string') text = '';
  const m = text.match(/(\d+)\s*(channels?|surfaces?|payloads?|tokens?|%|sessions?|hours?)/i);
  if (m) return `${m[1]} ${m[2]}`;
  return null;
}

// ── 6 Template Framings ─────────────────────────────────────

const TEMPLATES = [
  {
    id: 'hypothesis',
    label: 'Hypothesis framing',
    build: (gap, repoInfo) => {
      const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
      const link = buildLink(gap);
      const tag = handle ? ` ${handle}` : '';
      const summary = extractSummary(gap);
      return trimToLimit(
        `Hypothesis: ${summary}\n\nNo benchmark exists yet.${tag}\n${link}`,
        280
      );
    }
  },
  {
    id: 'benchmark',
    label: 'Benchmark framing',
    build: (gap, repoInfo) => {
      const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
      const link = buildLink(gap);
      const tag = handle ? ` ${handle}` : '';
      const num = extractNumber(gap);
      const numStr = num ? ` across ${num}` : '';
      return trimToLimit(
        `Missing benchmark: no standardized test${numStr} for this security dimension.${tag}\n\n${extractSummary(gap).slice(0, 120)}\n${link}`,
        280
      );
    }
  },
  {
    id: 'question',
    label: 'Question framing',
    build: (gap, repoInfo) => {
      const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
      const link = buildLink(gap);
      const tag = handle ? ` ${handle}` : '';
      const repo = repoInfo?.repo || 'multi-surface AI agents';
      return trimToLimit(
        `What happens when you inject a prompt into one channel of ${repo}? Does it propagate to others? No one has measured this.${tag}\n${link}`,
        280
      );
    }
  },
  {
    id: 'risk',
    label: 'Risk framing',
    build: (gap, repoInfo) => {
      const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
      const link = buildLink(gap);
      const tag = handle ? ` ${handle}` : '';
      const num = extractNumber(gap);
      const numStr = num ? `${num} ` : '';
      return trimToLimit(
        `Potential risk: AI agents sharing memory across ${numStr}channels may propagate injected instructions silently. No empirical data exists yet.${tag}\n${link}`,
        280
      );
    }
  },
  {
    id: 'data_driven',
    label: 'Data-driven framing',
    build: (gap, repoInfo) => {
      const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
      const link = buildLink(gap);
      const tag = handle ? ` ${handle}` : '';
      const score = gap?.score || '?';
      const evCount = Array.isArray(gap?.evidence) ? gap.evidence.length : 0;
      return trimToLimit(
        `${evCount} papers surveyed, 0 benchmarks found for cross-channel injection propagation in AI agents. Gap score: ${score}/100.${tag}\n${link}`,
        280
      );
    }
  },
  {
    id: 'experimental_challenge',
    label: 'Experimental challenge framing',
    build: (gap, repoInfo) => {
      const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
      const link = buildLink(gap);
      const tag = handle ? ` ${handle}` : '';
      const num = extractNumber(gap) || '3 channels';
      return trimToLimit(
        `Challenge: inject canary payloads into one AI agent channel, measure propagation to ${num}. Who can build this benchmark first?${tag}\n${link}`,
        280
      );
    }
  },
];

// ── Template selection ──────────────────────────────────────

function selectTemplate(templates, seed) {
  if (!templates || !templates.length) return templates[0];
  const idx = seed ? (seed.charCodeAt(0) + seed.length) % templates.length : 0;
  return templates[idx];
}

// ── Legacy compatibility: repo/paper templates ──────────────

const REPO_TEMPLATES = [
  { id: 'repo_a', text: `New research gap detected in {repo}.\n\n{summary}\n\nSuggested experiment:\n{proposal}\n\n{link}\n{tag}` },
  { id: 'repo_b', text: `Gap spotted for {repo}.\n\n{summary}\n\nNext test:\n{proposal}\n\n{link}\n{tag}` }
];

const PAPER_TEMPLATES = [
  { id: 'paper_a', text: `AI research gap detected:\n\n{summary}\n\nMissing experiment:\n{proposal}\n\n{link}\n{tag}` },
  { id: 'paper_b', text: `Open gap:\n\n{summary}\n\nProposed test:\n{proposal}\n\n{link}\n{tag}` }
];

function buildText(gap, repoInfo, template) {
  const repo = repoInfo?.repo || 'a target repo';
  const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
  const summary = extractSummary(gap);
  const proposal = extractProposal(gap);
  const link = buildLink(gap);
  const tagLine = handle ? `${handle}` : '';

  return template
    .replace('{repo}', repo)
    .replace('{summary}', summary)
    .replace('{proposal}', proposal)
    .replace('{link}', link)
    .replace('{tag}', tagLine)
    .replace(/\s+\n/g, '\n')
    .trim();
}

// ── Virality Score ──────────────────────────────────────────

/**
 * Heuristic virality score for a draft text (0-5).
 *   +1 curiosity hook (question mark or "what if")
 *   +1 specific number
 *   +1 explicit experiment / challenge mention
 *   +1 tag present
 *   -1 too generic (no concrete technical detail)
 */
function viralityScore(text) {
  if (!text) return 0;
  let score = 0;
  const lower = text.toLowerCase();

  // +1 curiosity hook
  if (text.includes('?') || lower.includes('what if') || lower.includes('what happens') || lower.includes('who can')) {
    score += 1;
  }
  // +1 specific number
  if (/\d+\s*(channels?|surfaces?|payloads?|tokens?|%|papers?|hours?|sessions?|benchmark)/i.test(text)) {
    score += 1;
  }
  // +1 explicit experiment / challenge
  if (lower.includes('experiment') || lower.includes('benchmark') || lower.includes('challenge') || lower.includes('inject') || lower.includes('measure') || lower.includes('canary')) {
    score += 1;
  }
  // +1 tag present
  if (/@\w+/.test(text)) {
    score += 1;
  }
  // -1 too generic (no concrete technical detail)
  const techTerms = ['injection', 'propagat', 'channel', 'memory', 'session', 'canary', 'payload', 'surface', 'agent', 'benchmark'];
  const hasTech = techTerms.some(t => lower.includes(t));
  if (!hasTech) {
    score -= 1;
  }

  return Math.max(0, Math.min(5, score));
}

// ── Generate single draft (backward compatible) ─────────────

function generateDraft(gap, repoInfo) {
  const hasRepo = !!repoInfo && !!repoInfo.repo;
  const templates = hasRepo ? REPO_TEMPLATES : PAPER_TEMPLATES;
  const template = selectTemplate(templates, gap?.id || 'seed');
  let text = buildText(gap, repoInfo, template.text);
  text = trimToLimit(text, 280);
  return { text, template: template.id, char_count: text.length, virality: viralityScore(text) };
}

// ── Generate 6-template drafts ──────────────────────────────

/**
 * Generate up to 6 draft variants using all template framings.
 * Each draft: <= 280 chars, <= 2 tagged accounts, no accusations.
 */
function generateAllDrafts(gap, repoInfo) {
  const drafts = [];
  for (const tmpl of TEMPLATES) {
    let text = tmpl.build(gap, repoInfo || null);
    // Enforce <= 280 chars
    text = trimToLimit(text, 280);
    // Enforce <= 2 tagged accounts
    const mentions = (text.match(/@\w+/g) || []);
    if (mentions.length > 2) {
      let count = 0;
      text = text.replace(/@\w+/g, (m) => {
        count++;
        return count <= 2 ? m : '';
      }).replace(/\s{2,}/g, ' ').trim();
    }
    const virality = viralityScore(text);
    drafts.push({
      id: tmpl.id,
      label: tmpl.label,
      text,
      char_count: text.length,
      virality,
    });
  }
  return drafts;
}

// ── Thread Generation ───────────────────────────────────────

function splitIntoTweets(text, maxTweets) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= 280) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (para.length <= 280) {
      current = para;
      continue;
    }
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sentenceBlock = '';
    for (const sentence of sentences) {
      const sentenceCandidate = sentenceBlock ? `${sentenceBlock} ${sentence}` : sentence;
      if (sentenceCandidate.length <= 280) {
        sentenceBlock = sentenceCandidate;
        continue;
      }
      if (sentenceBlock) {
        chunks.push(sentenceBlock.trim());
        sentenceBlock = '';
      }
      if (sentence.length <= 280) {
        sentenceBlock = sentence;
      } else {
        chunks.push(trimToLimit(sentence, 280));
      }
    }
    if (sentenceBlock) {
      chunks.push(sentenceBlock.trim());
    }
  }

  if (current) chunks.push(current.trim());
  return chunks.slice(0, maxTweets);
}

/**
 * Generate a 1-4 tweet thread with narrative arc:
 *   Tweet 1: Hook (the gap)
 *   Tweet 2: Evidence / context
 *   Tweet 3: Proposed experiment
 *   Tweet 4: Call to action + link
 *
 * Each tweet <= 280 chars.
 */
function generateThread(gap, repoInfo) {
  const link = buildLink(gap);
  const handle = normalizeHandle(repoInfo?.maintainer_x_handle);
  const tag = handle ? ` ${handle}` : '';
  const summary = extractSummary(gap);
  const proposal = extractProposal(gap);
  const num = extractNumber(gap);
  const evCount = Array.isArray(gap?.evidence) ? gap.evidence.length : 0;

  const rawTweets = [];

  // Tweet 1: Hook
  rawTweets.push(
    `Research gap: ${summary.slice(0, 240)}`
  );

  // Tweet 2: Evidence context
  if (evCount > 0 || num) {
    const numLine = num ? ` across ${num}` : '';
    rawTweets.push(
      `We surveyed ${evCount} papers. Existing work covers single-channel injection and plugin vulns, but no propagation matrix${numLine}. The cross-channel dimension is unstudied.`
    );
  }

  // Tweet 3: Experiment
  rawTweets.push(
    `Proposed experiment: ${proposal.slice(0, 250)}`
  );

  // Tweet 4: CTA
  rawTweets.push(
    `Gap score: ${gap?.score || '?'}/100. Who wants to build this benchmark?${tag}\n${link}`
  );

  // Enforce each <= 280
  const tweets = rawTweets.map(t => trimToLimit(t.trim(), 280));
  const char_counts = tweets.map(t => t.length);
  const virality_scores = tweets.map(t => viralityScore(t));

  return { tweets, char_counts, virality_scores };
}

// ── Exports ─────────────────────────────────────────────────

module.exports = {
  generateDraft,
  generateAllDrafts,
  generateThread,
  viralityScore,
  splitIntoTweets,
};
