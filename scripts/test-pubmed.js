#!/usr/bin/env node
/**
 * Test script for PubMed module.
 * Usage: node scripts/test-pubmed.js
 */

const { searchPapers, enrichWithReferences } = require('../lib/pubmed');

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
  console.log('[TEST] PubMed Module');
  console.log('─'.repeat(60));

  // Test 1: searchPapers
  console.log('[TEST] 1. searchPapers("circadian clock tumor classification")...');
  const papers = await searchPapers('circadian clock tumor classification', { maxResults: 10 });

  assert('Returns array', Array.isArray(papers));
  assert('Found papers', papers.length > 0);

  if (papers.length > 0) {
    assert('Papers have pmid', !!papers[0].pmid);
    assert('Papers have title', !!papers[0].title);
    assert('Papers have year', typeof papers[0].year === 'number');

    console.log();
    console.log('  First 5 results:');
    for (const p of papers.slice(0, 5)) {
      console.log(`    PMID:${p.pmid} | ${p.title.slice(0, 70)}`);
      console.log(`      ${p.journal} (${p.year}) | authors: ${p.authors_short}`);
    }
  }
  console.log();

  // Test 2: enrichWithReferences
  console.log('─'.repeat(60));
  console.log('[TEST] 2. enrichWithReferences() with mock gap packet...');

  const mockGap = {
    title: 'Circadian clock gene disruption affecting AI-driven brain tumor classification',
    cellLabels: ['circadian clock regulation', 'tumor classification'],
    keywords: ['circadian', 'clock genes', 'glioma', 'tumor classification', 'machine learning', 'brain cancer']
  };

  const refs = await enrichWithReferences(mockGap);

  assert('Returns array', Array.isArray(refs));
  assert('Found references', refs.length > 0);

  if (refs.length > 0) {
    assert('Refs have pmid', !!refs[0].pmid);
    assert('Refs have relevance_note', !!refs[0].relevance_note);
    assert('Refs have authors_short', !!refs[0].authors_short);

    console.log();
    console.log('  References:');
    for (const r of refs.slice(0, 5)) {
      console.log(`    PMID:${r.pmid} | ${r.title.slice(0, 70)}`);
      console.log(`      ${r.authors_short} | ${r.relevance_note}`);
      if (r.mesh_terms.length > 0) {
        console.log(`      MeSH: ${r.mesh_terms.slice(0, 5).join(', ')}`);
      }
    }
  }

  // Check MeSH terms were attached to gap packet
  assert('MeSH terms attached to gap packet', Array.isArray(mockGap.mesh_terms) && mockGap.mesh_terms.length > 0);
  if (mockGap.mesh_terms) {
    console.log(`\n  MeSH terms found: ${mockGap.mesh_terms.slice(0, 10).join(', ')}`);
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
