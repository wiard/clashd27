const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { enrichRepos } = require('./github-enricher');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GAPS_INDEX_FILE = process.env.GAPS_INDEX_FILE || path.join(DATA_DIR, 'gaps-index.json');
const FINDINGS_FILE = process.env.FINDINGS_FILE || path.join(DATA_DIR, 'findings.json');

function safeWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
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

function readGapsIndex() {
  try {
    if (fs.existsSync(GAPS_INDEX_FILE)) {
      const raw = fs.readFileSync(GAPS_INDEX_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    try {
      if (fs.existsSync(GAPS_INDEX_FILE)) {
        const backup = `${GAPS_INDEX_FILE}.corrupt-${Date.now()}.json`;
        fs.renameSync(GAPS_INDEX_FILE, backup);
      }
    } catch (err) {
      // ignore backup errors
    }
    try {
      safeWriteJSON(GAPS_INDEX_FILE, { gaps: [] });
    } catch (err) {
      // ignore reset errors
    }
  }
  return { gaps: [] };
}

function readFindings() {
  return readJSON(FINDINGS_FILE, { findings: [] });
}

function normalizeRepoToken(owner, repo) {
  if (!owner || !repo) return null;
  const cleanOwner = owner.replace(/[^A-Za-z0-9_.-]/g, '');
  const cleanRepo = repo.replace(/[^A-Za-z0-9_.-]/g, '');
  if (!cleanOwner || !cleanRepo) return null;
  if (!/[A-Za-z]/.test(cleanOwner) || !/[A-Za-z]/.test(cleanRepo)) return null;
  return `${cleanOwner}/${cleanRepo}`;
}

function extractReposFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const repos = [];
  const urlRegex = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git|\/|\b)/gi;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const normalized = normalizeRepoToken(match[1], match[2]);
    if (normalized) repos.push(normalized);
  }
  const plainRegex = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g;
  while ((match = plainRegex.exec(text)) !== null) {
    const normalized = normalizeRepoToken(match[1], match[2]);
    if (normalized) repos.push(normalized);
  }
  return repos;
}

function extractReposFromGap(discovery) {
  const sources = [];
  if (discovery?.source && typeof discovery.source === 'string') sources.push(discovery.source);
  if (Array.isArray(discovery?.supporting_sources)) {
    sources.push(...discovery.supporting_sources.map(s => typeof s === 'string' ? s : JSON.stringify(s)));
  }
  if (Array.isArray(discovery?.limiting_sources)) {
    sources.push(...discovery.limiting_sources.map(s => typeof s === 'string' ? s : JSON.stringify(s)));
  }
  if (Array.isArray(discovery?.abc_chain)) {
    for (const link of discovery.abc_chain) {
      if (link?.source) sources.push(String(link.source));
      if (link?.repo) sources.push(String(link.repo));
    }
  }
  const found = [];
  for (const src of sources) {
    found.push(...extractReposFromText(src));
  }
  return Array.from(new Set(found));
}

function computeCorridor(discovery) {
  if (discovery?.cellLabels && discovery.cellLabels.length > 0) {
    return discovery.cellLabels.join('×');
  }
  const cellA = discovery?.goldenCollision?.cellA || {};
  const cellB = discovery?.goldenCollision?.cellB || {};
  if (cellA.method && cellB.method) return `${cellA.method}×${cellB.method}`;
  return 'Cross-domain';
}

function extractPapers(discovery) {
  const papers = [];
  if (Array.isArray(discovery?.supporting_sources)) papers.push(...discovery.supporting_sources);
  if (Array.isArray(discovery?.limiting_sources)) papers.push(...discovery.limiting_sources);
  if (Array.isArray(discovery?.papers)) papers.push(...discovery.papers);
  return papers.filter(Boolean).slice(0, 20);
}

function normalizePaperEntry(paper) {
  if (!paper) return '';
  if (typeof paper === 'string') return paper.trim().toLowerCase();
  try {
    return JSON.stringify(paper).toLowerCase();
  } catch (e) {
    return String(paper).toLowerCase();
  }
}

function computeGapHash(papers, repos) {
  const paperTokens = (papers || []).map(normalizePaperEntry).filter(Boolean).sort();
  const repoTokens = (repos || []).map(r => (r.full_name || r).toLowerCase()).filter(Boolean).sort();
  const payload = JSON.stringify({ papers: paperTokens, repos: repoTokens });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function recordGap(gap) {
  if (!gap) return { ok: false, reason: 'no_gap' };
  const id = gap.id || gap.discovery_id || gap.discoveryId;
  if (!id) return { ok: false, reason: 'missing_id' };

  const findings = readFindings();
  const discovery = (findings.findings || []).find(f => f.id === id) || null;

  const repos = discovery ? extractReposFromGap(discovery) : [];
  const githubRepos = await enrichRepos(repos);

  const index = readGapsIndex();
  if (!index.gaps) index.gaps = [];

  if (index.gaps.find(g => g.id === id)) {
    return { ok: true, deduped: true, reason: 'id' };
  }

  const papers = discovery ? extractPapers(discovery) : [];
  const newHash = computeGapHash(papers, githubRepos);
  for (const existing of index.gaps) {
    const existingHash = computeGapHash(existing.papers || [], existing.githubRepos || []);
    if (existingHash === newHash) {
      return { ok: true, deduped: true, reason: 'hash' };
    }
  }

  const score = discovery?.scores?.total || discovery?.scoring?.finalScore || 0;
  const corridor = discovery ? computeCorridor(discovery) : 'Cross-domain';
  const createdAt = discovery?.timestamp || gap.timestamp || new Date().toISOString();

  index.gaps.push({
    id,
    createdAt,
    papers,
    githubRepos,
    score,
    corridor,
    status: 'open'
  });

  try {
    safeWriteJSON(GAPS_INDEX_FILE, index);
  } catch (e) {
    return { ok: false, reason: 'write_failed' };
  }

  return { ok: true, deduped: false };
}

function updateGapStatus(id, status) {
  if (!id) return { ok: false, reason: 'missing_id' };
  if (!['posted', 'resolved', 'open'].includes(status)) {
    return { ok: false, reason: 'invalid_status' };
  }
  const index = readGapsIndex();
  if (!index.gaps) index.gaps = [];
  const gap = index.gaps.find(g => g.id === id);
  if (!gap) return { ok: false, reason: 'not_found' };
  gap.status = status;
  try {
    safeWriteJSON(GAPS_INDEX_FILE, index);
  } catch (e) {
    return { ok: false, reason: 'write_failed' }; 
  }
  return { ok: true, id, status };
}

module.exports = {
  recordGap,
  updateGapStatus,
  safeWriteJSON
};
