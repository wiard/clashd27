/**
 * CLASHD27 — Public Site Server
 * Serves the public-facing gap catalogus on port 3028
 * Reads the same data/*.json files as the dashboard
 */
require('dotenv').config({ path: '/home/greenbanaanas/.secrets/clashd27.env', override: true });

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PUBLIC_PORT || 3028;

const DATA_DIR = path.join(__dirname, '..', 'data');
const PACKS_DIR = path.join(__dirname, '..', 'packs');

// --- Data Readers ---
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error(`[PUBLIC] Read failed ${filePath}: ${e.message}`);
  }
  return null;
}

function readFindings() {
  const data = readJSON(path.join(DATA_DIR, 'findings.json'));
  return (data && data.findings) || [];
}

function readDeepDives() {
  const data = readJSON(path.join(DATA_DIR, 'deep-dives.json'));
  return (data && data.dives) || [];
}

function readVerifications() {
  const data = readJSON(path.join(DATA_DIR, 'verifications.json'));
  return (data && data.verifications) || [];
}

function readValidations() {
  const data = readJSON(path.join(DATA_DIR, 'validations.json'));
  return (data && data.validations) || [];
}

function readMetrics() {
  return readJSON(path.join(DATA_DIR, 'metrics.json')) || {};
}

function readState() {
  return readJSON(path.join(DATA_DIR, 'state.json'));
}

function readCube() {
  return readJSON(path.join(DATA_DIR, 'cube.json'));
}

function listPacks() {
  try {
    return fs.readdirSync(PACKS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const pack = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, f), 'utf8'));
          return { id: pack.id, name: pack.name, description: pack.description };
        } catch (e) { return null; }
      })
      .filter(Boolean);
  } catch (e) { return []; }
}

// --- Enrich findings with verification/validation data ---
function enrichDiscoveries(findings) {
  const dives = readDeepDives();
  const verifications = readVerifications();
  const validations = readValidations();

  const diveMap = {};
  for (const d of dives) diveMap[d.discovery_id] = d;
  const verMap = {};
  for (const v of verifications) verMap[v.discovery_id] = v;
  const valMap = {};
  for (const v of validations) valMap[v.discovery_id] = v;

  return findings.map(f => {
    const dive = diveMap[f.id];
    const ver = verMap[f.id];
    const val = valMap[f.id];

    const enriched = { ...f };

    if (dive) {
      enriched.deepDive = dive;
      enriched.diveScore = dive.scores?.total || 0;
    }
    if (ver) {
      enriched.verification = ver;
      enriched.gptVerdict = ver.gpt_verdict || ver.verdict || null;
    }
    if (val) {
      enriched.validation = val;
      enriched.nihFunding = val.nih_funding || null;
      enriched.euFunding = val.eu_funding || null;
      enriched.feasibility = val.overall_feasibility || null;
    }

    // Compute gap quality score
    let gapQuality = 0;
    let checks = 0;
    if (f.abc_chain && f.abc_chain.length >= 2) { gapQuality += 15; checks++; }
    if (f.bridge && f.bridge.claim) { gapQuality += 15; checks++; }
    if (f.kill_test) { gapQuality += 15; checks++; }
    if (f.supporting_sources && f.supporting_sources.length > 0) { gapQuality += 10; checks++; }
    if (f.clinical_relevance) { gapQuality += 10; checks++; }
    if (dive && dive.scores?.total >= 70) { gapQuality += 15; checks++; }
    if (ver && (ver.gpt_verdict === 'CONFIRMED' || ver.verdict === 'CONFIRMED')) { gapQuality += 20; checks++; }

    enriched.gapQualityScore = Math.min(100, gapQuality);

    // Source credibility from dive
    enriched.sourceCredibilityScore = dive?.scores?.total || 0;

    // Research-ready badge
    enriched.researchReady = enriched.gapQualityScore >= 70 && enriched.sourceCredibilityScore >= 70;

    return enriched;
  });
}

function getValidatedGaps() {
  const findings = readFindings();
  const discoveries = findings.filter(f => f.type === 'discovery' || f.type === 'draft');
  return enrichDiscoveries(discoveries)
    .sort((a, b) => (b.gapQualityScore || 0) - (a.gapQualityScore || 0));
}

// --- Static files ---
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));

// --- HTML Pages ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/gaps', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gaps.html'));
});

app.get('/gaps/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gap.html'));
});

app.get('/gaps/domain/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'gaps.html'));
});

// --- JSON API ---
app.get('/api/gaps', (req, res) => {
  const domain = req.query.domain || null;
  const sort = req.query.sort || 'score';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = (req.query.search || '').toLowerCase();

  let gaps = getValidatedGaps();

  if (domain) {
    gaps = gaps.filter(g => g.pack === domain);
  }
  if (search) {
    gaps = gaps.filter(g => {
      const text = `${g.hypothesis || ''} ${g.discovery || ''} ${(g.cellLabels || []).join(' ')}`.toLowerCase();
      return text.includes(search);
    });
  }

  if (sort === 'date') {
    gaps.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  } else if (sort === 'domain') {
    gaps.sort((a, b) => (a.pack || '').localeCompare(b.pack || ''));
  }
  // default: already sorted by score

  const total = gaps.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paged = gaps.slice(start, start + limit);

  res.json({ gaps: paged, total, page, totalPages });
});

app.get('/api/gaps/:id', (req, res) => {
  const id = req.params.id;
  const gaps = getValidatedGaps();
  const gap = gaps.find(g => g.id === id);
  if (!gap) return res.status(404).json({ error: 'Gap not found' });
  res.json(gap);
});

app.get('/api/stats', (req, res) => {
  const gaps = getValidatedGaps();
  const metrics = readMetrics();
  const state = readState();
  const cube = readCube();
  const packs = listPacks();

  const byDomain = {};
  for (const g of gaps) {
    const domain = g.pack || 'unknown';
    byDomain[domain] = (byDomain[domain] || 0) + 1;
  }

  const avgScore = gaps.length > 0
    ? Math.round(gaps.reduce((s, g) => s + (g.gapQualityScore || 0), 0) / gaps.length)
    : 0;

  const researchReady = gaps.filter(g => g.researchReady).length;

  res.json({
    totalGaps: gaps.length,
    domains: packs.length,
    byDomain,
    avgGapQuality: avgScore,
    researchReady,
    tick: state?.tick || 0,
    cubePapers: cube?.totalPapers || 0,
    cubeGeneration: cube?.generation || 0,
    highValue: metrics.total_high_value || 0,
    totalDiscoveries: metrics.total_discoveries || 0,
    topGaps: gaps.slice(0, 3)
  });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`[PUBLIC] Running on http://localhost:${PORT}`);
});
