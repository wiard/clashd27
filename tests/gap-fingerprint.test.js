'use strict';

const fs = require('fs');
const path = require('path');

const { GapLibrary, calculateTrend, deriveStatus } = require('../src/library/gap-library');
const {
  areSameGap,
  fingerprintGap,
  similarityScore
} = require('../src/library/gap-fingerprint');
const { migrateLibrary } = require('../src/library/gap-library-migrator');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    failed += 1;
    return;
  }
  console.log(`[PASS] ${name}`);
  passed += 1;
}

function tmpPath(label, ext = 'tmp') {
  return path.join('/tmp', `clashd27-fingerprint-${label}-${process.pid}-${Date.now()}.${ext}`);
}

function tmpDir(label) {
  return path.join('/tmp', `clashd27-fingerprint-${label}-${process.pid}-${Date.now()}`);
}

function makeLibrary() {
  const libraryFile = tmpPath('library', 'jsonl');
  const indexFile = tmpPath('index', 'json');
  const domainsDir = tmpDir('domains');
  [libraryFile, indexFile].forEach((file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  if (fs.existsSync(domainsDir)) fs.rmSync(domainsDir, { recursive: true, force: true });
  return new GapLibrary({ libraryFile, indexFile, domainsDir });
}

function makePacket(overrides = {}) {
  const title = overrides.title || 'Gap proposal: Consent boundary for autonomous agent memory';
  return {
    packetId: overrides.packetId || 'gap-alpha',
    createdAt: overrides.createdAt || '2026-03-16T03:00:00.000Z',
    scores: {
      total: overrides.score == null ? 0.64 : overrides.score
    },
    hypothesis: {
      statement: overrides.hypothesis || 'Signals clustered in surface/engine/current indicate an ungoverned capability for operator memory boundaries.'
    },
    candidate: {
      type: overrides.candidateType || 'collision_intersection',
      explanation: title,
      axes: overrides.axes || [
        { what: 'surface', where: 'engine', time: 'current' },
        { what: 'architecture', where: 'engine', time: 'emerging' }
      ]
    },
    cube: {
      cells: overrides.cells || [7, 16]
    },
    gapProposalHandoff: {
      packet: {
        title
      }
    }
  };
}

function makePapers(domainId = 'ai-governance') {
  return [
    {
      paperId: `paper-${domainId}-1`,
      title: `Paper for ${domainId}`,
      abstract: 'Detailed abstract',
      authors: ['Ada Lovelace'],
      url: `https://example.test/${domainId}`,
      source: 'OpenAlex',
      domain: domainId,
      cells: ['surface/engine/current', 'architecture/engine/emerging'],
      signalCount: 2,
      citationCount: 10
    }
  ];
}

function makeDomain(id, label) {
  return { id, label };
}

async function run() {
  const basePacket = makePacket();
  const samePacket = makePacket();
  const differentPacket = makePacket({
    packetId: 'gap-beta',
    title: 'Gap proposal: Multimodal reasoning boundary',
    hypothesis: 'Signals clustered in trust-model/engine/emerging indicate a missing multimodal reasoning safeguard.',
    axes: [{ what: 'trust-model', where: 'engine', time: 'emerging' }],
    cells: [24],
    candidateType: 'cluster_peak'
  });
  const crossDomainPacket = makePacket();

  assert('Same gap packet produces same fingerprint across calls', fingerprintGap(basePacket) === fingerprintGap(samePacket));
  assert('Different gap packets produce different fingerprints', fingerprintGap(basePacket) !== fingerprintGap(differentPacket));
  assert(
    'Gap with different domainId but same cells/hypothesis produces same fingerprint',
    fingerprintGap(basePacket) === fingerprintGap({ ...crossDomainPacket, domainId: 'healthcare-ai' })
  );
  assert('areSameGap() returns true for identical packets', areSameGap(basePacket, samePacket) === true);

  const nearDuplicatePacket = makePacket({
    packetId: 'gap-near',
    hypothesis: 'Signals clustered in surface/engine/current indicate an ungoverned capability for operator memory boundary.'
  });
  assert('similarityScore() returns > 0.85 for near-duplicate packets', similarityScore(basePacket, nearDuplicatePacket) > 0.85);
  assert('similarityScore() returns < 0.5 for unrelated packets', similarityScore(basePacket, differentPacket) < 0.5);

  const library = makeLibrary();
  const first = library.addOrUpdate(basePacket, makePapers('ai-governance'), 'nightly-1', makeDomain('ai-governance', 'AI Governance'));
  const second = library.addOrUpdate(makePacket({ score: 0.72, createdAt: '2026-03-17T03:00:00.000Z' }), makePapers('ai-governance'), 'nightly-2', makeDomain('ai-governance', 'AI Governance'));
  assert('Score history appends correctly on second addOrUpdate', second.entry.scoreHistory.length === 2 && second.entry.runCount === 2);

  assert('calculateTrend() returns "rising" when last score > first by 0.05', calculateTrend([
    { score: 0.61 },
    { score: 0.69 }
  ]) === 'rising');
  assert('calculateTrend() returns "falling" when last score < first by 0.05', calculateTrend([
    { score: 0.74 },
    { score: 0.65 }
  ]) === 'falling');
  assert('calculateTrend() returns "stable" for small delta', calculateTrend([
    { score: 0.70 },
    { score: 0.73 }
  ]) === 'stable');

  assert('deriveStatus() returns "new" for runCount === 1', deriveStatus({
    runCount: 1,
    score: 0.5,
    lastSeenAtIso: '2026-03-16T03:00:00.000Z'
  }, Date.parse('2026-03-16T03:00:00.000Z')) === 'new');
  assert('deriveStatus() returns "strong" for runCount >= 2 and score >= 0.7', deriveStatus({
    runCount: 2,
    score: 0.72,
    lastSeenAtIso: '2026-03-16T03:00:00.000Z'
  }, Date.parse('2026-03-16T03:00:00.000Z')) === 'strong');
  assert('deriveStatus() returns "aging" for gap not seen in 14 days', deriveStatus({
    runCount: 2,
    score: 0.62,
    lastSeenAtIso: '2026-03-01T03:00:00.000Z'
  }, Date.parse('2026-03-16T03:00:00.000Z')) === 'aging');

  const migrateLibraryFile = tmpPath('migrate-library', 'jsonl');
  const migrateIndexFile = tmpPath('migrate-index', 'json');
  const migrateDomainsDir = tmpDir('migrate-domains');
  const oldEntries = [
    {
      libraryId: 'lib-old-1',
      gapId: 'gap-old-1',
      title: 'Gap proposal: Consent boundary for autonomous agent memory',
      hypothesis: 'Signals clustered in surface/engine/current indicate an ungoverned capability for operator memory boundaries.',
      cells: ['architecture/engine/emerging', 'surface/engine/current'],
      score: 0.64,
      scoreHistory: [0.64],
      domainId: 'ai-governance',
      domainLabel: 'AI Governance',
      runCount: 1,
      lastSeenAtIso: '2026-03-16T03:00:00.000Z',
      discoveredAtIso: '2026-03-16T03:00:00.000Z',
      candidateType: 'collision_intersection'
    },
    {
      libraryId: 'lib-old-2',
      gapId: 'gap-old-2',
      title: 'Gap proposal: Consent boundary for autonomous agent memory',
      hypothesis: 'Signals clustered in surface/engine/current indicate an ungoverned capability for operator memory boundary.',
      cells: ['surface/engine/current', 'architecture/engine/emerging'],
      score: 0.71,
      scoreHistory: [0.64, 0.71],
      domainHistory: [
        {
          domainId: 'ai-governance',
          domainLabel: 'AI Governance',
          runId: 'nightly-1',
          score: 0.64,
          date: '2026-03-16T03:00:00.000Z'
        },
        {
          domainId: 'healthcare-ai',
          domainLabel: 'Healthcare AI',
          runId: 'nightly-2',
          score: 0.71,
          date: '2026-03-17T03:00:00.000Z'
        }
      ],
      runCount: 2,
      lastSeenAtIso: '2026-03-17T03:00:00.000Z',
      discoveredAtIso: '2026-03-16T03:00:00.000Z',
      candidateType: 'collision_intersection'
    }
  ];
  fs.writeFileSync(migrateLibraryFile, `${oldEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  const migration = await migrateLibrary({
    libraryFile: migrateLibraryFile,
    indexFile: migrateIndexFile,
    domainsDir: migrateDomainsDir
  });
  const migratedLibrary = new GapLibrary({
    libraryFile: migrateLibraryFile,
    indexFile: migrateIndexFile,
    domainsDir: migrateDomainsDir
  });

  assert('Migration adds fingerprint to entry without one', migration.fingerprintedEntries >= 1 && migratedLibrary.query()[0].fingerprint);
  assert('Migration detects and merges near-duplicates', migration.mergedDuplicates >= 1 && migratedLibrary.query().length === 1);

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
