/**
 * CLASHD-27 MeSH Enricher — PubMed E-utilities
 *
 * Fetches MeSH terms from PubMed and maps them to Method DNA clusters.
 * MeSH (Medical Subject Headings) are gold standard for biomedical method classification.
 *
 * API: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
 * Rate limit: 3 req/sec without key, 10/sec with NCBI_API_KEY
 * Cache: data/mesh-cache.json, 7-day TTL
 */

const fs = require('fs');
const path = require('path');

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'mesh-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NCBI_API_KEY = process.env.NCBI_API_KEY || '';
const MIN_REQUEST_INTERVAL_MS = NCBI_API_KEY ? 110 : 350; // 10/sec with key, 3/sec without

let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ─────────────────────────────────────────────────────────────
// Cache management
// ─────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error(`[MESH] Cache read error: ${e.message}`);
  }
  return { _version: 1, meshTerms: {}, timestamp: new Date().toISOString() };
}

function writeCache(cache) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[MESH] Cache write error: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// MeSH → Method DNA mapping
// ─────────────────────────────────────────────────────────────

const MESH_METHOD_MAP = {
  // Imaging / Observation (X=0)
  0: [
    'Microscopy', 'Magnetic Resonance Imaging', 'Tomography',
    'Spectroscopy', 'Radiography', 'Ultrasonography',
    'Fluorescence', 'Endoscopy', 'Immunohistochemistry',
    'Flow Cytometry', 'Electron Microscope', 'Mass Spectrometry',
    'Histological Techniques', 'Staining and Labeling',
    'Epidemiologic Studies', 'Cohort Studies', 'Case-Control Studies',
    'Cross-Sectional Studies', 'Longitudinal Studies',
    'Retrospective Studies', 'Prospective Studies',
    'Prevalence', 'Incidence', 'Surveys and Questionnaires',
    'Diagnostic Imaging', 'Positron-Emission Tomography',
    'Computed Tomography', 'Echocardiography'
  ],
  // Computational (X=1)
  1: [
    'Computational Biology', 'Computer Simulation',
    'Machine Learning', 'Algorithms', 'Artificial Intelligence',
    'Neural Networks, Computer', 'Sequence Analysis',
    'Gene Expression Profiling', 'Genome-Wide Association Study',
    'Systems Biology', 'Mathematical Computing',
    'Statistics as Topic', 'Bioinformatics',
    'Meta-Analysis as Topic', 'Systematic Reviews as Topic',
    'Databases, Genetic', 'Software', 'Genomics',
    'Proteomics', 'Metabolomics', 'Transcriptome',
    'Data Mining', 'Deep Learning', 'Bayesian Analysis',
    'Models, Statistical', 'Models, Biological',
    'Molecular Dynamics Simulation'
  ],
  // Experimental (X=2)
  2: [
    'Clinical Trial', 'Randomized Controlled Trial',
    'In Vitro Techniques', 'Transfection', 'Gene Knockout Techniques',
    'CRISPR-Cas Systems', 'Cell Culture Techniques',
    'Drug Design', 'Drug Screening Assays',
    'Polymerase Chain Reaction', 'Blotting, Western',
    'Enzyme-Linked Immunosorbent Assay', 'Immunoprecipitation',
    'Mutagenesis', 'Gene Editing', 'RNA Interference',
    'Xenograft Model Antitumor Assays', 'Disease Models, Animal',
    'Dose-Response Relationship, Drug', 'Intervention Studies',
    'Cell Line, Tumor', 'Apoptosis', 'Cell Proliferation',
    'Cloning, Molecular', 'Plasmids', 'Recombinant Proteins',
    'Drug Evaluation, Preclinical', 'Pharmacokinetics'
  ]
};

// Flatten for fast lookup
const meshToMethod = new Map();
for (const [method, terms] of Object.entries(MESH_METHOD_MAP)) {
  for (const term of terms) {
    meshToMethod.set(term.toLowerCase(), parseInt(method));
  }
}

/**
 * Classify a paper's method DNA from its MeSH terms.
 * Returns { method: 0|1|2, confidence: 0-1, matchedTerms: string[] }
 */
