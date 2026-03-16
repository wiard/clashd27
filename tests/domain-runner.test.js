'use strict';

const fs = require('fs');
const path = require('path');

const { loadDomains } = require('../src/domains/domain-config');
const { runDomainCycle } = require('../src/domains/domain-runner');
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
  return path.join('/tmp', `clashd27-domain-${label}-${process.pid}-${Date.now()}.${ext}`);
}

function makeLibrary() {
  const libraryFile = tmpFile('library', 'jsonl');
  const indexFile = tmpFile('index', 'json');
  const domainsDir = tmpFile('domains', 'dir');
  [libraryFile, indexFile].forEach((file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  if (fs.existsSync(domainsDir)) fs.rmSync(domainsDir, { recursive: true, force: true });
  return new GapLibrary({ libraryFile, indexFile, domainsDir });
}

function makePacket(overrides = {}) {
  const packetId = overrides.packetId || 'gap-alpha';
  const title = overrides.title || 'Gap proposal: Consent boundary for operator memory';
  return {
    packetId,
    createdAt: overrides.createdAt || '2026-03-16T00:00:00.000Z',
    scores: {
      total: overrides.score || 0.74
    },
    hypothesis: {
      statement: overrides.hypothesis || 'Operators need a clearer consent boundary for autonomous agent memory.'
    },
    candidate: {
      explanation: title,
      axes: overrides.axes || [
        { what: 'architecture', where: 'engine', time: 'current' }
      ]
    },
    cube: {
      cells: overrides.cells || [17]
    },
    gapProposalHandoff: {
      packet: {
        title
      }
    }
  };
}

function makeCubeEngine() {
  const state = { signals: [] };
  return {
    ingestSignal(signal) {
      state.signals.push({
        signalId: signal.id,
        cellId: state.signals.length % 27
      });
    },
    getState() {
      return state;
    }
  };
}

async function run() {
  const allDomains = loadDomains();
  assert('loadDomains() returns all enabled domains', allDomains.length === 7);

  const single = loadDomains({ domainId: 'ai-safety' });
  assert('loadDomains({ domainId }) returns a single domain', single.length === 1 && single[0].id === 'ai-safety');

  const mockDomain = {
    id: 'ai-governance',
    label: 'AI Governance',
    queries: ['consent architecture'],
    sources: ['openalex'],
    sourceWeight: 1.5,
    minScore: 0.55
  };

  const library = makeLibrary();
  const result = await runDomainCycle(mockDomain, makeCubeEngine(), {
    library,
    tick: 42,
    fetchPapers: async () => [{
      paperId: 'paper-1',
      title: 'Consent Architecture for Operator Memory',
      abstract: 'This paper proposes a governed architecture method for operator memory boundaries and explains a limitation in current approval flows.',
      authors: ['Ada Lovelace'],
      year: 2026,
      citationCount: 12,
      source: 'OpenAlex',
      domain: 'ai-governance'
    }],
    runDiscoveryCycle: () => ({
      gapDiscovery: {
        packets: [makePacket()]
      },
      gapProposalHandoffs: [{
        packetId: 'gap-alpha',
        proposal: { intent: { key: 'gap-alpha' } }
      }]
    })
  });

  assert('runDomainCycle() produces gap results for mock domain', result.gapsFound === 1 && result.handoffs.length === 1);

  const first = library.queryByDomain('ai-governance');
  assert('library correctly tags gaps with domainId', first.length === 1 && first[0].domainId === 'ai-governance');

  library.addOrUpdate(makePacket({
    packetId: 'gap-cross',
    title: 'Gap proposal: Shared frontier for safety and law',
    hypothesis: 'A shared frontier exists between safety verification and legal accountability.',
    score: 0.77
  }), [{
    paperId: 'paper-2',
    title: 'Shared frontier for safety and law',
    abstract: 'A detailed abstract about safety verification and legal accountability in AI.',
    authors: ['Grace Hopper'],
    source: 'Crossref',
    domain: 'ai-safety',
    cells: ['cell-17'],
    signalCount: 1,
    citationCount: 4
  }], 'run-2', { id: 'ai-safety', label: 'AI Safety' });

  library.addOrUpdate(makePacket({
    packetId: 'gap-cross-2',
    title: 'Gap proposal: Shared frontier for safety and law',
    hypothesis: 'A shared frontier exists between safety verification and legal accountability.',
    score: 0.79
  }), [{
    paperId: 'paper-3',
    title: 'Shared frontier for safety and law',
    abstract: 'A detailed abstract about safety verification and legal accountability in legal AI.',
    authors: ['Alan Turing'],
    source: 'Semantic Scholar',
    domain: 'legal-ai',
    cells: ['cell-17'],
    signalCount: 1,
    citationCount: 9
  }], 'run-3', { id: 'legal-ai', label: 'Legal AI' });

  const crossDomain = library.findCrossDomainGaps();
  assert('Cross-domain detection works when same gap appears in 2 domains', crossDomain.length >= 1 && crossDomain[0].crossDomain === true);

  const stats = library.domainStats();
  assert('domainStats() returns correct per-domain counts', stats['ai-safety'] && stats['legal-ai'] && stats['ai-safety'].count >= 1);

  const filteredCrossDomain = library.findCrossDomainGaps().every((entry) => (entry.domainHistory || []).map((item) => item.domainId).filter((value, index, list) => list.indexOf(value) === index).length >= 2);
  assert('findCrossDomainGaps() returns only gaps in 2+ domains', filteredCrossDomain === true);

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
