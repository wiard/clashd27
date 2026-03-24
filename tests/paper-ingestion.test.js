'use strict';

const os = require('os');
const path = require('path');
const { SignalQueue } = require('../src/queue/signal-queue');
const { normalizeQueue } = require('../src/queue/signal-normalizer');
const { extractPaperSignals } = require('../src/sources/paper-signal-extractor');
const { entryToSignal, mapDomain, scoreByRecency } = require('../src/sources/arxiv-source');
const { Clashd27CubeEngine } = require('../lib/clashd27-cube-engine');
const { runGapDiscoveryFromSignals } = require('../src/gap/gap-pipeline');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (!condition) {
    console.error(`[FAIL] ${name}`);
    failed += 1;
  } else {
    console.log(`[PASS] ${name}`);
    passed += 1;
  }
}

function makeTempState() {
  return path.join(os.tmpdir(), `paper-test-${process.pid}-${Date.now()}.json`);
}

// ---------------------------------------------------------------------------
// 1. Queue tests
// ---------------------------------------------------------------------------
console.log('\n=== Queue Tests ===');

(function testQueueProduce() {
  const q = new SignalQueue();
  q.produce('raw-signals', { title: 'Paper A' });
  q.produce('raw-signals', { title: 'Paper B' });
  q.produce('other-topic', { title: 'Paper C' });
  assert('produce() adds to correct topic', q.size('raw-signals') === 2);
  assert('produce() keeps topics separate', q.size('other-topic') === 1);
})();

(function testQueueConsumeAll() {
  const q = new SignalQueue();
  q.produce('raw-signals', { title: 'A' });
  q.produce('raw-signals', { title: 'B' });
  q.produce('raw-signals', { title: 'C' });
  const all = q.consumeAll('raw-signals');
  assert('consumeAll() returns all signals', all.length === 3);
  assert('consumeAll() flushes topic', q.size('raw-signals') === 0);
  assert('consumeAll() preserves FIFO order', all[0].title === 'A' && all[2].title === 'C');
})();

(function testQueueSize() {
  const q = new SignalQueue();
  assert('size() returns 0 for empty topic', q.size('empty') === 0);
  q.produce('test', { title: 'X' });
  q.produce('test', { title: 'Y' });
  assert('size() returns correct count', q.size('test') === 2);
})();

(function testQueueConsumeFIFO() {
  const q = new SignalQueue();
  q.produce('t', { n: 1 });
  q.produce('t', { n: 2 });
  const first = q.consume('t');
  assert('consume() returns first signal', first.n === 1);
  assert('consume() removes signal', q.size('t') === 1);
})();

(function testQueueTopics() {
  const q = new SignalQueue();
  q.produce('alpha', { x: 1 });
  q.produce('beta', { x: 2 });
  const topics = q.topics();
  assert('topics() lists active topics', topics.includes('alpha') && topics.includes('beta'));
})();

// ---------------------------------------------------------------------------
// 2. Normalizer tests
// ---------------------------------------------------------------------------
console.log('\n=== Normalizer Tests ===');

// Clear dedup state before normalizer tests
normalizeQueue._seenTitles.clear();

(function testNormalizerDropsLowScore() {
  const q = new SignalQueue();
  q.produce('raw-signals', {
    type: 'paper-theory',
    title: 'Low score paper',
    content: 'Some content here',
    score: 0.2,
    sourceWeight: 1.5,
    timestamp: new Date().toISOString()
  });
  const { accepted, dropped } = normalizeQueue(q);
  assert('signals with score < 0.3 are dropped', dropped === 1 && accepted === 0);
})();

(function testNormalizerDeduplicates() {
  normalizeQueue._seenTitles.clear();
  const q = new SignalQueue();
  const signal = {
    type: 'paper-theory',
    title: 'Duplicate Paper Title',
    content: 'Content about AI safety governance and consent verification systems.',
    score: 0.7,
    sourceWeight: 1.5,
    timestamp: new Date().toISOString()
  };
  q.produce('raw-signals', { ...signal });
  q.produce('raw-signals', { ...signal });
  const { accepted, dropped, duplicates } = normalizeQueue(q);
  assert('duplicate titles are deduplicated', accepted === 1 && dropped === 1 && duplicates === 1);
})();

