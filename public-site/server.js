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

function readGapIndex() {
  return readJSON(path.join(DATA_DIR, 'gaps', 'index.json')) || { gaps: [], total: 0, date: null };
}

function readGapById(id) {
  return readJSON(path.join(DATA_DIR, 'gaps', `${id}.json`));
}

function readSurpriseDist() {
  return readJSON(path.join(DATA_DIR, 'surprise-dist.json')) || { days: {} };
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
  const idx = readGapIndex();
  return idx.gaps || [];
}

// --- In-memory cache (30s TTL) ---
const _cache = {};
function cached(key, ttlMs, fn) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  try {
    const data = fn();
    _cache[key] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    return entry ? entry.data : null;
  }
}

// --- Public API endpoints (read-only, safe) ---
app.get('/api/public/summary', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const result = cached('summary', 30000, () => {
      const gaps = getValidatedGaps();
      const metrics = readMetrics();
      const state = readState();
      const dist = readSurpriseDist();
      const dayKeys = Object.keys(dist.days || {}).sort().slice(-7);
      const papers7d = dayKeys.reduce((sum, k) => {
        const d = dist.days[k];
        return sum + ((d?.y0 || 0) + (d?.y1 || 0) + (d?.y2 || 0));
      }, 0);
      const corridors = new Set(gaps.map(g => g.corridor || 'unknown'));
      const today = new Date().toISOString().slice(0, 10);
      const gaps7d = gaps.filter(g => {
        if (!g.date) return false;
        const diff = (new Date(today) - new Date(g.date)) / 86400000;
        return diff >= 0 && diff < 7;
      }).length;
      const lastGap = gaps.length > 0
        ? gaps.reduce((latest, g) => (!latest || (g.date || '') > (latest.date || '')) ? g : latest).date || null
        : null;
      return {
        totalGaps: gaps.length,
        gaps7d,
        papers7d: papers7d || null,
        corridorsCount: corridors.size,
        lastGapDate: lastGap,
        lastUpdated: new Date().toISOString(),
        tick: state?.tick || 0
      };
    });
    res.json(result || { totalGaps: 0, gaps7d: 0, papers7d: null, corridorsCount: 0, lastGapDate: null, lastUpdated: new Date().toISOString(), tick: 0 });
  } catch (e) {
    res.json({ totalGaps: 0, gaps7d: 0, papers7d: null, corridorsCount: 0, lastGapDate: null, lastUpdated: new Date().toISOString(), tick: 0 });
  }
});

app.get('/api/public/latest', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = cached('latest_' + limit, 30000, () => {
      const gaps = getValidatedGaps();
      const sorted = [...gaps].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return sorted.slice(0, limit).map(g => ({
        id: g.id,
        date: g.date || null,
        corridor: g.corridor || 'Cross-domain',
        score: g.score || 0,
        claim: g.claim || ''
      }));
    });
    res.json(result || []);
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/public/featured', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const result = cached('featured', 30000, () => {
      const gaps = getValidatedGaps();
      if (gaps.length === 0) return null;
      const today = new Date().toISOString().slice(0, 10);
      const todayGaps = gaps.filter(g => g.date === today);
      const pool = todayGaps.length > 0 ? todayGaps : gaps;
      const best = pool.reduce((top, g) => (!top || (g.score || 0) > (top.score || 0)) ? g : top, null);
      if (!best) return null;
      const detail = readGapById(best.id);
      return {
        id: best.id,
        date: best.date || null,
        corridor: best.corridor || 'Cross-domain',
        score: best.score || 0,
        claim: best.claim || '',
        evidence: (detail?.evidence || []).slice(0, 3),
        proposed_experiment: detail?.proposed_experiment || null,
        scoring: detail?.scoring || null
      };
    });
    res.json(result || { id: null });
  } catch (e) {
    res.json({ id: null });
  }
});

