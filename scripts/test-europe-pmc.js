#!/usr/bin/env node
/**
 * Test script for Europe PMC module.
 * Usage: node scripts/test-europe-pmc.js [query]
 * Default query: "circadian clock tumor"
 */

const { searchPapers, enrichWithFunding } = require('../lib/europe-pmc');

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
  const query = process.argv[2] || 'circadian clock tumor';
  console.log(`[TEST] Europe PMC — query: "${query}"`);
  console.log('─'.repeat(60));

  // Basic search
  console.log('[TEST] 1. Basic search...');
  const papers = await searchPapers(query, { pageSize: 10 });
  console.log(`  Found ${papers.length} papers`);

  assert('Returns array', Array.isArray(papers));
  assert('Found papers', papers.length > 0);

  if (papers.length > 0) {
    assert('Papers have hasRecognizedFunding field', typeof papers[0].hasRecognizedFunding === 'boolean');
  }

  console.log();
  for (const p of papers.slice(0, 5)) {
    console.log(`  ${p.pmid || p.id} | ${p.title.slice(0, 80)}`);
    console.log(`    ${p.journal} (${p.year}) | cited: ${p.citedByCount} | OA: ${p.isOpenAccess} | Funded: ${p.hasRecognizedFunding}`);
    if (p.grantsList.length > 0) {
      console.log(`    Grants: ${p.grantsList.map(g => `${g.agency}:${g.grantId}`).join(', ')}`);
    }
    console.log();
  }

  // Recognized funding enrichment
  console.log('─'.repeat(60));
  console.log('[TEST] 2. Recognized funding enrichment...');
  const gapPacket = {
    cellLabels: query.split(' ').length >= 2
      ? [query.split(' ').slice(0, Math.ceil(query.split(' ').length / 2)).join(' '),
         query.split(' ').slice(Math.ceil(query.split(' ').length / 2)).join(' ')]
      : [query, query],
    hypothesis: `Investigate the relationship between ${query}`
  };

  const result = await enrichWithFunding(gapPacket);
  console.log(`  Total papers: ${result.total_found}`);
  console.log(`  Recognized-funded: ${result.recognized_funded_count}`);
  console.log(`  Summary: ${result.summary}`);

  assert('Has recognized_funded_papers field', typeof result.recognized_funded_papers === 'number');
  assert('Has regional_breakdown', result.regional_breakdown !== undefined);

  if (result.regional_breakdown) {
    console.log(`  Regional: EU=${result.regional_breakdown.eu}, US=${result.regional_breakdown.us}, Intl=${result.regional_breakdown.international}`);
  }

  if (result.papers.length > 0) {
    console.log();
    console.log('  Top recognized-funded papers:');
    for (const p of result.papers.filter(p => p.hasRecognizedFunding).slice(0, 3)) {
      console.log(`    ${p.title.slice(0, 70)}`);
      console.log(`      Grants: ${p.grantsList.map(g => g.agency).join(', ')}`);
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
