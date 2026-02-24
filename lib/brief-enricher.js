/**
 * CLASHD-27 — Brief Enricher
 * Orchestrates all enrichment for a gap packet:
 *   - NIH funding check
 *   - EU funding check
 *   - Credibility scoring (10 checks, percentage)
 *
 * Graceful: if any enrichment source fails, continues with the rest.
 */

const { searchProjects, assessFundingOverlap } = require('./nih-reporter');
const { enrichWithEUFunding } = require('./europe-pmc');

/**
 * Credibility scoring: 10 binary checks, returns percentage.
 */
function scoreCredibility(gapPacket) {
  const checks = [];

  // 1. Has hypothesis
  const hypo = gapPacket.hypothesis || gapPacket.discovery || '';
  checks.push({ name: 'has_hypothesis', pass: hypo.length > 20 });

  // 2. Has ABC chain with 3+ links
  const chain = gapPacket.abc_chain || [];
  checks.push({ name: 'has_abc_chain', pass: chain.length >= 3 });

  // 3. All chain links have sources
  const sourcedLinks = chain.filter(l => l.source && l.source.length > 5);
  checks.push({ name: 'chain_sourced', pass: chain.length > 0 && sourcedLinks.length === chain.length });

  // 4. Has bridge claim
  const bridge = gapPacket.bridge || {};
  checks.push({ name: 'has_bridge', pass: !!(bridge.claim && bridge.claim.length > 10) });

  // 5. Has kill test
  checks.push({ name: 'has_kill_test', pass: !!(gapPacket.kill_test && gapPacket.kill_test.length > 10) });

  // 6. Has cheapest validation
  const cv = gapPacket.cheapest_validation || {};
  checks.push({ name: 'has_validation', pass: !!(cv.method || cv.description || (typeof cv === 'string' && cv.length > 10)) });

  // 7. Cross-domain (different cell labels)
  const labels = gapPacket.cellLabels || [];
  checks.push({ name: 'cross_domain', pass: labels.length >= 2 && labels[0] !== labels[1] });

  // 8. Has scores with total > 50
  const scores = gapPacket.scores || {};
  checks.push({ name: 'quality_score', pass: typeof scores.total === 'number' && scores.total > 50 });

  // 9. Has golden collision metadata
  const gc = gapPacket.goldenCollision || {};
  checks.push({ name: 'golden_collision', pass: typeof gc.score === 'number' && gc.score > 0.3 });

  // 10. Verdict is HIGH-VALUE or CONFIRMED
  const verdict = (gapPacket.verdict && gapPacket.verdict.verdict) || gapPacket.verdict || '';
  checks.push({ name: 'strong_verdict', pass: verdict === 'HIGH-VALUE GAP' || verdict === 'CONFIRMED DIRECTION' });

  const passed = checks.filter(c => c.pass).length;
  return {
    score: Math.round((passed / checks.length) * 100),
    passed,
    total: checks.length,
    checks
  };
}

/**
 * Enrich a gap packet with funding data and credibility score.
 *
 * @param {object} gapPacket - a discovery/gap finding
 * @returns {object} enrichment results
 */
async function enrichGapBrief(gapPacket) {
  const result = {
    nih_funding: null,
    eu_funding: null,
    credibility: null,
    enriched_at: new Date().toISOString(),
    errors: []
  };

  // 1. Credibility scoring (local, never fails)
  result.credibility = scoreCredibility(gapPacket);

  // 2. NIH funding check
  try {
    const { projects } = await searchProjects(gapPacket);
    result.nih_funding = assessFundingOverlap(gapPacket, projects);
  } catch (e) {
    result.errors.push(`nih: ${e.message}`);
    result.nih_funding = {
      total_projects_found: 0,
      cross_domain_projects: 0,
      single_domain_projects: 0,
      total_active_funding: 0,
      gap_funding_status: 'error',
      summary: `NIH check failed: ${e.message}`
    };
  }

  // 3. EU funding check
  try {
    result.eu_funding = await enrichWithEUFunding(gapPacket);
  } catch (e) {
    result.errors.push(`eu: ${e.message}`);
    result.eu_funding = {
      papers: [],
      eu_funded_count: 0,
      total_found: 0,
      summary: `EU check failed: ${e.message}`
    };
  }

  return result;
}

module.exports = { enrichGapBrief, scoreCredibility };
