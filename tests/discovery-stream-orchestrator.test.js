'use strict';

const fs = require('fs');
const path = require('path');

const { Clashd27CubeEngine } = require('../lib/clashd27-cube-engine');
const { SignalQueue } = require('../src/queue/signal-queue');
const { runSignalIngestionCycle } = require('../src/orchestration/discovery-stream-orchestrator');

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

function tmpState(label) {
  return path.join('/tmp', `clashd27-stream-orchestrator-${label}-${process.pid}-${Date.now()}.json`);
}

function makeEngine(label) {
  const stateFile = tmpState(label);
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  return new Clashd27CubeEngine({
    stateFile,
    emergenceThreshold: 0.3
  });
}

async function run() {
  const queue = new SignalQueue();
  const engine = makeEngine('ingestion');

  const paperSource = async (q) => {
    q.produce('raw-signals', {
      id: 'paper-trust-1-theory',
      type: 'paper-theory',
      domain: 'ai-governance',
      title: 'Trust Corridor for AI Governance',
      content: 'This paper proposes a governance method and framework for distributed oversight of AI systems with measurable results and one open limitation.',
      score: 0.82,
      timestamp: '2026-03-16T08:00:00.000Z',
      paperId: 'paper-trust-1',
      sourceUrl: 'https://example.test/trust-1'
    });
    q.produce('raw-signals', {
      id: 'paper-trust-1-result',
      type: 'paper-result',
      domain: 'ai-governance',
      title: 'Trust Corridor for AI Governance',
      content: 'This paper proposes a governance method and framework for distributed oversight of AI systems with measurable results and one open limitation.',
      score: 0.78,
      timestamp: '2026-03-16T08:00:00.000Z',
      paperId: 'paper-trust-1',
      sourceUrl: 'https://example.test/trust-1'
    });
    return { fetched: 1, emittedSignals: 2, queries: 1 };
  };

  const result = await runSignalIngestionCycle({
    queue,
    engine,
    tick: 4,
    referenceTime: '2026-03-16T09:00:00.000Z',
    paperSources: [paperSource],
    githubRepos: [
      {
        name: 'openclashd-v2',
        description: 'Governance kernel for proposals and consent.',
        topics: ['governance', 'architecture'],
        stars: 12,
        forks: 2,
        updatedAt: '2026-03-16T09:00:00.000Z'
      }
    ],
    internalEvents: [
      {
        eventId: 'evt-1',
        title: 'Operator approval latency increased',
        summary: 'The system observed a governance approval delay in the current runtime.',
        timestamp: '2026-03-16T09:00:30.000Z',
        score: 0.62
      }
    ]
  });

  assert('papers analyzed count reflects unique papers', result.report.papersAnalyzed === 1);
  assert('signals generated includes paper, github, and internal sources', result.report.signalsGenerated === 4);
  assert('normalized signals were ingested into the cube engine', result.report.normalizedSignals === 4);
  assert('cube cells were activated by the ingestion cycle', result.report.cubeCellsActivated >= 2);
  assert('queue topics are drained after normalization', result.report.topicDepths.rawSignals === 0 && result.report.topicDepths.normalizedSignals === 0);
  assert('source runs include github and internal adapters', result.report.sourceRuns.some((entry) => entry.kind === 'github') && result.report.sourceRuns.some((entry) => entry.kind === 'internal'));

  console.log(`\n[SUMMARY] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
