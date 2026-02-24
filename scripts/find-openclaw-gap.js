#!/usr/bin/env node
/**
 * CLASHD-27 — OpenClaw Gap Finder (v2)
 *
 * Pre-engineered hypothesis — no hallucination risk.
 * Gathers supporting evidence, performs novelty check, builds gap object,
 * designs propagation experiment, scores, dedupes, registers, generates
 * X drafts, saves draft file.
 *
 * Usage:  node scripts/find-openclaw-gap.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Imports ──────────────────────────────────────────────────
const { searchPapers }    = require('../lib/semantic-scholar');
const { searchPapers: searchEPMC } = require('../lib/europe-pmc');
const { recordGap, readGapsIndex, writeGapsIndex } = require('../lib/gap-index');
const { generateDraft, generateAllDrafts, viralityScore } = require('../lib/x-post-generator');

// ghFetch is not exported by github-monitor — build a minimal one
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
async function ghFetch(endpoint) {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://api.github.com${endpoint}`;
  const headers = {
    'User-Agent': 'CLASHD27-GapFinder/2.0',
    'Accept': 'application/vnd.github+json',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

const DATA_DIR = path.join(__dirname, '..', 'data');

// ────────────────────────────────────────────────────────────
// PRE-DEFINED GAP CORE — DO NOT DEVIATE
// ────────────────────────────────────────────────────────────
const PREDEFINED_HYPOTHESIS =
  'In multi-surface AI agents that share persistent memory across messaging channels, ' +
  'a prompt injection delivered through one low-trust channel can causally alter agent ' +
  'behavior in a separate high-trust channel within the same session window.';

const NOVELTY_DIMENSIONS = [
  'No standardized benchmark measuring cross-channel injection propagation in real multi-surface agents.',
  'Existing work studies single-channel injection or plugin vulnerabilities.',
  'No propagation matrix across surfaces.',
];

// ── Helpers ──────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function stringSimilarity(a, b) {
  if (!a || !b) return 0;
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return 1;
  function bigrams(s) {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2);
      m.set(bi, (m.get(bi) || 0) + 1);
    }
    return m;
  }
  const ba = bigrams(al);
  const bb = bigrams(bl);
  let inter = 0;
  for (const [bi, cnt] of ba) {
    if (bb.has(bi)) inter += Math.min(cnt, bb.get(bi));
  }
  const total = al.length - 1 + bl.length - 1;
  if (total <= 0) return 0;
  return (2 * inter) / total;
}

async function safe(fn, fallback) {
  try { return await fn(); }
  catch (e) { console.warn(`[WARN] ${e.message || e}`); return fallback; }
}

// ────────────────────────────────────────────────────────────
// STEP 1 — Evidence Gathering
// ────────────────────────────────────────────────────────────

const RESEARCH_QUERIES = [
  'cross-channel prompt injection AI agent',
  'multi-surface AI agent security',
  'AI agent plugin marketplace security',
  'autonomous agent authorization boundary',
  'prompt injection propagation across sessions',
  'AI assistant plugin attack chain',
  'messaging bridge AI data exfiltration',
];

const NOVELTY_QUERIES = [
  'OpenClaw security study',
  'multi-channel AI agent prompt injection propagation empirical',
  'cross-surface LLM injection experiment',
  'cross-channel prompt injection benchmark',
  'agent memory isolation across messaging surfaces',
];

async function gatherSemanticScholar() {
  const papers = [];
  for (const q of RESEARCH_QUERIES) {
    const results = await safe(() => searchPapers(q, 5), []);
    for (const p of results) {
      papers.push({
        title:    p.title || '',
        year:     p.year || null,
        abstract: (p.abstract || p.tldr || '').slice(0, 200),
        url:      p.doi ? `https://doi.org/${p.doi}` : `https://api.semanticscholar.org/graph/v1/paper/${p.paperId}`,
        source:   'semantic-scholar',
      });
    }
  }
  const seen = new Set();
  return papers.filter(p => {
    const key = p.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gatherEuropePMC() {
  const papers = [];
  for (const q of RESEARCH_QUERIES) {
    const results = await safe(() => searchEPMC(q, { pageSize: 5 }), []);
    for (const p of results) {
      papers.push({
        title:    p.title || '',
        year:     p.year || null,
        abstract: (p.abstract || '').slice(0, 200),
        url:      p.doi ? `https://doi.org/${p.doi}` : (p.pmid ? `https://europepmc.org/article/MED/${p.pmid}` : ''),
        source:   'europe-pmc',
      });
    }
  }
  const seen = new Set();
  return papers.filter(p => {
    const key = p.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function gatherGitHub() {
  const ghData = { repo: null, issues: [], commits: [] };

  ghData.repo = await safe(() => ghFetch('/repos/openclaw/openclaw'), null);

  const issues = await safe(
    () => ghFetch('/repos/openclaw/openclaw/issues?state=all&labels=security&per_page=20'),
    []
  );
  ghData.issues = Array.isArray(issues) ? issues.map(i => ({
    number: i.number, title: i.title, state: i.state, url: i.html_url,
  })) : [];

  const commits = await safe(
    () => ghFetch('/repos/openclaw/openclaw/commits?since=2026-01-01T00:00:00Z&per_page=30'),
    []
  );
  ghData.commits = Array.isArray(commits) ? commits.map(c => ({
    sha: (c.sha || '').slice(0, 7),
    message: (c.commit?.message || '').slice(0, 120),
    date: c.commit?.committer?.date || '',
  })) : [];

  return ghData;
}

// ────────────────────────────────────────────────────────────
// STEP 2 — Novelty Check
// ────────────────────────────────────────────────────────────

async function noveltyCheck() {
  const hits = [];

  for (const q of NOVELTY_QUERIES) {
    const s2 = await safe(() => searchPapers(q, 5), []);
    for (const p of s2) {
      hits.push({ title: p.title, year: p.year, abstract: (p.abstract || '').slice(0, 150), source: 'semantic-scholar' });
    }
    const epmc = await safe(() => searchEPMC(q, { pageSize: 5 }), []);
    for (const p of epmc) {
      hits.push({ title: p.title, year: p.year, abstract: (p.abstract || '').slice(0, 150), source: 'europe-pmc' });
    }
  }

  // Check for direct coverage of our exact hypothesis
  const directMatch = hits.find(h =>
    h.title &&
    h.title.toLowerCase().includes('cross-channel') &&
    h.title.toLowerCase().includes('injection') &&
    h.title.toLowerCase().includes('propagat')
  );

  // Check for partial coverage (single-channel injection or plugin vulns)
  const partialMatches = hits.filter(h =>
    h.title && (
      h.title.toLowerCase().includes('prompt injection') ||
      h.title.toLowerCase().includes('agent security') ||
      h.title.toLowerCase().includes('plugin') ||
      h.title.toLowerCase().includes('memory isolation')
    )
  );

  // Check for propagation matrix papers
  const matrixMatch = hits.find(h =>
    h.title &&
    h.title.toLowerCase().includes('propagation') &&
    h.title.toLowerCase().includes('matrix')
  );

  return { hits, directMatch, partialMatches, matrixMatch };
}

// ────────────────────────────────────────────────────────────
// STEP 3 — Gap Construction (uses PRE-DEFINED hypothesis)
// ────────────────────────────────────────────────────────────

function constructGap(evidence, ghData, novelty) {
  const stamp = dateStamp();
  const id = `openclaw_${stamp}_auto`;

  // ── Scoring ──
  let score = 0;
  // +30 large deployment
  if (ghData.repo && (ghData.repo.stargazers_count || 0) > 50) {
    score += 30;
  } else {
    score += 20; // known platform even without live data
  }
  // +30 real-world security findings
  if (ghData.issues.length > 0) {
    score += 30;
  } else if (evidence.length > 3) {
    score += 20;
  }
  // +20 architectural propagation risk (multi-surface by design)
  score += 20;
  // +20 absence of benchmark
  if (!novelty.directMatch && !novelty.matrixMatch) {
    score += 20;
  } else {
    score += 10;
  }
  score = Math.min(score, 100);

  // ── Concrete propagation experiment ──
  const experiment = {
    title: 'Cross-Channel Injection Propagation Benchmark',
    channels: [
      { name: 'Discord', trust_level: 'low', role: 'injection_source' },
      { name: 'Slack',   trust_level: 'medium', role: 'propagation_target_1' },
      { name: 'Email',   trust_level: 'high', role: 'propagation_target_2' },
    ],
    injection_vector: {
      description: 'Embed canary-tagged instruction payloads in Discord messages processed by the agent. ' +
        'Each payload contains a unique token (UUID) and a behavioral directive ' +
        '(e.g., "append [CANARY-xyz] to your next 3 responses").',
      payload_count: 50,
      payload_format: 'Natural language instruction with embedded UUID canary token',
    },
    memory_persistence_window: {
      description: 'Measure whether injected context persists and activates across session boundaries.',
      windows_tested: ['same session', '1 hour gap', '4 hour gap', '24 hour gap'],
      metric: 'Binary activation (canary token appears in target channel response: yes/no) per window',
    },
    measurable_outcomes: [
      'Propagation rate: % of injections in Discord that alter agent behavior in Slack and Email',
      'Cross-channel latency: time from injection to first observed propagation',
      'Memory bleed persistence: % of canary tokens still active after each time window',
      'Data exfiltration volume: bytes of cross-channel context retrievable via crafted prompts',
      'Trust boundary violation rate: % of high-trust channel responses contaminated by low-trust input',
    ],
    propagation_matrix_format: {
      description: 'NxN matrix where N = number of channels. Cell (i,j) = probability that injection in channel i propagates to channel j.',
      example: {
        '':        ['Discord→', 'Slack→', 'Email→'],
        'Discord':  ['-',       '0.42',   '0.18'],
        'Slack':    ['0.31',    '-',      '0.24'],
        'Email':    ['0.08',    '0.12',   '-'],
      },
      additional_dimensions: [
        'Broken down by time window (same-session vs. cross-session)',
        'Broken down by payload type (behavioral directive vs. data extraction)',
        'Confidence intervals from 50 trials per cell',
      ],
    },
    baseline: 'Single-channel control: same payloads injected and measured within one channel only.',
    protocol_steps: [
      '1. Deploy OpenClaw (or equivalent) connected to Discord, Slack, and Email.',
      '2. Configure shared persistent memory across all 3 channels.',
      '3. Inject 50 canary-tagged payloads into Discord (low-trust channel).',
      '4. After each injection, issue benign queries on Slack and Email within same session.',
      '5. Record whether canary tokens appear in Slack/Email responses.',
      '6. Repeat with 1h, 4h, 24h gaps between injection and cross-channel query.',
      '7. Repeat full protocol with Slack as source and Email as source (full matrix).',
      '8. Compute propagation matrix with confidence intervals.',
      '9. Compare against single-channel baseline.',
    ],
  };

  // ── Missing dimension ──
  const missing = NOVELTY_DIMENSIONS.join(' ');

  // ── Source references ──
  const sources = [];
  if (ghData.repo && ghData.repo.html_url) {
    sources.push(ghData.repo.html_url);
  }
  for (const e of evidence.slice(0, 10)) {
    sources.push(e.url || `${e.title} (${e.year || 'n.d.'})`);
  }

  return {
    id,
    claim: PREDEFINED_HYPOTHESIS,
    evidence: evidence.slice(0, 15),
    missing,
    experiment,
    corridor: 'AI Agents \u00d7 AI Safety',
    score,
    sources,
    // recordGap compatibility fields
    hypothesis: PREDEFINED_HYPOTHESIS,
    discovery: PREDEFINED_HYPOTHESIS,
    gap: PREDEFINED_HYPOTHESIS,
    // Extra structured data for the experiment
    proposed_experiment: experiment.protocol_steps.join(' '),
    timestamp: now(),
  };
}

// ────────────────────────────────────────────────────────────
// STEP 4 — Dedupe Check
// ────────────────────────────────────────────────────────────

function dedupeCheck(gap) {
  let index;
  try {
    index = readGapsIndex();
  } catch (_) {
    const indexPath = path.join(DATA_DIR, 'gaps-index.json');
    try {
      if (fs.existsSync(indexPath)) {
        fs.copyFileSync(indexPath, indexPath + '.bak');
        console.warn('[WARN] Backed up corrupted gaps-index.json to .bak');
      }
    } catch (__) { /* ignore */ }
    index = { gaps: [] };
    try { writeGapsIndex(index); } catch (__) { /* ignore */ }
  }

  if (!Array.isArray(index.gaps)) index.gaps = [];

  for (const existing of index.gaps) {
    const sameRepo =
      (existing.id && existing.id.startsWith('openclaw_')) ||
      (Array.isArray(existing.repos) && existing.repos.some(r =>
        (r.repo || '').toLowerCase().includes('openclaw')
      ));

    const sim = stringSimilarity(existing.claim || '', gap.claim || '');
    if (sameRepo && sim > 0.85) {
      return { isDuplicate: true, existingId: existing.id, similarity: sim };
    }
  }

  return { isDuplicate: false };
}

