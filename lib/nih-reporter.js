/**
 * CLASHD-27 — NIH Reporter Module
 * Searches the NIH Reporter v2 API for active/recent grants related to a gap.
 * Uses shared rate-limiter and api-cache.
 */

const { limiters } = require('./rate-limiter');
const { ApiCache } = require('./api-cache');

const NIH_API_URL = 'https://api.reporter.nih.gov/v2/projects/search';
const cache = new ApiCache('cache-nih.json', 24);

/**
 * Search NIH Reporter for projects matching a gap packet.
 * Makes 2 searches: one broad (individual domain terms) and one cross-domain.
 *
 * @param {object} gapPacket - { cellLabels: [string, string], hypothesis?: string }
 * @returns {{ projects: object[], total: number }}
 */
async function searchProjects(gapPacket) {
  const labels = gapPacket.cellLabels || [];
  const hypothesis = gapPacket.hypothesis || gapPacket.discovery || '';
  const keyTerms = labels.map(l => l.replace(/[^a-zA-Z0-9\s]/g, '').trim()).filter(Boolean);

  if (keyTerms.length === 0) return { projects: [], total: 0 };

  const allProjects = [];
  const seen = new Set();

  // Search 1: broad (each domain separately)
  for (const term of keyTerms) {
    const cacheKey = `nih-broad-${term.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      for (const p of cached) {
        if (!seen.has(p.project_num)) { seen.add(p.project_num); allProjects.push(p); }
      }
      continue;
    }

    await limiters.nih.throttle();
    try {
      const body = {
        criteria: {
          advanced_text_search: {
            operator: 'and',
            search_field: 'projecttitle,terms',
            search_text: term
          },
          fiscal_years: [2022, 2023, 2024, 2025],
          exclude_subprojects: true
        },
        offset: 0,
        limit: 25,
        sort_field: 'project_start_date',
        sort_order: 'desc'
      };

      const res = await fetch(NIH_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        const data = await res.json();
        const results = (data.results || []).map(normalizeProject);
        cache.set(cacheKey, results);
        for (const p of results) {
          if (!seen.has(p.project_num)) { seen.add(p.project_num); allProjects.push(p); }
        }
      }
    } catch (e) {
      console.error(`[NIH] Broad search failed for "${term}": ${e.message}`);
    }
  }

  // Search 2: cross-domain (combined terms)
  if (keyTerms.length >= 2) {
    const combined = keyTerms.join(' ');
    const cacheKey = `nih-cross-${combined.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      for (const p of cached) {
        if (!seen.has(p.project_num)) { seen.add(p.project_num); allProjects.push(p); }
      }
    } else {
      await limiters.nih.throttle();
      try {
        const body = {
          criteria: {
            advanced_text_search: {
              operator: 'and',
              search_field: 'projecttitle,terms',
              search_text: combined
            },
            fiscal_years: [2022, 2023, 2024, 2025],
            exclude_subprojects: true
          },
          offset: 0,
          limit: 25,
          sort_field: 'project_start_date',
          sort_order: 'desc'
        };

        const res = await fetch(NIH_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (res.ok) {
          const data = await res.json();
          const results = (data.results || []).map(normalizeProject);
          cache.set(cacheKey, results);
          for (const p of results) {
            if (!seen.has(p.project_num)) { seen.add(p.project_num); allProjects.push(p); }
          }
        }
      } catch (e) {
        console.error(`[NIH] Cross-domain search failed: ${e.message}`);
      }
    }
  }

  return { projects: allProjects, total: allProjects.length };
}

function normalizeProject(raw) {
  return {
    project_num: raw.project_num || '',
    title: (raw.project_title || '').slice(0, 300),
    pi_name: raw.contact_pi_name || raw.principal_investigators?.[0]?.full_name || '',
    organization: raw.organization?.org_name || '',
    fiscal_year: raw.fiscal_year || null,
    award_amount: raw.award_amount || 0,
    project_start: raw.project_start_date || '',
    project_end: raw.project_end_date || '',
    abstract: (raw.abstract_text || '').slice(0, 500),
    terms: (raw.phr_string || '').slice(0, 300),
    activity_code: raw.activity_code || '',
    is_active: raw.is_active || false
  };
}

/**
 * Assess how a gap relates to existing NIH funding.
 * Keyword-matching only — no LLM calls.
 *
 * @param {object} gapPacket
 * @param {object[]} projects
 * @returns {{ total_projects_found, cross_domain_projects, single_domain_projects, total_active_funding, gap_funding_status, summary }}
 */
function assessFundingOverlap(gapPacket, projects) {
  const labels = (gapPacket.cellLabels || []).map(l => l.toLowerCase());
  if (labels.length < 2 || projects.length === 0) {
    return {
      total_projects_found: projects.length,
      cross_domain_projects: 0,
      single_domain_projects: projects.length,
      total_active_funding: 0,
      gap_funding_status: projects.length === 0 ? 'unfunded' : 'single_domain_only',
      summary: projects.length === 0
        ? 'No NIH funding found for these domains.'
        : `${projects.length} project(s) found but none span both domains.`
    };
  }

  let crossDomain = 0;
  let singleDomain = 0;
  let totalFunding = 0;

  for (const p of projects) {
    const text = `${p.title} ${p.abstract} ${p.terms}`.toLowerCase();
    const matchesA = labels[0].split(/\s+/).some(w => w.length > 3 && text.includes(w));
    const matchesB = labels[1].split(/\s+/).some(w => w.length > 3 && text.includes(w));

    if (matchesA && matchesB) {
      crossDomain++;
    } else {
      singleDomain++;
    }
    if (p.is_active && p.award_amount) totalFunding += p.award_amount;
  }

  let status = 'unfunded';
  if (crossDomain > 0) status = 'cross_domain_funded';
  else if (singleDomain > 0) status = 'single_domain_only';

  const summary = crossDomain > 0
    ? `${crossDomain} NIH project(s) span both domains (${labels.join(' × ')}). Active funding: $${(totalFunding / 1e6).toFixed(1)}M.`
    : `${singleDomain} NIH project(s) found in individual domains, but none bridge ${labels.join(' × ')}.`;

  return {
    total_projects_found: projects.length,
    cross_domain_projects: crossDomain,
    single_domain_projects: singleDomain,
    total_active_funding: totalFunding,
    gap_funding_status: status,
    summary
  };
}

module.exports = { searchProjects, assessFundingOverlap };