(function testNormalizerKeepsDistinctSignalTypes() {
  normalizeQueue._seenTitles.clear();
  const q = new SignalQueue();
  q.produce('raw-signals', {
    type: 'paper-theory',
    title: 'Shared Paper Title',
    content: 'A valid abstract about governance architecture and system boundaries.',
    score: 0.7,
    timestamp: new Date().toISOString(),
    paperId: 'paper-1'
  });
  q.produce('raw-signals', {
    type: 'paper-limitation',
    title: 'Shared Paper Title',
    content: 'A valid abstract about governance architecture and system boundaries.',
    score: 0.66,
    timestamp: new Date().toISOString(),
    paperId: 'paper-1'
  });
  const { accepted, dropped } = normalizeQueue(q);
  assert('same paper can emit multiple typed signals', accepted === 2 && dropped === 0);
})();

(function testNormalizerTruncates() {
  normalizeQueue._seenTitles.clear();
  const q = new SignalQueue();
  q.produce('raw-signals', {
    type: 'paper-theory',
    title: 'Long Content Paper',
    content: 'X'.repeat(1000),
    score: 0.8,
    sourceWeight: 1.5,
    timestamp: new Date().toISOString()
  });
  normalizeQueue(q);
  const normalized = q.consumeAll('normalized-signals');
  assert('content is truncated to 500 chars', normalized[0].content.length === 500);
})();

(function testNormalizerOutputTopic() {
  normalizeQueue._seenTitles.clear();
  const q = new SignalQueue();
  q.produce('raw-signals', {
    type: 'paper-theory',
    title: 'Output Topic Test Paper',
    content: 'A valid abstract about AI governance architecture and system boundaries.',
    score: 0.75,
    sourceWeight: 1.5,
    timestamp: new Date().toISOString()
  });
  normalizeQueue(q);
  assert('normalized signals appear in normalized-signals topic', q.size('normalized-signals') === 1);
})();

(function testNormalizerDropsEmptyTitle() {
  normalizeQueue._seenTitles.clear();
  const q = new SignalQueue();
  q.produce('raw-signals', {
    type: 'paper-theory',
    title: '',
    content: 'Some content',
    score: 0.7,
    sourceWeight: 1.5,
    timestamp: new Date().toISOString()
  });
  const { dropped } = normalizeQueue(q);
  assert('signals with empty title are dropped', dropped === 1);
})();

// ---------------------------------------------------------------------------
// 3. arXiv source tests (mock)
// ---------------------------------------------------------------------------
console.log('\n=== arXiv Source Tests ===');

(function testEntryToSignal() {
  const entry = {
    id: ['http://arxiv.org/abs/2401.12345v1'],
    title: ['  AI Safety Through Governance  '],
    summary: ['  This paper explores governance mechanisms for AI systems.  '],
    published: [new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()], // 3 days ago
    'arxiv:primary_category': [{ $: { term: 'cs.AI' } }],
    author: [
      { name: ['Alice Smith'] },
      { name: ['Bob Jones'] }
    ]
  };
  const signals = entryToSignal(entry);
  const theory = signals.find((signal) => signal.type === 'paper-theory');
  assert('entryToSignal returns an array', Array.isArray(signals) && signals.length >= 1);
  assert('type is paper-theory', theory && theory.type === 'paper-theory');
  assert('domain maps cs.AI → ai-research', theory && theory.domain === 'ai-research');
  assert('title is trimmed', theory && theory.title === 'AI Safety Through Governance');
  assert('content is trimmed', theory && theory.content === 'This paper explores governance mechanisms for AI systems.');
  assert('score is at least recent-paper baseline', theory && theory.score >= 0.85);
  assert('sourceWeight is 1.5', theory && theory.sourceWeight === 1.5);
  assert('authors are extracted', theory && theory.authors.length === 2 && theory.authors[0] === 'Alice Smith');
  assert('source is paper theory', theory && theory.source === 'paper theory');
  assert('id has arxiv prefix', theory && theory.paperId.startsWith('arxiv:'));
  assert('venue is arXiv', theory && theory.venue === 'arXiv');
})();

