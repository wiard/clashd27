#!/usr/bin/env node
/**
 * Test script for Europe PMC module.
 * Usage: node scripts/test-europe-pmc.js [query]
 * Default query: "circadian clock tumor"
 */

const { searchPapers, enrichWithEUFunding } = require('../lib/europe-pmc');

async function main() {
  const query = process.argv[2] || 'circadian clock tumor';
  console.log(`[TEST] Europe PMC — query: "${query}"`);
  console.log('─'.repeat(60));

  // Basic search
  console.log('[TEST] 1. Basic search...');
  const papers = await searchPapers(query, { pageSize: 10 });
  console.log(`  Found ${papers.length} papers`);
  console.log();

  for (const p of papers.slice(0, 5)) {
    console.log(`  ${p.pmid || p.id} | ${p.title.slice(0, 80)}`);
    console.log(`    ${p.journal} (${p.year}) | cited: ${p.citedByCount} | OA: ${p.isOpenAccess}`);
    if (p.grantsList.length > 0) {
      console.log(`    Grants: ${p.grantsList.map(g => `${g.agency}:${g.grantId}`).join(', ')}`);
    }
    console.log();
  }

  // EU funding enrichment
  console.log('─'.repeat(60));
  console.log('[TEST] 2. EU funding enrichment...');
  const gapPacket = {
    cellLabels: query.split(' ').length >= 2
      ? [query.split(' ').slice(0, Math.ceil(query.split(' ').length / 2)).join(' '),
         query.split(' ').slice(Math.ceil(query.split(' ').length / 2)).join(' ')]
      : [query, query],
    hypothesis: `Investigate the relationship between ${query}`
  };

  const euResult = await enrichWithEUFunding(gapPacket);
  console.log(`  Total papers: ${euResult.total_found}`);
  console.log(`  EU-funded: ${euResult.eu_funded_count}`);
  console.log(`  Summary: ${euResult.summary}`);

  if (euResult.papers.length > 0) {
    console.log();
    console.log('  Top EU-funded papers:');
    for (const p of euResult.papers.filter(p => p.hasEUFunding).slice(0, 3)) {
      console.log(`    ${p.title.slice(0, 70)}`);
      console.log(`      Grants: ${p.grantsList.map(g => g.agency).join(', ')}`);
    }
  }
}

main().catch(e => {
  console.error('[TEST] Failed:', e.message);
  process.exit(1);
});