function classifyMethodFromMesh(meshTerms) {
  if (!meshTerms || meshTerms.length === 0) {
    return { method: null, confidence: 0, matchedTerms: [] };
  }

  const scores = [0, 0, 0];
  const matched = [];

  for (const term of meshTerms) {
    const lower = term.toLowerCase();
    // Exact match
    if (meshToMethod.has(lower)) {
      scores[meshToMethod.get(lower)] += 2;
      matched.push(term);
      continue;
    }
    // Partial match
    for (const [meshTerm, method] of meshToMethod) {
      if (lower.includes(meshTerm) || meshTerm.includes(lower)) {
        scores[method] += 1;
        matched.push(term);
        break;
      }
    }
  }

  const maxScore = Math.max(...scores);
  if (maxScore === 0) return { method: null, confidence: 0, matchedTerms: [] };

  const method = scores.indexOf(maxScore);
  const total = scores.reduce((a, b) => a + b, 0);
  const confidence = total > 0 ? maxScore / total : 0;

  return { method, confidence: Math.round(confidence * 100) / 100, matchedTerms: matched };
}

// ─────────────────────────────────────────────────────────────
// PubMed API functions
// ─────────────────────────────────────────────────────────────

/**
 * Search PubMed for a DOI and get its PMID.
 */
async function searchByDoi(doi) {
  if (!doi) return null;
  await rateLimit();

  const apiKey = NCBI_API_KEY ? `&api_key=${NCBI_API_KEY}` : '';
  const url = `${EUTILS_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[DOI]&retmode=json${apiKey}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const ids = data.esearchresult?.idlist || [];
    return ids.length > 0 ? ids[0] : null;
  } catch (e) {
    console.error(`[MESH] PubMed DOI search error: ${e.message}`);
    return null;
  }
}

/**
 * Get MeSH terms for a PMID.
 */
async function getMeshTerms(pmid) {
  if (!pmid) return [];

  const cache = readCache();
  if (cache.meshTerms[pmid]) {
    const cached = cache.meshTerms[pmid];
    if (Date.now() - new Date(cached.timestamp).getTime() < CACHE_TTL_MS) {
      return cached.terms;
    }
  }

  await rateLimit();

  const apiKey = NCBI_API_KEY ? `&api_key=${NCBI_API_KEY}` : '';
  const url = `${EUTILS_BASE}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml${apiKey}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CLASHD27-ResearchBot/2.0' }
    });
    if (!response.ok) return [];

    const xml = await response.text();
    const meshTerms = [];

    // Simple regex extraction of MeSH headings (avoid heavy XML parsing)
    const meshRegex = /<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g;
    let match;
    while ((match = meshRegex.exec(xml)) !== null) {
      meshTerms.push(match[1]);
    }

    // Also get qualifiers
    const qualRegex = /<QualifierName[^>]*>([^<]+)<\/QualifierName>/g;
    while ((match = qualRegex.exec(xml)) !== null) {
      meshTerms.push(match[1]);
    }

    // Cache
    cache.meshTerms[pmid] = { terms: meshTerms, timestamp: new Date().toISOString() };
    writeCache(cache);

    return meshTerms;
  } catch (e) {
    console.error(`[MESH] MeSH fetch error for PMID ${pmid}: ${e.message}`);
    return [];
  }
}

/**
 * Enrich a batch of papers with MeSH-based method DNA.
 * Only enriches papers that have a DOI (to find PMID).
 * Respects rate limits — may be slow for large batches.
 *
 * @param {Array} papers - papers with .doi field
 * @param {number} maxPapers - max papers to enrich (to limit API calls)
 * @returns {Array} papers with added .meshTerms and .meshMethod fields
 */
async function enrichWithMethodDNA(papers, maxPapers = 50) {
  let enriched = 0;

  for (const paper of papers) {
    if (enriched >= maxPapers) break;
    if (!paper.doi) continue;

    try {
      const pmid = await searchByDoi(paper.doi);
      if (!pmid) continue;

      const meshTerms = await getMeshTerms(pmid);
      if (meshTerms.length === 0) continue;

      paper.meshTerms = meshTerms;
      const classification = classifyMethodFromMesh(meshTerms);
      paper.meshMethod = classification;
      enriched++;
    } catch (e) {
      console.error(`[MESH] Enrichment error for ${paper.doi}: ${e.message}`);
    }
  }

  console.log(`[MESH] Enriched ${enriched}/${Math.min(papers.length, maxPapers)} papers with MeSH method DNA`);
  return papers;
}

module.exports = {
  getMeshTerms,
  searchByDoi,
  classifyMethodFromMesh,
  enrichWithMethodDNA,
  MESH_METHOD_MAP,
  CACHE_FILE
};