app.get('/api/public/leaderboard', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    const result = cached('leaderboard_' + limit, 30000, () => {
      const gaps = getValidatedGaps();
      const agg = {};
      for (const gap of gaps) {
        const repos = Array.isArray(gap.repos) ? gap.repos : [];
        for (const repo of repos) {
          const key = (repo.repo || '').toLowerCase();
          if (!key) continue;
          if (!agg[key]) agg[key] = { repo: key, gapCount: 0, open: 0, responded: 0, resolved: 0 };
          agg[key].gapCount++;
          if (gap.status === 'resolved') agg[key].resolved++;
          else if (gap.status === 'responded') agg[key].responded++;
          else agg[key].open++;
        }
      }
      return Object.values(agg)
        .sort((a, b) => b.gapCount - a.gapCount)
        .slice(0, limit);
    });
    res.json(result || []);
  } catch (e) {
    res.json([]);
  }
});

app.use(express.json());

app.post('/api/public/subscribe', (req, res) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const subsFile = path.join(DATA_DIR, 'subscribers.json');
    let subs = [];
    try {
      if (fs.existsSync(subsFile)) {
        subs = JSON.parse(fs.readFileSync(subsFile, 'utf8'));
      }
    } catch (e) { subs = []; }
    if (!Array.isArray(subs)) subs = [];
    if (subs.some(s => s.email === email)) {
      return res.json({ ok: true, message: 'Already subscribed' });
    }
    if (subs.length > 10000) {
      return res.status(429).json({ error: 'Subscriber limit reached' });
    }
    subs.push({ email, subscribedAt: new Date().toISOString(), ip: req.ip });
    const tmp = subsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(subs, null, 2));
    fs.renameSync(tmp, subsFile);
    res.json({ ok: true, message: 'Subscribed' });
  } catch (e) {
    res.status(500).json({ error: 'Subscribe failed' });
  }
});

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

app.get('/method', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'method.html'));
});

app.get('/leaderboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'leaderboard.html'));
});

// --- JSON API ---
app.get('/api/gaps', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  const domain = req.query.domain || null;
  const method = req.query.method || null;
  const surprise = req.query.surprise || null;
  const source = req.query.source || null;
  const sort = req.query.sort || 'score';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const search = (req.query.search || '').toLowerCase();

  let gaps = getValidatedGaps();

  if (domain) {
    gaps = gaps.filter(g => (g.corridor || '').toLowerCase().includes(domain.toLowerCase()));
  }
  if (method) {
    gaps = gaps.filter(g => (g.methodAxis || '') === method);
  }
  if (surprise) {
    gaps = gaps.filter(g => (g.surpriseBucket || '') === surprise);
  }
  if (source) {
    gaps = gaps.filter(g => (g.sources || []).includes(source));
  }
  if (search) {
    gaps = gaps.filter(g => {
      const text = `${g.claim || ''} ${g.corridor || ''}`.toLowerCase();
      return text.includes(search);
    });
  }

  if (sort === 'date') {
    gaps.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  } else if (sort === 'domain') {
    gaps.sort((a, b) => (a.corridor || '').localeCompare(b.corridor || ''));
  }
  // default: already sorted by score

  const total = gaps.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paged = gaps.slice(start, start + limit);

  res.json({ gaps: paged, total, page, totalPages });
});

app.get('/api/gaps/:id', (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const id = req.params.id;
  const gap = readGapById(id);
  if (!gap) return res.status(404).json({ error: 'Gap not found' });
  res.json(gap);
});

app.get('/api/stats', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  const gaps = getValidatedGaps();
  const metrics = readMetrics();
  const state = readState();
  const cube = readCube();
  const packs = listPacks();
  const dist = readSurpriseDist();
  const dayKeys = Object.keys(dist.days || {}).sort().slice(-7);
  const papers7d = dayKeys.reduce((sum, k) => {
    const d = dist.days[k];
    return sum + ((d?.y0 || 0) + (d?.y1 || 0) + (d?.y2 || 0));
  }, 0);
  const corridorsCovered = new Set(gaps.map(g => g.corridor || 'unknown')).size;

  const byDomain = {};
  for (const g of gaps) {
    const domain = g.corridor || 'unknown';
    byDomain[domain] = (byDomain[domain] || 0) + 1;
  }

  const avgScore = gaps.length > 0
    ? Math.round(gaps.reduce((s, g) => s + (g.score || 0), 0) / gaps.length)
    : 0;

  res.json({
    totalGaps: gaps.length,
    domains: packs.length,
    byDomain,
    avgGapQuality: avgScore,
    papers7d,
    corridorsCovered,
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
