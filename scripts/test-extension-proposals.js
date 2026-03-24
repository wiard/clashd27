'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { generateExtensionCandidates } = require('../lib/extension-candidates');
const {
  publishExtensionProposal,
  loadExtensionStore
} = require('../lib/v2-knowledge-publisher');

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function fakeDiscovery(id, overrides = {}) {
  return {
    id,
    candidateId: `cand-${id}`,
    type: 'discovery',
    tick: 10,
    finding: 'Repeated safety and verification collision indicates extension potential.',
    hypothesis: 'A shared policy audit adapter can align governance checks.',
    cellLabels: ['LLM Safety', 'Formal Verification'],
    scores: { total: 84, novelty: 88 },
    verdict: { verdict: 'HIGH-VALUE GAP' },
    abc_chain: [
      { source: 'arxiv:1234.0001', claim: 'Prior safety benchmark under-specifies proofs' },
      { source: 'openalex:W1', claim: 'Formal methods improve reproducibility' }
    ],
    supporting_sources: ['openalex', 'arxiv'],
    collisionCount: 2,
    kill_test: 'Run the same governance checklist over three model families.',
    proposed_experiment: 'Build adapter + run policy-drift benchmarks.',
    goldenCollision: {
      cellA: { method: 'safety', surprise: 'high' },
      cellB: { method: 'verification', surprise: 'high' }
    },
    ...overrides
  };
}

async function run() {
  console.log('extension proposal tests\n');

  const history = [
    fakeDiscovery('hist-1', { tick: 7 }),
    fakeDiscovery('hist-2', { tick: 8, candidateId: 'cand-hist-2' }),
    fakeDiscovery('hist-3', {
      tick: 9,
      candidateId: 'cand-hist-3',
      kill_test: 'Run the same governance checklist over three model families.'
    })
  ];

  const tickDiscoveries = [
    fakeDiscovery('tick-1', {
      tick: 12,
      candidateId: 'cand-tick-1',
      finding: 'Third repeat of safety×verification gravity intersection with recurring tasks.'
    })
  ];

  const generated = generateExtensionCandidates(tickDiscoveries, {
    allFindings: [...history, ...tickDiscoveries],
    tick: 12
  });

  await test('extension candidate generation returns at least one candidate', async () => {
    assert.ok(generated.length >= 1, 'expected at least one generated extension candidate');
  });

  const candidate = generated[0];

  await test('generated candidate contains required payload fields', async () => {
    const keys = [
      'extensionId',
      'title',
      'purpose',
      'recommendedActionKind',
      'capabilities',
      'noveltyScore',
      'governanceValue',
      'evidenceRefs',
      'primaryCells',
      'domainAxes',
      'reasoningTraceShort',
      'parentCandidateId',
      'relatedCandidateIds',
      'originatingTick',
      'originatingClusterId',
      'graphHints'
    ];

    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(candidate, key), `missing field: ${key}`);
    }
    assert.ok(candidate.noveltyScore > 0.7, 'noveltyScore should be high');
    assert.ok(candidate.governanceValue > 0.6, 'governanceValue should be high');
  });

  const tempStore = path.join(os.tmpdir(), `clashd27-ext-proposals-${Date.now()}.json`);
  const fetchCalls = [];

  const fakeFetch = async (url, options) => {
    fetchCalls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 201,
      text: async () => ''
    };
  };

  await test('publishing bridge posts extension payload to /api/extensions/propose', async () => {
    const result = await publishExtensionProposal(candidate, {
      gatewayUrl: 'https://openclashd.example',
      token: 'token-abc',
      storeFile: tempStore,
      fetchImpl: fakeFetch,
      persistKnowledge: false,
      candidateThreshold: 0.1,
      governanceThreshold: 0.1
    });

    assert.strictEqual(result.published, true);
    assert.strictEqual(fetchCalls.length, 1, 'expected one POST call');
    assert.ok(fetchCalls[0].url.includes('/api/extensions/propose'), 'wrong endpoint');

    const body = fetchCalls[0].body;
    assert.ok(body.extensionId);
    assert.ok(body.title);
    assert.ok(body.purpose);
    assert.ok(Array.isArray(body.capabilities));
    assert.ok(Array.isArray(body.evidenceRefs));
    assert.ok(body.domainAxes && typeof body.domainAxes === 'object');
  });

  await test('dedupe prevents publishing same extension twice', async () => {
    const second = await publishExtensionProposal(candidate, {
      gatewayUrl: 'https://openclashd.example',
      token: 'token-abc',
      storeFile: tempStore,
      fetchImpl: fakeFetch,
      persistKnowledge: false,
      candidateThreshold: 0.1,
      governanceThreshold: 0.1
    });

    assert.strictEqual(second.published, false);
    assert.strictEqual(second.deduped, true);
    assert.strictEqual(fetchCalls.length, 1, 'second publish should not call remote endpoint');
  });

  await test('local persistence stores trace metadata for published extension', async () => {
    const store = loadExtensionStore(tempStore);
    assert.ok(store.proposedKeys[`extension:${candidate.candidateId}`], 'dedupe key missing');

    const publishedRecord = (store.proposals || []).find(item => item.publishStatus === 'published');
    assert.ok(publishedRecord, 'published record missing');
    assert.strictEqual(publishedRecord.parentCandidateId, candidate.parentCandidateId);
    assert.deepStrictEqual(publishedRecord.relatedCandidateIds, candidate.relatedCandidateIds);
    assert.strictEqual(publishedRecord.originatingTick, candidate.originatingTick);
    assert.strictEqual(publishedRecord.originatingClusterId, candidate.originatingClusterId);
    assert.ok(publishedRecord.graphHints, 'graphHints missing from persisted record');
  });

  try {
    if (fs.existsSync(tempStore)) fs.unlinkSync(tempStore);
  } catch (_) {
    // ignore cleanup errors
  }

  console.log(`\n${passed} tests passed`);
  process.exit(process.exitCode || 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