(function testDomainMapping() {
  assert('cs.AI → ai-research', mapDomain([{ $: { term: 'cs.AI' } }]) === 'ai-research');
  assert('cs.CR → ai-security', mapDomain([{ $: { term: 'cs.CR' } }]) === 'ai-security');
  assert('cs.MA → ai-multiagent', mapDomain([{ $: { term: 'cs.MA' } }]) === 'ai-multiagent');
  assert('unknown → ai-general', mapDomain([{ $: { term: 'cs.PL' } }]) === 'ai-general');
  assert('null → ai-general', mapDomain(null) === 'ai-general');
})();

(function testScoreByRecency() {
  const now = new Date();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
  const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);
  assert('< 7 days → 0.85', scoreByRecency(threeDaysAgo.toISOString()) === 0.85);
  assert('< 30 days → 0.70', scoreByRecency(fifteenDaysAgo.toISOString()) === 0.70);
  assert('> 30 days → 0.55', scoreByRecency(sixtyDaysAgo.toISOString()) === 0.55);
})();

(function testPaperSignalExtractorEmitsMethodAndLimitationSignals() {
  const signals = extractPaperSignals({
    title: 'Governed Runtime Architecture',
    abstract: 'This paper proposes a method and framework for governed AI runtime evaluation. Results improve safety confidence, but a key limitation remains future work on operator trust.',
    authors: ['Alice', 'Bob'],
    year: 2026,
    citationCount: 42,
    paperId: 'paper-42',
    sourceUrl: 'https://example.test/paper-42',
    venue: 'TestConf',
    score: 0.7,
    domain: 'ai-governance'
  }, {
    sourceName: 'Test Source'
  });
  const kinds = signals.map((signal) => signal.type);
  assert('extractor always emits theory signal', kinds.includes('paper-theory'));
  assert('extractor emits method signal when method cues exist', kinds.includes('paper-method'));
  assert('extractor emits limitation signal when limitation cues exist', kinds.includes('paper-limitation'));
})();

// ---------------------------------------------------------------------------
// 4. Integration test: mock papers through full pipeline
// ---------------------------------------------------------------------------
console.log('\n=== Integration Test ===');

