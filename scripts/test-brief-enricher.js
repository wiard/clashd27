#!/usr/bin/env node
/**
 * Test script for Brief Enricher module.
 * Usage: node scripts/test-brief-enricher.js
 */

const { enrichGapBrief, scoreGapQuality, scoreSourceCredibility } = require('../lib/brief-enricher');

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
  console.log('[TEST] Brief Enricher');
  console.log('─'.repeat(60));

  // Mock gap packet that resembles a real discovery
  const mockGap = {
    id: 'test-gap-001',
    type: 'discovery',
    hypothesis: 'Circadian clock disruption in tumor microenvironment may alter immune checkpoint expression, creating a time-dependent window for immunotherapy efficacy',
    cellLabels: ['circadian clock regulation', 'tumor immunology'],
    keywords: ['circadian', 'clock genes', 'tumor', 'immunotherapy', 'PD-L1', 'checkpoint'],
    abc_chain: [
      { link: 'A→B', claim: 'Circadian genes regulate immune cell trafficking', source: 'doi:10.1038/nature12345' },
      { link: 'B→C', claim: 'Immune checkpoint expression varies with circadian rhythm', source: 'doi:10.1126/science54321' },
      { link: 'C→GAP', claim: 'No studies have tested time-dependent immunotherapy dosing based on circadian markers', source: 'doi:10.1016/j.cell.2024.01' }
    ],
    bridge: {
      claim: 'Clock genes PER2 and BMAL1 regulate PD-L1 expression in tumor cells',
      source: 'doi:10.1038/nri.2023.42'
    },
    kill_test: 'If PD-L1 expression shows no circadian variation in tumor biopsies taken at different times, the hypothesis fails',
    cheapest_validation: {
      method: 'Retrospective analysis of existing TCGA RNA-seq data for circadian gene and PD-L1 co-expression patterns',
      description: 'Query TCGA for temporal metadata on biopsy collection times'
    },
    scores: { total: 72, bridge: 18, novelty: 15, specificity: 14 },
    goldenCollision: { score: 0.65, golden: true },
    verdict: { verdict: 'HIGH-VALUE GAP' }
  };

  // 1. Gap quality scoring only
  console.log('[TEST] 1. Gap Quality scoring...');
  const gapQ = scoreGapQuality(mockGap);
  console.log(`  Gap Quality Score: ${gapQ.score}% (${gapQ.passed}/${gapQ.total})`);
  for (const c of gapQ.checks) {
    console.log(`    ${c.pass ? '✓' : '✗'} ${c.name}`);
  }
  assert('Gap quality score is a number', typeof gapQ.score === 'number');
  assert('Gap quality has 10 checks', gapQ.total === 10);
  console.log();

  // 2. Full enrichment (includes NIH + EU + PubMed + ClinicalTrials API calls)
  console.log('[TEST] 2. Full enrichment (live API calls)...');
  console.log('  Calling NIH Reporter, Europe PMC, PubMed, ClinicalTrials.gov...');
  console.log();

  const result = await enrichGapBrief(mockGap);

  console.log('─'.repeat(60));
  console.log('[TEST] Results:');
  console.log();

  // Gap quality
  console.log('  Gap Quality:');
  console.log(`    Score: ${result.gap_quality_score}%`);
  assert('gap_quality_score exists', typeof result.gap_quality_score === 'number');
  console.log();

  // Source credibility
  console.log('  Source Credibility:');
  console.log(`    Score: ${result.source_credibility_score}%`);
  if (result.source_credibility?.checks) {
    for (const [name, val] of Object.entries(result.source_credibility.checks)) {
      console.log(`      ${val ? '✓' : '✗'} ${name}`);
    }
  }
  assert('source_credibility_score exists', typeof result.source_credibility_score === 'number');
  console.log();

  // Research-ready check
  console.log(`  Research-ready: ${result.research_ready ? 'YES' : 'NO'} (both >= 70%)`);
  assert('research_ready is boolean', typeof result.research_ready === 'boolean');
  console.log();

  // NIH funding
  if (result.nih_funding) {
    console.log('  NIH Funding:');
    console.log(`    Projects found: ${result.nih_funding.total_projects_found}`);
    console.log(`    Cross-domain: ${result.nih_funding.cross_domain_projects}`);
    console.log(`    Status: ${result.nih_funding.gap_funding_status}`);
    console.log(`    Summary: ${result.nih_funding.summary}`);
    assert('NIH funding data present', result.nih_funding.total_projects_found >= 0);
    console.log();
  }

  // EU/recognized funding
  if (result.eu_funding) {
    console.log('  EU/Recognized Funding:');
    console.log(`    Papers found: ${result.eu_funding.total_found}`);
    console.log(`    Recognized-funded: ${result.eu_funding.recognized_funded_count}`);
    if (result.eu_funding.regional_breakdown) {
      const rb = result.eu_funding.regional_breakdown;
      console.log(`    Regional: EU=${rb.eu || 0}, US=${rb.us || 0}, Intl=${rb.international || 0}`);
    }
    console.log(`    Summary: ${result.eu_funding.summary}`);
    assert('EU funding data present', result.eu_funding.total_found >= 0);
    console.log();
  }

  // PubMed references
  console.log('  PubMed References:');
  console.log(`    Found: ${result.pubmed_references.length}`);
  if (result.pubmed_references.length > 0) {
    for (const r of result.pubmed_references.slice(0, 3)) {
      console.log(`      PMID:${r.pmid} | ${r.title.slice(0, 60)} | ${r.relevance}`);
    }
  }
  assert('PubMed references is array', Array.isArray(result.pubmed_references));
  console.log();

  // Clinical trials
  if (result.clinical_trials) {
    console.log('  Clinical Trials:');
    console.log(`    Total found: ${result.clinical_trials.total_trials_found}`);
    console.log(`    Relevant: ${result.clinical_trials.relevant_trials?.length || 0}`);
    console.log(`    Gap status: ${result.clinical_trials.gap_status}`);
    console.log(`    Summary: ${result.clinical_trials.summary}`);
    assert('Clinical trials data present', result.clinical_trials.total_trials_found >= 0);
    console.log();
  }

  // Errors
  if (result.errors.length > 0) {
    console.log('  Errors (non-fatal):');
    for (const e of result.errors) console.log(`    - ${e}`);
    console.log();
  }

  console.log(`  Enriched at: ${result.enriched_at}`);

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
