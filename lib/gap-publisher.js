const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GAPS_DIR = path.join(DATA_DIR, 'gaps');
const INDEX_FILE = path.join(GAPS_DIR, 'index.json');
const CANDIDATE_FILE = path.join(DATA_DIR, 'gap-candidates.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const DEEP_DIVES_FILE = path.join(DATA_DIR, 'deep-dives.json');
const VERIFICATIONS_FILE = path.join(DATA_DIR, 'verifications.json');

function readJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    return fallback;
  }
  return fallback;
}

function writeJSONAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readCandidates() {
  return readJSON(CANDIDATE_FILE, { days: {} });
}

function writeCandidates(data) {
  writeJSONAtomic(CANDIDATE_FILE, data);
}

function recordDailyCandidate(discovery, score) {
  if (!discovery || !discovery.id) return;
  const data = readCandidates();
  const day = todayKey();
  if (!data.days[day]) data.days[day] = { candidates: [] };
  const list = data.days[day].candidates;
  if (!list.find(c => c.id === discovery.id)) {
    list.push({ id: discovery.id, score });
  }
  writeCandidates(data);
}

function shouldQueueDeepDive(discovery, score, topN = 10) {
  if (!discovery || !discovery.id) return false;
  const data = readCandidates();
  const day = todayKey();
  if (!data.days[day]) data.days[day] = { candidates: [] };
  const list = data.days[day].candidates;
  const existing = list.find(c => c.id === discovery.id);
  if (existing) {
    existing.score = Math.max(existing.score, score);
    writeCandidates(data);
    return false;
  }
  if (list.length < topN) {
    list.push({ id: discovery.id, score });
    writeCandidates(data);
    return true;
  }
  const min = list.reduce((m, c) => Math.min(m, c.score), Infinity);
  if (score > min) {
    const idx = list.findIndex(c => c.score === min);
    if (idx !== -1) list.splice(idx, 1);
    list.push({ id: discovery.id, score });
    writeCandidates(data);
    return true;
  }
  return false;
}

function readDiscoveries() {
  const data = readJSON(FINDINGS_FILE, { findings: [] });
  return data.findings || [];
}

function readDeepDives() {
  const data = readJSON(DEEP_DIVES_FILE, { dives: [] });
  return data.dives || [];
}

function readVerifications() {
  const data = readJSON(VERIFICATIONS_FILE, { verifications: [] });
  return data.verifications || [];
}

function buildGapFromDiscovery(d, deepDive, verification) {
  const corridor = (d.cellLabels && d.cellLabels.length > 0)
    ? d.cellLabels.join('×')
    : (cellA.method && cellB.method ? `${cellA.method}×${cellB.method}` : 'Cross-domain');
  const cellA = d.goldenCollision?.cellA || {};
  const cellB = d.goldenCollision?.cellB || {};
  const methodAxis = (cellA.method && cellB.method) ? `${cellA.method} × ${cellB.method}` : 'unknown';
  const surpriseBucket = (cellA.surprise && cellB.surprise) ? `${cellA.surprise} × ${cellB.surprise}` : 'unknown';
  let sources = [];
  if (Array.isArray(d.supporting_sources)) {
    sources = d.supporting_sources
      .map(s => typeof s === 'string' ? s.split('—')[0].trim() : '')
      .filter(Boolean)
      .slice(0, 3);
  }
  if (sources.length === 0) sources = ['mixed'];
  const claimA = d.hypothesis || d.discovery || d.gap || 'Missing link between two AI domains';
  const claimB = d.bridge?.claim ? `Gap: ${d.bridge.claim}` : 'This connection remains untested.';
  return {
    id: d.id,
    date: todayKey(),
    corridor,
    methodAxis,
    surpriseBucket,
    sources,
    claim: `${claimA}. ${claimB}`,
    evidence: (d.abc_chain || []).slice(0, 2).map(l => `${l.link}: ${l.claim} — ${l.source}`),
    proposed_experiment: deepDive?.proposed_experiment || d.cheapest_validation?.design || 'Controlled benchmark or ablation study.',
    risks: (d.limiting_sources || d.confounders || []).slice(0, 3),
    references: (d.supporting_sources || []).slice(0, 5),
    scoring: {
      collision: d.goldenCollision?.score || 0,
      methodDistance: d.goldenCollision?.components?.methodDistance || null,
      semanticDistance: d.goldenCollision?.components?.semanticDistance || null,
      surpriseScore: d.goldenCollision?.components?.surprisePair || null,
      finalScore: d.scores?.total || 0,
      verifier: verification?.gpt_verdict || verification?.verdict || null
    },
    raw: {
      verdict: d.verdict?.verdict || d.verdict || null,
      pack: d.pack || null,
      cellLabels: d.cellLabels || []
    }
  };
}

function publishDailyGapsIfNeeded({ maxGaps = 5 } = {}) {
  const day = todayKey();
  const index = readJSON(INDEX_FILE, { date: day, total: 0, gaps: [] });
  if (index.date !== day) {
    index.date = day;
    index.total = 0;
    index.gaps = [];
  }
  if (index.gaps.length >= maxGaps) return { published: 0, total: index.gaps.length };

  const candidatesData = readCandidates();
  const candidates = candidatesData.days?.[day]?.candidates || [];
  if (candidates.length === 0) return { published: 0, total: index.gaps.length };

  const discoveries = readDiscoveries();
  const dives = readDeepDives();
  const vers = readVerifications();
  const diveMap = new Map(dives.map(d => [d.discovery_id, d]));
  const verMap = new Map(vers.map(v => [v.discovery_id, v]));

  const candidateDiscoveries = candidates
    .map(c => {
      const d = discoveries.find(x => x.id === c.id);
      if (!d) return null;
      const verdict = d.verdict?.verdict || d.verdict || '';
      if (!['HIGH-VALUE GAP', 'CONFIRMED DIRECTION'].includes(verdict)) return null;
      return { d, score: c.score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  let published = 0;
  for (const item of candidateDiscoveries) {
    if (index.gaps.length >= maxGaps) break;
    if (index.gaps.find(g => g.id === item.d.id)) continue;

    const gap = buildGapFromDiscovery(item.d, diveMap.get(item.d.id), verMap.get(item.d.id));
    writeJSONAtomic(path.join(GAPS_DIR, `${gap.id}.json`), gap);
    index.gaps.push({
      id: gap.id,
      score: gap.scoring.finalScore || 0,
      corridor: gap.corridor,
      methodAxis: gap.methodAxis,
      surpriseBucket: gap.surpriseBucket,
      sources: gap.sources,
      claim: gap.claim,
      date: gap.date
    });
    published++;
  }

  index.gaps.sort((a, b) => (b.score || 0) - (a.score || 0));
  index.total = index.gaps.length;
  writeJSONAtomic(INDEX_FILE, index);
  return { published, total: index.total };
}

module.exports = {
  recordDailyCandidate,
  shouldQueueDeepDive,
  publishDailyGapsIfNeeded
};
