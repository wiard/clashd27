const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { persistKnowledgeArtifact } = require('./knowledge-artifacts');
const { recordCharge } = require('./heat-charge-tracker');
const { classifyProperty } = require('../src/properties/property-classifier');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GAPS_DIR = path.join(DATA_DIR, 'gaps');
const INDEX_FILE = path.join(GAPS_DIR, 'index.json');
const CANDIDATE_FILE = path.join(DATA_DIR, 'gap-candidates.json');
const FINDINGS_FILE = path.join(DATA_DIR, 'findings.json');
const FINDINGS_DRAFT_FILE = path.join(DATA_DIR, 'findings-draft.json');
const DEEP_DIVES_FILE = path.join(DATA_DIR, 'deep-dives.json');
const VERIFICATIONS_FILE = path.join(DATA_DIR, 'verifications.json');

function parseScoreThreshold(value, fallback) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  if (raw <= 1) return Math.round(raw * 100);
  return raw;
}

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

function hashNode(data) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex');
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

function readDrafts() {
  return readJSON(FINDINGS_DRAFT_FILE, { drafts: [] });
}

function writeDrafts(data) {
  writeJSONAtomic(FINDINGS_DRAFT_FILE, data);
}

function addFindingDraft(discovery, reasons) {
  if (!discovery || !discovery.id) return;
  const drafts = readDrafts();
  const normalizedReasons = Array.from(new Set((reasons || []).filter(Boolean)));
  const hypothesis = discovery.hypothesis || discovery.discovery || '';
  const entry = {
    id: discovery.id,
    timestamp: new Date().toISOString(),
    domain: discovery.domain || null,
    verdict: discovery.verdict?.verdict || discovery.verdict || null,
    score: discovery.scores?.total || 0,
    novelty: discovery.scores?.novelty || 0,
    hypothesis,
    bridgeClaim: discovery.bridge?.claim || '',
    sources: discovery.supporting_sources || [],
    reasons: normalizedReasons
  };
  const existingIndex = (drafts.drafts || []).findIndex((draft) => draft.id === discovery.id);
  if (existingIndex !== -1) {
    drafts.drafts[existingIndex] = {
      ...drafts.drafts[existingIndex],
      ...entry
    };
  } else {
    drafts.drafts.push(entry);
  }
  writeDrafts(drafts);
}

function qualifiesForPublication(discovery, options = {}) {
  const minScore = parseScoreThreshold(
    options.minPublishScore ?? process.env.MIN_PUBLISH_SCORE ?? '0.80',
    80
  );
  const minNovelty = parseScoreThreshold(
    options.minNoveltyScore ?? process.env.MIN_NOVELTY_SCORE ?? '0.70',
    70
  );
  const totalScore = Number(discovery?.scores?.total) || 0;
  const noveltyRaw = Number(discovery?.scores?.novelty) || 0;
  const noveltyScore = Math.round((noveltyRaw / 10) * 100);
  const sources = Array.isArray(discovery?.supporting_sources)
    ? discovery.supporting_sources.filter(Boolean)
    : [];
  const hypothesis = String(discovery?.hypothesis || discovery?.discovery || '').trim();
  const wordCount = hypothesis.split(/\s+/).filter(Boolean).length;
  const bridgeClaim = String(discovery?.bridge?.claim || '').trim();
  const reasons = [];

  if (totalScore < minScore) reasons.push(`score_below_${minScore}`);
  if (noveltyScore < minNovelty) reasons.push(`novelty_below_${minNovelty}`);
  if (sources.length === 0) reasons.push('missing_sources');
  if (wordCount < 20) reasons.push('hypothesis_too_short');
  if (!bridgeClaim) reasons.push('missing_bridge_claim');

  return {
    ok: reasons.length === 0,
    reasons,
    totalScore,
    noveltyScore,
    wordCount
  };
}

