#!/usr/bin/env node
/**
 * Test script for Brief Enricher module.
 * Usage: node scripts/test-brief-enricher.js
 */

const { enrichGapBrief, scoreCredibility } = require('../lib/brief-enricher');

async function main() {
  console.log('[TEST] Brief Enricher');
  console.log('─'.repeat(60));

  // Mock gap packet that resembles a real discovery
  const mockGap = {
    id: 'test-gap-001',
    type: 'discovery',
    hypothesis: 'Circadian clock disruption in tumor microenvironment may alter immune checkpoint expression, creating a time-dependent window for immunotherapy efficacy',
    cellLabels: ['circadian clock regulation', 'tumor immunology'],
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

  // 1. Credibility scoring only
  console.log('[TEST] 1. Credibility scoring...');
  const cred = scoreCredibility(mockGap);
  console.log(`  Score: ${cred.score}% (${cred.passed}/${cred.total})`);
  for (const c of cred.checks) {
    console.log(`    ${c.pass ? '✓' : '✗'} ${c.name}`);
  }
  console.log();

  // 2. Full enrichment (includes NIH + EU API calls)
  console.log('[TEST] 2. Full enrichment (live API calls)...');
  console.log('  This will call NIH Reporter and Europe PMC APIs...');
  console.log();

  const result = await enrichGapBrief(mockGap);

  console.log('─'.repeat(60));
  console.log('[TEST] Results:');
  console.log();

  console.log('  Credibility:');
  console.log(`    Score: ${result.credibility.score}%`);
  console.log();

  if (result.nih_funding) {
    console.log('  NIH Funding:');
    console.log(`    Projects found: ${result.nih_funding.total_projects_found}`);
    console.log(`    Cross-domain: ${result.nih_funding.cross_domain_projects}`);
    console.log(`    Status: ${result.nih_funding.gap_funding_status}`);
    console.log(`    Summary: ${result.nih_funding.summary}`);
    console.log();
  }

  if (result.eu_funding) {
    console.log('  EU Funding:');
    console.log(`    Papers found: ${result.eu_funding.total_found}`);
    console.log(`    EU-funded: ${result.eu_funding.eu_funded_count}`);
    console.log(`    Summary: ${result.eu_funding.summary}`);
    console.log();
  }

  if (result.errors.length > 0) {
    console.log('  Errors (non-fatal):');
    for (const e of result.errors) console.log(`    - ${e}`);
    console.log();
  }

  console.log(`  Enriched at: ${result.enriched_at}`);
}

main().catch(e => {
  console.error('[TEST] Failed:', e.message);
  process.exit(1);
});
