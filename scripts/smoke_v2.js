#!/usr/bin/env node
'use strict';

const path = require('path');
let dotenv = null;
try {
  dotenv = require('dotenv');
} catch (e) {
  dotenv = null;
}
if (dotenv && typeof dotenv.config === 'function') {
  dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });
}

const TIMEOUT_MS = 12000;
const OPENALEX_MAILTO = process.env.OPENALEX_MAILTO || '';
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || process.env.OPENALEX_MAILTO || '';

function formatDate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function withTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const merged = { ...options, signal: controller.signal };
  return fetch(url, merged).finally(() => clearTimeout(timer));
}

async function ping(name, url, options = {}) {
  const start = Date.now();
  try {
    const res = await withTimeout(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'clashd27-smoke-v2/2.0',
        ...(options.headers || {})
      }
    });
    const ms = Date.now() - start;
    const status = res.status;
    const ok = status >= 200 && status < 500;
    if (!ok) {
      const body = await res.text().catch(() => '');
      const msg = (body || '').replace(/\s+/g, ' ').slice(0, 120);
      return { name, status, ok, ms, error: msg || `HTTP ${status}` };
    }
    return { name, status, ok, ms };
  } catch (err) {
    const ms = Date.now() - start;
    const msg = (err && err.message ? err.message : 'unknown').replace(/\s+/g, ' ').slice(0, 120);
    return { name, status: 0, ok: false, ms, error: msg };
  }
}

async function main() {
  const now = new Date();
  const end = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const startDate = formatDate(start);
  const endDate = formatDate(end);

  const oaMailto = OPENALEX_MAILTO ? `&mailto=${encodeURIComponent(OPENALEX_MAILTO)}` : '';
  const crossrefMailto = CROSSREF_MAILTO ? `&mailto=${encodeURIComponent(CROSSREF_MAILTO)}` : '';

  const checks = [
    {
      name: 'openalex',
      url: `https://api.openalex.org/works?per_page=1${oaMailto}`
    },
    {
      name: 'crossref',
      url: `https://api.crossref.org/works?rows=1${crossrefMailto}`
    },
    {
      name: 'biorxiv',
      url: `https://api.biorxiv.org/details/biorxiv/${startDate}/${endDate}`
    },
    {
      name: 'arxiv',
      url: 'https://export.arxiv.org/api/query?search_query=all:biology&start=0&max_results=1'
    },
    {
      name: 'pubmed',
      url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=biology&retmode=json'
    },
    {
      name: 'opencitations',
      url: 'https://opencitations.net/index/api/v2/citations/10.1038/nphys1170'
    },
    {
      name: 'clinicaltrials',
      url: 'https://clinicaltrials.gov/api/v2/studies?query.term=cancer&pageSize=1'
    }
  ];

  const results = await Promise.all(checks.map(c => ping(c.name, c.url)));

  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`[SMOKE_V2] ${r.name} status=${r.status} ok time=${r.ms}ms`);
    } else {
      failed++;
      console.log(`[SMOKE_V2] ${r.name} status=${r.status} error=${r.error} time=${r.ms}ms`);
    }
  }

  if (failed > 0) {
    console.error(`[SMOKE_V2] FAIL failures=${failed}/${results.length}`);
    process.exit(1);
  }

  console.log(`[SMOKE_V2] OK checks=${results.length}`);
  process.exit(0);
}

main();
