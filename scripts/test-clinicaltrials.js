#!/usr/bin/env node
/**
 * Test script for ClinicalTrials.gov module.
 * Usage: node scripts/test-clinicaltrials.js
 */

const { searchTrials, assessTrialOverlap } = require('../lib/clinicaltrials');

let passed = 0;
let failed = 0;

function assert(name, condition) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

async function main() {
  console.log('[TEST] ClinicalTrials.gov Module');
  console.log('─'.repeat(60));

  const mockGap = {
    title: 'Circadian clock gene disruption affecting AI-driven brain tumor classification',
    cellLabels: ['circadian clock regulation', 'tumor classification'],
    keywords: ['circadian', 'clock genes', 'glioma', 'tumor classification', 'machine learning', 'brain cancer']
  };

  // Test 1: searchTrials
  console.log('[TEST] 1. searchTrials() with mock gap packet...');
  const trials = await searchTrials(mockGap);

  assert('Returns array', Array.isArray(trials));
  assert('Found trials', trials.length > 0);

  if (trials.length > 0) {
    assert('Trials have nctId', !!trials[0].nctId);
    assert('Trials have title', !!trials[0].title);
    assert('Trials have status', !!trials[0].status);

    console.log();
    console.log('  First 5 results:');
    for (const t of trials.slice(0, 5)) {
      console.log(`    ${t.nctId} | ${(t.briefTitle || t.title).slice(0, 60)}`);
      console.log(`      Status: ${t.status} | Phase: ${t.phase}`);
      if (t.conditions.length > 0) {
        console.log(`      Conditions: ${t.conditions.slice(0, 3).join(', ')}`);
      }
      if (t.leadSponsor) {
        console.log(`      Sponsor: ${t.leadSponsor}`);
      }
    }
  } else {
    console.log('  No trials found (this is OK for niche queries)');
  }
  console.log();

  // Test 2: assessTrialOverlap
  console.log('─'.repeat(60));
  console.log('[TEST] 2. assessTrialOverlap() with results...');
  const assessment = assessTrialOverlap(mockGap, trials);

  assert('Has gap_status', typeof assessment.gap_status === 'string');
  assert('Has total_trials_found', typeof assessment.total_trials_found === 'number');
  assert('Has summary', typeof assessment.summary === 'string');
  assert('Has relevant_trials array', Array.isArray(assessment.relevant_trials));
  assert('gap_status is valid', ['NO_TRIALS', 'PARTIAL_OVERLAP', 'DIRECT_OVERLAP'].includes(assessment.gap_status));

  console.log();
  console.log(`  Total trials found: ${assessment.total_trials_found}`);
  console.log(`  Relevant trials: ${assessment.relevant_trials.length}`);
  console.log(`  Gap status: ${assessment.gap_status}`);
  console.log(`  Summary: ${assessment.summary}`);

  if (assessment.relevant_trials.length > 0) {
    console.log();
    console.log('  Relevant trials:');
    for (const t of assessment.relevant_trials.slice(0, 3)) {
      console.log(`    ${t.nctId} | ${(t.briefTitle || t.title).slice(0, 60)}`);
      console.log(`      Match: ${t.match_type} | Keywords: ${t.keyword_hits}`);
    }
  }

  // Summary
  console.log();
  console.log('─'.repeat(60));
  console.log(`[TEST] Results: ${passed} PASS, ${failed} FAIL`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('[TEST] Failed:', e.message);
  process.exit(1);
});
