'use strict';

const fs = require('fs');
const path = require('path');

const { GapLibrary } = require('../src/library/gap-library');

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

function tmpFile(label, ext) {
  return path.join('/tmp', `clashd27-gap-library-${label}-${process.pid}-${Date.now()}.${ext}`);
}

function makeLibrary() {
  const libraryFile = tmpFile('library', 'jsonl');
  const indexFile = tmpFile('index', 'json');
  [libraryFile, indexFile].forEach((file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  return new GapLibrary({ libraryFile, indexFile });
}

function makePacket(overrides = {}) {
  const packetId = overrides.packetId || 'gap-alpha';
  return {
    packetId,
    createdAt: overrides.createdAt || '2026-03-16T00:00:00.000Z',
    scores: {
      total: overrides.score || 0.71
    },
    hypothesis: {
      statement: overrides.hypothesis || 'Operators need a clearer consent boundary for autonomous agent memory.'
    },
    candidate: {
      explanation: overrides.title || 'Gap proposal: Consent boundary for autonomous agent memory',
      axes: overrides.axes || [
        { what: 'trust-model', where: 'engine', time: 'emerging' }
      ]
    },
    cube: {
      cells: overrides.cells || [24]
    },
    gapProposalHandoff: {
      packet: {
        title: overrides.title || 'Gap proposal: Consent boundary for autonomous agent memory'
      }
    }
  };
}

function makePapers() {
  return [
    {
      paperId: 'paper-1',
      title: 'Consent Scoping in Agent Memory',
      abstract: 'Detailed abstract',
      authors: ['Ada Lovelace'],
      url: 'https://example.test/paper-1',
      source: 'OpenAlex',
      domain: 'ai-safety',
      cells: ['trust-model/engine/emerging'],
      signalCount: 2,
      citationCount: 12
    }
  ];
}

function run() {
  const library = makeLibrary();
  const first = library.addOrUpdate(makePacket(), makePapers(), 'run-1');
  assert('addOrUpdate() adds new gap correctly', first.isNew === true && first.entry.runCount === 1);

  const second = library.addOrUpdate(makePacket({ score: 0.78 }), makePapers(), 'run-2');
  assert('addOrUpdate() updates existing gap and increments runCount', second.isNew === false && second.entry.runCount === 2);
  assert('scoreTrend is "rising" when latest score > previous', second.entry.scoreTrend === 'rising');

  library.addOrUpdate(makePacket({
    packetId: 'gap-beta',
    title: 'Gap proposal: Architecture review for bounded execution',
    hypothesis: 'Architecture review is missing for bounded execution.',
    axes: [{ what: 'architecture', where: 'engine', time: 'current' }],
    cells: [17],
    score: 0.66
  }), [{
    paperId: 'paper-2',
    title: 'Bounded Execution Architecture',
    abstract: 'Detailed abstract',
    authors: ['Grace Hopper'],
    url: 'https://example.test/paper-2',
    source: 'Crossref',
    domain: 'ai-governance',
    cells: ['architecture/engine/current'],
    signalCount: 1,
    citationCount: 4
  }], 'run-3');

  const governanceOnly = library.query({ domain: 'ai-governance' });
  assert('query() filters by domain correctly', governanceOnly.length === 1 && governanceOnly[0].domain === 'ai-governance');

  const sorted = library.query({ sortBy: 'score' });
  assert('query() sorts by score correctly', sorted[0].score >= sorted[1].score);

  const stats = library.stats();
  assert('stats() returns correct counts', stats.totalGaps === 2 && stats.byStatus.confirmed === 1);

  const exported = library.export('json');
  const parsed = JSON.parse(exported);
  assert('export() produces valid JSON', Array.isArray(parsed) && parsed.length === 2);

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