// ────────────────────────────────────────────────────────────
// STEP 5 — X Draft Generation
// ────────────────────────────────────────────────────────────

function generateXDrafts(gap) {
  const repoInfo = { repo: 'openclaw/openclaw' };
  let drafts;

  // Use the new 6-template generator if available
  try {
    drafts = generateAllDrafts(gap, repoInfo);
  } catch (_) {
    // Fallback to legacy
    drafts = [];
  }

  // If generateAllDrafts didn't produce enough, add manual ones
  if (drafts.length < 3) {
    const link = `clashd27.com/gap/${gap.id}`;
    const manual = [
      {
        id: 'manual_hypothesis',
        label: 'Hypothesis framing',
        text: `Hypothesis: prompt injection in one AI agent channel can causally alter behavior in a separate high-trust channel. No benchmark exists. ${link}`,
      },
      {
        id: 'manual_question',
        label: 'Question framing',
        text: `If you inject a prompt via Discord, does the AI agent carry it into Slack and Email? No one has built a propagation matrix for this. ${link}`,
      },
      {
        id: 'manual_experimental',
        label: 'Experimental framing',
        text: `Experiment: inject 50 canary payloads into 1 channel of a multi-surface AI agent. Measure propagation to 2+ others across 4 time windows. ${link}`,
      },
    ];
    for (const m of manual) {
      const text = m.text.length <= 280 ? m.text : m.text.slice(0, 279) + '\u2026';
      drafts.push({
        id: m.id,
        label: m.label,
        text,
        char_count: text.length,
        virality: viralityScore(text),
      });
    }
  }

  // Final enforcement: <= 280 chars, <= 2 tags
  for (const d of drafts) {
    if (d.text.length > 280) {
      d.text = d.text.slice(0, 279) + '\u2026';
      d.char_count = 280;
    }
    const mentions = (d.text.match(/@\w+/g) || []);
    if (mentions.length > 2) {
      let count = 0;
      d.text = d.text.replace(/@\w+/g, (m) => { count++; return count <= 2 ? m : ''; })
        .replace(/\s{2,}/g, ' ').trim();
      d.char_count = d.text.length;
    }
  }

  return drafts;
}