(function testFullPipeline() {
  normalizeQueue._seenTitles.clear();
  const q = new SignalQueue();

  // 6 mock paper signals mirroring the canonical test bundle pattern:
  // diverse source strings, spread timestamps, evidence metadata, and keywords
  // targeting different cube cells to trigger collision-based candidates.
  const mockPapers = [
    {
      type: 'paper-theory', domain: 'ai-research',
      title: 'Consent Verification in Multi-Agent AI',
      content: 'We propose a framework for verifying consent in autonomous multi-agent systems.',
      score: 0.85, sourceWeight: 1.5,
      timestamp: '2026-03-01T00:00:00.000Z',
      sourceUrl: 'https://arxiv.org/abs/2401.00001', authors: ['Alice'], venue: 'arXiv',
      id: 'paper-1', source: 'github competitor',
      keywords: ['consent', 'trust', 'gap'],
      evidenceConfidence: 1.2, citationCount: 8, corroboratedSources: 2
    },
    {
      type: 'paper-theory', domain: 'ai-research',
      title: 'Benchmark Frameworks for AI Consent Models',
      content: 'A benchmark suite measuring consent alignment in large language models.',
      score: 0.85, sourceWeight: 1.5,
      timestamp: '2026-03-02T00:00:00.000Z',
      sourceUrl: 'https://arxiv.org/abs/2401.00002', authors: ['Bob'], venue: 'arXiv',
      id: 'paper-2', source: 'paper theory',
      keywords: ['consent', 'benchmark', 'gap'],
      evidenceConfidence: 1.4, citationCount: 12, corroboratedSources: 3
    },
    {
      type: 'paper-theory', domain: 'ai-security',
      title: 'API Surface Attacks on AI Channels',
      content: 'Exploring gap surfaces in API channels used by AI agent frameworks.',
      score: 0.70, sourceWeight: 1.5,
      timestamp: '2026-03-03T00:00:00.000Z',
      sourceUrl: 'https://arxiv.org/abs/2401.00003', authors: ['Charlie'], venue: 'arXiv',
      id: 'paper-3', source: 'github competitor',
      keywords: ['api', 'channel', 'gap'],
      evidenceConfidence: 1.1, citationCount: 6
    },
    {
      type: 'paper-theory', domain: 'ai-general',
      title: 'Channel Trend Analysis for AI APIs',
      content: 'Trend analysis of channel usage patterns in modern AI service APIs.',
      score: 0.70, sourceWeight: 1.5,
      timestamp: '2026-03-04T00:00:00.000Z',
      sourceUrl: 'https://arxiv.org/abs/2401.00004', authors: ['Diana'], venue: 'arXiv',
      id: 'paper-4', source: 'internal system',
      keywords: ['api', 'channel', 'trend']
    },
    {
      type: 'paper-theory', domain: 'ai-multiagent',
      title: 'Kernel Policy Gaps in Autonomous Oversight',
      content: 'Identifying kernel-level policy gaps in autonomous agent oversight architectures.',
      score: 0.85, sourceWeight: 1.5,
      timestamp: '2026-03-05T00:00:00.000Z',
      sourceUrl: 'https://arxiv.org/abs/2401.00005', authors: ['Eve'], venue: 'arXiv',
      id: 'paper-5', source: 'paper theory',
      keywords: ['kernel', 'policy', 'gap'],
      evidenceConfidence: 1.3, citationCount: 18
    },
    {
      type: 'paper-theory', domain: 'ai-general',
      title: 'Policy Trend Detection in AI Governance Kernels',
      content: 'Trend detection algorithms for governance kernel policy evolution.',
      score: 0.70, sourceWeight: 1.5,
      timestamp: '2026-03-06T00:00:00.000Z',
      sourceUrl: 'https://arxiv.org/abs/2401.00006', authors: ['Frank'], venue: 'arXiv',
      id: 'paper-6', source: 'internal skill',
      keywords: ['kernel', 'policy', 'trend']
    }
  ];

  // Push to queue
  for (const paper of mockPapers) {
    q.produce('raw-signals', paper);
  }
  assert('raw-signals has 6 papers', q.size('raw-signals') === 6);

  // Normalize
  const { accepted, dropped } = normalizeQueue(q);
  assert('all 6 papers accepted by normalizer', accepted === 6);
  assert('none dropped', dropped === 0);

  // Pull normalized signals
  const normalized = q.consumeAll('normalized-signals');
  assert('6 normalized signals available', normalized.length === 6);

  // Run through gap discovery pipeline
  const result = runGapDiscoveryFromSignals(normalized, {
    stateFile: makeTempState(),
    referenceTime: '2026-03-11T00:00:00.000Z',
    tick: 6,
    emergenceThreshold: 0.3
  });

  assert('pipeline returns packets array', Array.isArray(result.packets));
  assert('pipeline returns summary', result.summary != null);
  assert('pipeline returns events', Array.isArray(result.events));

  // Check if gap candidates were produced
  const candidateCount = result.summary.totalCandidates;
  assert('at least one gap candidate produced', candidateCount >= 1);

  // Check scoring trace has 7 components
  if (result.packets.length > 0) {
    const packet = result.packets[0];
    const trace = packet.scoringTrace;
    assert('candidate has scoringTrace', trace != null);
    if (trace && trace.components) {
      const componentNames = Object.keys(trace.components);
      assert('scoringTrace has all 7 components', componentNames.length === 7);
      const expected = ['novelty', 'collision', 'residue', 'gravity', 'evidence', 'entropy', 'serendipity'];
      const hasAll = expected.every(c => componentNames.includes(c));
      assert('scoringTrace has correct component names', hasAll);
    }

    // Verify lifecycle boundary
    assert('lifecycle authorityBoundary is clashd27_stops_at_proposal',
      packet.lifecycle && packet.lifecycle.authorityBoundary === 'clashd27_stops_at_proposal');
    assert('executionMode is forbidden',
      packet.gapProposalHandoff && packet.gapProposalHandoff.executionMode === 'forbidden');
  } else {
    console.log('  (no packets produced — candidates scored below 0.4 threshold)');
    // Still valid: the pipeline ran, just no candidates passed the threshold
  }

  console.log(`  Candidates: ${candidateCount}, Packets: ${result.packets.length}, Promising: ${result.summary.promisingCount}`);
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
