#!/usr/bin/env node
/**
 * Test script for NIH Reporter module.
 * Usage: node scripts/test-nih-reporter.js [query]
 * Default query: "circadian clock tumor"
 */

const { searchProjects, assessFundingOverlap } = require('../lib/nih-reporter');

async function main() {
  const query = process.argv[2] || 'circadian clock tumor';
  console.log(`[TEST] NIH Reporter — query: "${query}"`);
  console.log('─'.repeat(60));

  const gapPacket = {
    cellLabels: query.split(' ').length >= 2
      ? [query.split(' ').slice(0, Math.ceil(query.split(' ').length / 2)).join(' '),
         query.split(' ').slice(Math.ceil(query.split(' ').length / 2)).join(' ')]
      : [query, query],
    hypothesis: `Investigate the relationship between ${query}`
  };

  console.log(`[TEST] Cell labels: ${gapPacket.cellLabels.join(' × ')}`);
  console.log();

  // Search
  const { projects, total } = await searchProjects(gapPacket);
  console.log(`[TEST] Found ${total} projects`);
  console.log();

  // Show first 5
  for (const p of projects.slice(0, 5)) {
    console.log(`  ${p.project_num} | ${p.title.slice(0, 80)}`);
    console.log(`    PI: ${p.pi_name} @ ${p.organization}`);
    console.log(`    FY${p.fiscal_year} | $${(p.award_amount / 1000).toFixed(0)}K | active=${p.is_active}`);
    console.log();
  }

  // Assess overlap
  const overlap = assessFundingOverlap(gapPacket, projects);
  console.log('─'.repeat(60));
  console.log('[TEST] Funding overlap assessment:');
  console.log(`  Total projects: ${overlap.total_projects_found}`);
  console.log(`  Cross-domain: ${overlap.cross_domain_projects}`);
  console.log(`  Single-domain: ${overlap.single_domain_projects}`);
  console.log(`  Active funding: $${(overlap.total_active_funding / 1e6).toFixed(2)}M`);
  console.log(`  Status: ${overlap.gap_funding_status}`);
  console.log(`  Summary: ${overlap.summary}`);
}

main().catch(e => {
  console.error('[TEST] Failed:', e.message);
  process.exit(1);
});