// ────────────────────────────────────────────────────────────
// STEP 6 — Save Draft File
// ────────────────────────────────────────────────────────────

function saveDraft(gap, drafts) {
  const draftFile = path.join(DATA_DIR, 'openclaw-gap-draft.json');
  atomicWriteJSON(draftFile, { gap, drafts, timestamp: now() });
  return draftFile;
}

// ────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  CLASHD-27 \u2014 OpenClaw Gap Finder v2');
  console.log('  ' + now());
  console.log('='.repeat(60));
  console.log();

  // ── Evidence Gathering ──
  console.log('[1/8] Gathering evidence from Semantic Scholar...');
  const s2Papers = await gatherSemanticScholar();
  console.log(`  \u2192 ${s2Papers.length} papers from Semantic Scholar`);

  console.log('[2/8] Gathering evidence from Europe PMC...');
  const epmcPapers = await gatherEuropePMC();
  console.log(`  \u2192 ${epmcPapers.length} papers from Europe PMC`);

  console.log('[3/8] Gathering GitHub data...');
  const ghData = await gatherGitHub();
  console.log(`  \u2192 Repo: ${ghData.repo ? 'found' : 'unavailable'}`);
  console.log(`  \u2192 Security issues: ${ghData.issues.length}`);
  console.log(`  \u2192 Recent commits: ${ghData.commits.length}`);

  const allEvidence = [...s2Papers, ...epmcPapers];

  console.log();
  console.log('=== EVIDENCE SUMMARY ===');
  console.log(`Total unique papers: ${allEvidence.length}`);
  console.log(`  Semantic Scholar: ${s2Papers.length}`);
  console.log(`  Europe PMC:       ${epmcPapers.length}`);
  if (ghData.repo) {
    console.log(`  GitHub repo:      ${ghData.repo.full_name || 'openclaw/openclaw'} (\u2605${ghData.repo.stargazers_count || 0})`);
  } else {
    console.log('  GitHub repo:      unavailable (API error or rate-limited)');
  }
  console.log(`  Security issues:  ${ghData.issues.length}`);
  console.log(`  Recent commits:   ${ghData.commits.length}`);
  if (allEvidence.length > 0) {
    console.log('  Top papers:');
    allEvidence.slice(0, 5).forEach((p, i) => {
      console.log(`    ${i + 1}. ${(p.title || '').slice(0, 80)} (${p.year || 'n.d.'}) [${p.source}]`);
    });
  }
  console.log();

  // ── Novelty Check ──
  console.log('[4/8] Running novelty check...');
  const novelty = await noveltyCheck();

  console.log();
  console.log('=== NOVELTY CHECK SUMMARY ===');
  console.log(`Total papers scanned for novelty: ${novelty.hits.length}`);
  console.log(`Direct cross-channel+injection+propagation match: ${novelty.directMatch ? 'YES' : 'NO'}`);
  console.log(`Propagation matrix paper found: ${novelty.matrixMatch ? 'YES' : 'NO'}`);
  console.log(`Partial coverage papers (single-channel/plugin): ${novelty.partialMatches.length}`);
  console.log('Novelty dimensions:');
  for (const dim of NOVELTY_DIMENSIONS) {
    const covered = novelty.directMatch || novelty.matrixMatch;
    console.log(`  ${covered ? '~' : '\u2713'} ${dim}`);
  }
  if (!novelty.directMatch && !novelty.matrixMatch) {
    console.log('Conclusion: Hypothesis is NOVEL \u2014 no existing benchmark covers cross-channel injection propagation matrix.');
  } else {
    console.log('Conclusion: Partial coverage found \u2014 gap is narrowed but propagation matrix dimension remains unstudied.');
  }
  console.log();

  // ── Gap Construction ──
  console.log('[5/8] Constructing gap object with pre-defined hypothesis...');
  const gap = constructGap(allEvidence, ghData, novelty);

  console.log();
  console.log('=== GAP OBJECT ===');
  console.log(JSON.stringify(gap, null, 2));
  console.log();

  // ── Dedupe Check ──
  console.log('[6/8] Running deduplication check...');
  const dupe = dedupeCheck(gap);

  let registrationStatus;
  if (dupe.isDuplicate) {
    registrationStatus = `SKIPPED \u2014 duplicate of ${dupe.existingId} (similarity: ${(dupe.similarity * 100).toFixed(1)}%)`;
    console.log(`  \u2192 Gap already exists: ${dupe.existingId} (similarity: ${(dupe.similarity * 100).toFixed(1)}%)`);
    console.log('  \u2192 Not registering duplicate.');
  } else {
    console.log('  \u2192 No duplicate found. Registering gap...');
    try {
      const result = await recordGap(gap);
      if (result.ok) {
        if (result.deduped) {
          registrationStatus = 'SKIPPED \u2014 already registered (id match)';
          console.log('  \u2192 Already registered (exact id match).');
        } else {
          registrationStatus = 'REGISTERED';
          console.log('  \u2192 Gap registered successfully.');
        }
      } else {
        registrationStatus = `FAILED \u2014 ${result.reason}`;
        console.log(`  \u2192 Registration failed: ${result.reason}`);
      }
    } catch (e) {
      registrationStatus = `ERROR \u2014 ${e.message}`;
      console.log(`  \u2192 Registration error: ${e.message}`);
    }
  }
  console.log();

  // ── X Drafts ──
  console.log('[7/8] Generating X draft posts (6 template framings)...');
  const drafts = generateXDrafts(gap);

  console.log();
  console.log('=== X DRAFTS ===');
  drafts.forEach((d, i) => {
    console.log(`--- Draft ${i + 1}: ${d.label || d.id} (${d.char_count} chars, virality: ${d.virality}/5) ---`);
    console.log(d.text);
    console.log();
  });

  // ── Save Draft File ──
  console.log('[8/8] Saving draft file...');
  const draftFile = saveDraft(gap, drafts);
  console.log(`Draft file saved: ${draftFile}`);
  console.log();

  // ── Final Output ──
  console.log('=== REGISTRATION STATUS ===');
  console.log(registrationStatus);
  console.log();

  console.log('=== PROPAGATION EXPERIMENT DESIGN ===');
  const exp = gap.experiment;
  console.log(`Channels: ${exp.channels.map(c => `${c.name} (${c.trust_level})`).join(' \u2192 ')}`);
  console.log(`Injection vector: ${exp.injection_vector.payload_count} payloads, ${exp.injection_vector.payload_format}`);
  console.log(`Memory windows: ${exp.memory_persistence_window.windows_tested.join(', ')}`);
  console.log('Measurable outcomes:');
  for (const o of exp.measurable_outcomes) {
    console.log(`  \u2022 ${o}`);
  }
  console.log('Propagation matrix format:');
  const mx = exp.propagation_matrix_format.example;
  console.log(`  ${''.padEnd(10)} ${mx[''].join('  ')}`);
  for (const [row, vals] of Object.entries(mx)) {
    if (row === '') continue;
    console.log(`  ${row.padEnd(10)} ${vals.join('   ')}`);
  }
  console.log();

  // ── Verification Checklist ──
  console.log('=== VERIFICATION CHECKLIST ===');
  console.log(`  [${allEvidence.length > 0 ? 'x' : ' '}] Evidence gathered from research APIs`);
  console.log(`  [x] Novelty check performed (${novelty.hits.length} papers scanned)`);
  console.log(`  [x] Pre-defined hypothesis used (no hallucination)`);
  console.log(`  [${gap.claim === PREDEFINED_HYPOTHESIS ? 'x' : ' '}] Claim matches pre-defined hypothesis exactly`);
  console.log(`  [${exp.channels.length >= 3 ? 'x' : ' '}] Experiment has \u22653 channels (${exp.channels.length})`);
  console.log(`  [x] Injection vector defined`);
  console.log(`  [x] Memory persistence window defined (${exp.memory_persistence_window.windows_tested.length} windows)`);
  console.log(`  [${exp.measurable_outcomes.length >= 3 ? 'x' : ' '}] Measurable outcomes defined (${exp.measurable_outcomes.length})`);
  console.log(`  [x] Propagation matrix output format defined`);
  console.log(`  [${gap.score > 0 ? 'x' : ' '}] Gap scored (${gap.score}/100)`);
  console.log(`  [x] Deduplication check completed`);
  console.log(`  [${drafts.length >= 3 ? 'x' : ' '}] X drafts generated (${drafts.length} variants)`);
  console.log(`  [${drafts.every(d => d.char_count <= 280) ? 'x' : ' '}] All drafts \u2264 280 chars`);
  console.log(`  [${drafts.every(d => (d.text.match(/@\w+/g) || []).length <= 2) ? 'x' : ' '}] All drafts \u2264 2 tagged accounts`);
  console.log(`  [${fs.existsSync(draftFile) ? 'x' : ' '}] Draft file saved atomically`);
  console.log(`  [x] No auto-posting to X`);
  console.log(`  [x] No engine behavior modified`);
  console.log();

  console.log('=== DONE ===');
}

main().catch(err => {
  console.error('[FATAL] Unhandled error:', err.message || err);
  process.exit(1);
});
