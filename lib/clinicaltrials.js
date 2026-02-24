/**
 * CLASHD-27 — ClinicalTrials.gov Module
 * Searches the ClinicalTrials.gov API v2 for relevant clinical trials.
 * Uses shared rate-limiter and api-cache.
 *
 * API docs: https://clinicaltrials.gov/data-api/api
 * No API key required. Rate limited to 5 req/min for safety.
 */

const { limiters } = require('./rate-limiter');
const { ApiCache } = require('./api-cache');

const CT_API_URL = 'https://clinicaltrials.gov/api/v2/studies';
const cache = new ApiCache('cache-clinicaltrials.json', 24);

/**
 * Search ClinicalTrials.gov for trials related to a gap packet.
 *
 * @param {object} gapPacket - { cellLabels, keywords, hypothesis }
 * @returns {object[]} normalized trial results
 */
async function searchTrials(gapPacket) {
  const labels = gapPacket.cellLabels || [];
  const keywords = gapPacket.keywords || [];
  const hypothesis = gapPacket.hypothesis || gapPacket.discovery || '';

  // Build query from keywords or labels
  let queryTerms;
  if (keywords.length > 0) {
    queryTerms = keywords.slice(0, 6).join(' OR ');
  } else if (labels.length >= 2) {
    queryTerms = `${labels[0]} ${labels[1]}`;
  } else {
    queryTerms = hypothesis.split(' ').slice(0, 8).join(' ');
  }

  if (!queryTerms || queryTerms.trim().length < 3) return [];

  const cacheKey = `ct-${queryTerms.toLowerCase().slice(0, 80)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  await limiters.clinicaltrials.throttle();

  try {
    const params = new URLSearchParams({
      'query.term': queryTerms,
      'filter.overallStatus': 'RECRUITING,NOT_YET_RECRUITING,ACTIVE_NOT_RECRUITING',
      pageSize: '10',
      format: 'json'
    });

    const res = await fetch(`${CT_API_URL}?${params}`, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });

    if (!res.ok) {
      console.error(`[CLINICALTRIALS] HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const studies = data.studies || [];
    const results = studies.map(normalizeTrial);

    cache.set(cacheKey, results);
    return results;
  } catch (e) {
    console.error(`[CLINICALTRIALS] Search failed: ${e.message}`);
    return [];
  }
}

/**
 * Normalize a ClinicalTrials.gov API v2 study object.
 */
function normalizeTrial(study) {
  const proto = study.protocolSection || {};
  const id = proto.identificationModule || {};
  const status = proto.statusModule || {};
  const design = proto.designModule || {};
  const conditions = proto.conditionsModule || {};
  const arms = proto.armsInterventionsModule || {};
  const sponsor = proto.sponsorCollaboratorsModule || {};

  const interventions = (arms.interventions || []).map(i => ({
    name: i.name || '',
    type: i.type || ''
  }));

  return {
    nctId: id.nctId || '',
    title: (id.officialTitle || id.briefTitle || '').slice(0, 300),
    briefTitle: (id.briefTitle || '').slice(0, 200),
    status: status.overallStatus || '',
    phase: (design.phases || []).join(', ') || 'N/A',
    conditions: (conditions.conditions || []).slice(0, 10),
    interventions: interventions.slice(0, 10),
    startDate: status.startDateStruct?.date || '',
    leadSponsor: sponsor.leadSponsor?.name || ''
  };
}

/**
 * Assess how a gap relates to existing clinical trials.
 * Keyword matching — same pattern as nih-reporter.js assessFundingOverlap.
 *
 * @param {object} gapPacket - { cellLabels, keywords }
 * @param {object[]} trials - normalized trial results
 * @returns {{ total_trials_found: number, relevant_trials: object[], gap_status: string, summary: string }}
 */
function assessTrialOverlap(gapPacket, trials) {
  const labels = (gapPacket.cellLabels || []).map(l => l.toLowerCase());
  const keywords = (gapPacket.keywords || []).map(k => k.toLowerCase());

  if (trials.length === 0) {
    return {
      total_trials_found: 0,
      relevant_trials: [],
      gap_status: 'NO_TRIALS',
      summary: 'No active clinical trials found for these domains.'
    };
  }

  const relevant = [];
  for (const trial of trials) {
    const text = `${trial.title} ${trial.briefTitle} ${trial.conditions.join(' ')} ${trial.interventions.map(i => i.name).join(' ')}`.toLowerCase();

    // Check label matches
    const matchesLabels = labels.length >= 2 &&
      labels.every(l => l.split(/\s+/).some(w => w.length > 3 && text.includes(w)));

    // Check keyword matches
    const keywordHits = keywords.filter(k => k.length > 3 && text.includes(k));

    if (matchesLabels || keywordHits.length >= 2) {
      relevant.push({
        ...trial,
        match_type: matchesLabels ? 'cross-domain' : 'keyword',
        keyword_hits: keywordHits.length
      });
    }
  }

  let gap_status;
  if (relevant.length === 0) {
    gap_status = 'NO_TRIALS';
  } else if (relevant.some(t => t.match_type === 'cross-domain')) {
    gap_status = 'DIRECT_OVERLAP';
  } else {
    gap_status = 'PARTIAL_OVERLAP';
  }

  const summary = gap_status === 'NO_TRIALS'
    ? `${trials.length} trial(s) found but none directly relate to this cross-domain gap.`
    : gap_status === 'DIRECT_OVERLAP'
      ? `${relevant.length} trial(s) directly overlap with this gap (${labels.join(' x ')}). Gap may already be under investigation.`
      : `${relevant.length} trial(s) partially overlap via shared keywords.`;

  return {
    total_trials_found: trials.length,
    relevant_trials: relevant,
    gap_status,
    summary
  };
}

module.exports = { searchTrials, assessTrialOverlap };