function buildGapFromDiscovery(d, deepDive, verification) {
  const publishedAt = new Date().toISOString();
  const cellA = d.goldenCollision?.cellA || {};
  const cellB = d.goldenCollision?.cellB || {};
  const corridor = (d.cellLabels && d.cellLabels.length > 0)
    ? d.cellLabels.join('×')
    : (cellA.method && cellB.method ? `${cellA.method}×${cellB.method}` : 'Cross-domain');
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
  const paperProperties = (d.supporting_sources || []).map((paper) => {
    const normalizedPaper = typeof paper === 'string'
      ? { title: paper, source: paper }
      : { ...paper };
    const property = classifyProperty(normalizedPaper, {
      citationCount: normalizedPaper.citationCount || 0,
      yearsSincePublication: new Date().getFullYear() - (normalizedPaper.year || 2020),
      domainCoverage: d.cellLabels || [],
      collisionScore: d.scores?.collision || d.goldenCollision?.score || 0,
      bridgeScore: d.bridge?.claim ? 0.7 : 0,
      hasGapStatement: Boolean(d.bridge?.claim || d.kill_test || d.cheapest_validation),
      isConfirmatory: /confirm|replicat|validate|support/i.test(String(normalizedPaper.title || normalizedPaper.source || ''))
    });
    return {
      ...normalizedPaper,
      property
    };
  });
  const dominantProperty = paperProperties.reduce((acc, paper) => {
    const propertyName = paper?.property?.name;
    if (!propertyName) return acc;
    acc[propertyName] = (acc[propertyName] || 0) + 1;
    return acc;
  }, {});
  const claimA = d.hypothesis || d.discovery || d.gap || 'Missing link between two AI domains';
  const claimB = d.bridge?.claim ? `Gap: ${d.bridge.claim}` : 'This connection remains untested.';
  const gap = {
    id: d.id,
    date: todayKey(),
    publishedAt,
    corridor,
    methodAxis,
    surpriseBucket,
    sources,
    claim: `${claimA}. ${claimB}`,
    evidence: (d.abc_chain || []).slice(0, 2).map(l => `${l.link}: ${l.claim} — ${l.source}`),
    proposed_experiment: deepDive?.proposed_experiment || d.cheapest_validation?.design || 'Controlled benchmark or ablation study.',
    risks: (d.limiting_sources || d.confounders || []).slice(0, 3),
    references: (d.supporting_sources || []).slice(0, 5),
    paperProperties,
    dominantProperty,
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
  gap.forestHash = hashNode({
    id: gap.id,
    hypothesis: gap.claim,
    score: gap.scoring,
    timestamp: gap.publishedAt
  });
  return gap;
}

function publishDailyGapsIfNeeded({ maxGaps = 5, force = false } = {}) {
  const day = todayKey();
  const index = readJSON(INDEX_FILE, { date: day, total: 0, gaps: [] });
  if (force || index.date !== day) {
    index.date = day;
    index.total = 0;
    index.gaps = [];
  }
  if (!force && index.gaps.length >= maxGaps) return { published: 0, total: index.gaps.length };

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
      if (!force && !['HIGH-VALUE GAP', 'CONFIRMED DIRECTION'].includes(verdict)) return null;
      return { d, score: c.score, quality: qualifiesForPublication(d) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  let published = 0;
  let drafted = 0;
  for (const item of candidateDiscoveries) {
    if (index.gaps.length >= maxGaps) break;
    if (index.gaps.find(g => g.id === item.d.id)) continue;
    if (!item.quality.ok) {
      addFindingDraft(item.d, item.quality.reasons);
      drafted++;
      continue;
    }

    const gap = buildGapFromDiscovery(item.d, diveMap.get(item.d.id), verMap.get(item.d.id));
    writeJSONAtomic(path.join(GAPS_DIR, `${gap.id}.json`), gap);
    recordCharge('gap');
    try {
      persistKnowledgeArtifact({
        kind: 'gap',
        title: gap.corridor || gap.id,
        summary: gap.claim || '',
        sourceRefs: gap.references || [],
        metadata: {
          gapId: gap.id,
          methodAxis: gap.methodAxis,
          scoring: gap.scoring,
          date: gap.date
        }
      }, DATA_DIR);
    } catch (e) {
      // Non-fatal: artifact persistence should not block gap publishing
    }
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
  return { published, drafted, total: index.total };
}

module.exports = {
  recordDailyCandidate,
  shouldQueueDeepDive,
  publishDailyGapsIfNeeded,
  qualifiesForPublication
};
