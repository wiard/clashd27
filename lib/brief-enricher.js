/**
 * CLASHD-27 — Brief Enricher
 * Orchestrates all enrichment for a gap packet:
 *   - NIH funding check
 *   - EU/recognized funding check
 *   - PubMed references + MeSH terms
 *   - ClinicalTrials.gov trial overlap
 *   - Dual credibility scoring:
 *     gap_quality_score (internal gap quality)
 *     source_credibility_score (external validation)
 *
 * Graceful: if any enrichment source fails, continues with the rest.
 */

const { searchProjects, assessFundingOverlap } = require('./nih-reporter');
const { enrichWithFunding } = require('./europe-pmc');
const pubmed = require('./pubmed');

/**
 * Gap Quality scoring: 10 binary checks on gap structure, returns percentage.
 * Measures how well the gap itself is constructed.
 */
function scoreGapQuality(gapPacket) {
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

// Backward-compatible alias
const scoreCredibility = scoreGapQuality;

/**
 * Source Credibility scoring: 10 binary checks on external validation.
 * Measures how much external evidence backs the gap.
 */
function scoreSourceCredibility(gapPacket, pubmedRefs, nihAssessment, euData, trialAssessment) {
  const checks = {
    has_peer_reviewed_refs: pubmedRefs.length > 0,
    has_preprint_awareness: checkPreprintSources(gapPacket),
    has_mesh_terms: (gapPacket.mesh_terms?.length > 0),
    has_funding_landscape: (nihAssessment.total_projects_found > 0 || euData.recognized_funded_papers > 0),
    has_trial_status: (trialAssessment.gap_status !== null),
    has_patent_check: false,        // TODO: Fase 3
    has_retraction_check: (gapPacket.retraction_flags !== undefined),
    has_identified_researchers: (gapPacket.researchers?.length > 0 || nihAssessment.cross_domain_projects > 0),
    has_linked_datasets: false,     // TODO: Fase 3
    has_adversarial_test: (gapPacket.verification !== undefined)
  };

  const passed = Object.values(checks).filter(v => v === true).length;
  return {
    score: Math.round((passed / 10) * 100),
    passed,
    total: 10,
    checks
  };
}

/**
 * Check if source papers include preprints.
 */
function checkPreprintSources(gapPacket) {
  const sources = gapPacket.sources || gapPacket.papers || [];
  return sources.some(s =>
    s.source === 'biorxiv' || s.source === 'arxiv' || s.source === 'medrxiv' ||
    (s.doi && (s.doi.includes('biorxiv') || s.doi.includes('arxiv')))
  );
}

/**
 * Enrich a gap packet with funding data, references, trials, and dual credibility scores.
 *
 * @param {object} gapPacket - a discovery/gap finding
 * @returns {object} enrichment results
 */
async function enrichGapBrief(gapPacket) {
  const result = {
    nih_funding: null,
    eu_funding: null,
    pubmed_references: [],
    clinical_trials: null,
    gap_quality: null,
    source_credibility: null,
    gap_quality_score: null,
    source_credibility_score: null,
    research_ready: false,
    enriched_at: new Date().toISOString(),
    errors: []
  };

  // 1. Gap quality scoring (local, never fails)
  result.gap_quality = scoreGapQuality(gapPacket);
  result.gap_quality_score = result.gap_quality.score;

  // 2. NIH funding check
  let nihAssessment = {
    total_projects_found: 0, cross_domain_projects: 0,
    single_domain_projects: 0, total_active_funding: 0,
    gap_funding_status: 'not_checked', summary: 'Not checked'
  };
  try {
    const { projects } = await searchProjects(gapPacket);
    nihAssessment = assessFundingOverlap(gapPacket, projects);
    result.nih_funding = nihAssessment;
  } catch (e) {
    result.errors.push(`nih: ${e.message}`);
    result.nih_funding = { ...nihAssessment, gap_funding_status: 'error', summary: `NIH check failed: ${e.message}` };
  }

  // 3. EU/recognized funding check
  let euData = { papers: [], recognized_funded_count: 0, recognized_funded_papers: 0, total_found: 0, summary: 'Not checked' };
  try {
    euData = await enrichWithFunding(gapPacket);
    result.eu_funding = euData;
  } catch (e) {
    result.errors.push(`eu: ${e.message}`);
    result.eu_funding = { ...euData, summary: `EU check failed: ${e.message}` };
  }

  // 4. PubMed references + MeSH terms
  let pubmedRefs = [];
  try {
    pubmedRefs = await pubmed.enrichWithReferences(gapPacket);
    result.pubmed_references = pubmedRefs;
  } catch (e) {
    result.errors.push(`pubmed: ${e.message}`);
    console.warn('[brief-enricher] PubMed enrichment failed:', e.message);
  }

  // 5. ClinicalTrials.gov
  let trialAssessment = { gap_status: null, total_trials_found: 0, relevant_trials: [], summary: 'Not checked' };
  try {
    const clinicaltrials = require('./clinicaltrials');
    const trials = await clinicaltrials.searchTrials(gapPacket);
    trialAssessment = clinicaltrials.assessTrialOverlap(gapPacket, trials);
    result.clinical_trials = trialAssessment;
  } catch (e) {
    result.errors.push(`clinicaltrials: ${e.message}`);
    result.clinical_trials = trialAssessment;
    console.warn('[brief-enricher] ClinicalTrials check failed:', e.message);
  }

  // 6. Source credibility scoring (depends on all enrichment results)
  const sourceCredibility = scoreSourceCredibility(gapPacket, pubmedRefs, nihAssessment, euData, trialAssessment);
  result.source_credibility = sourceCredibility;
  result.source_credibility_score = sourceCredibility.score;

  // 7. Research-ready check: both scores >= 70%
  result.research_ready = result.gap_quality_score >= 70 && result.source_credibility_score >= 70;

  return result;
}

module.exports = { enrichGapBrief, scoreGapQuality, scoreCredibility, scoreSourceCredibility, checkPreprintSources };
