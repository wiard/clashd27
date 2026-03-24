const fs = require('fs');
const path = require('path');
const { resolveXHandle } = require('./x-handle-resolver');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GAPS_INDEX_FILE = process.env.GAPS_INDEX_FILE || path.join(DATA_DIR, 'gaps-index.json');
const FINDINGS_FILE = process.env.FINDINGS_FILE || path.join(DATA_DIR, 'findings.json');

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

function safeWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function backupCorruptIndex() {
  if (!fs.existsSync(GAPS_INDEX_FILE)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${GAPS_INDEX_FILE}.bak-${stamp}`;
  fs.renameSync(GAPS_INDEX_FILE, backup);
}

function readGapsIndex() {
  try {
    if (fs.existsSync(GAPS_INDEX_FILE)) {
      return JSON.parse(fs.readFileSync(GAPS_INDEX_FILE, 'utf8'));
    }
  } catch (e) {
    try {
      backupCorruptIndex();
    } catch (err) {
      // ignore backup errors
    }
    try {
      writeGapsIndex({ gaps: [] });
    } catch (err) {
      // ignore reset errors
    }
  }
  return { gaps: [] };
}

function writeGapsIndex(index) {
  safeWriteJSON(GAPS_INDEX_FILE, index);
}

function readFindings() {
  return readJSON(FINDINGS_FILE, { findings: [] });
}

function normalizeRepo(repo) {
  if (!repo || typeof repo !== 'string') return null;
  const clean = repo.trim().replace(/\.git$/i, '');
  const match = clean.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return null;
  const owner = match[1].toLowerCase();
  const name = match[2].toLowerCase();
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

function extractReposFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const repos = [];
  const urlRegex = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git|\/|\b)/gi;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const normalized = normalizeRepo(`${match[1]}/${match[2]}`);
    if (normalized) repos.push(normalized);
  }
  const plainRegex = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/g;
  while ((match = plainRegex.exec(text)) !== null) {
    const normalized = normalizeRepo(`${match[1]}/${match[2]}`);
    if (normalized) repos.push(normalized);
  }
  return repos;
}

function extractRepos(gapObj, finding) {
  const sources = [];
  if (gapObj?.source) sources.push(String(gapObj.source));
  if (finding?.source) sources.push(String(finding.source));
  if (Array.isArray(finding?.supporting_sources)) {
    sources.push(...finding.supporting_sources.map(s => typeof s === 'string' ? s : JSON.stringify(s)));
  }
  if (Array.isArray(finding?.limiting_sources)) {
    sources.push(...finding.limiting_sources.map(s => typeof s === 'string' ? s : JSON.stringify(s)));
  }
  if (Array.isArray(finding?.abc_chain)) {
    for (const link of finding.abc_chain) {
      if (link?.source) sources.push(String(link.source));
      if (link?.repo) sources.push(String(link.repo));
    }
  }
  const repos = sources.flatMap(extractReposFromText);
  return Array.from(new Set(repos));
}

function computeCorridor(finding) {
  if (finding?.cellLabels && finding.cellLabels.length > 0) {
    return finding.cellLabels.join('×');
  }
  const cellA = finding?.goldenCollision?.cellA || {};
  const cellB = finding?.goldenCollision?.cellB || {};
  if (cellA.method && cellB.method) return `${cellA.method}×${cellB.method}`;
  return 'Cross-domain';
}

function normalizeSources(finding) {
  const sources = [];
  if (Array.isArray(finding?.supporting_sources)) sources.push(...finding.supporting_sources);
  if (Array.isArray(finding?.limiting_sources)) sources.push(...finding.limiting_sources);
  return sources.filter(Boolean).slice(0, 10);
}

async function buildRepoEntries(repos) {
  const entries = [];
  for (const repo of repos) {
    const [owner] = repo.split('/');
    let handle = null;
    try {
      const resolved = await resolveXHandle(owner);
      handle = resolved.handle || null;
    } catch (e) {
      handle = null;
    }
    entries.push({
      repo,
      maintainer_x_handle: handle
    });
  }
  return entries;
}

async function recordGap(gapObj) {
  if (!gapObj) return { ok: false, reason: 'no_gap' };
  const id = gapObj.id || gapObj.discovery_id || gapObj.discoveryId;
  if (!id) return { ok: false, reason: 'missing_id' };

  const index = readGapsIndex();
  if (!index.gaps) index.gaps = [];
  if (index.gaps.find(g => g.id === id)) return { ok: true, deduped: true };

  const findings = readFindings();
  const finding = (findings.findings || []).find(f => f.id === id) || null;

  const claim = (finding?.discovery || finding?.hypothesis || gapObj.hypothesis || gapObj.discovery || gapObj.gap || '').toString();
  const score = finding?.scores?.total || gapObj?.scores?.total || 0;
  const corridor = computeCorridor(finding);
  const sources = normalizeSources(finding);
  const repos = extractRepos(gapObj, finding);
  const repoEntries = await buildRepoEntries(repos);

  const createdAt = finding?.timestamp || gapObj.timestamp || new Date().toISOString();

  index.gaps.push({
    id,
    createdAt,
    claim,
    score,
    corridor,
    sources,
    repos: repoEntries,
    status: 'open'
  });

  try {
    writeGapsIndex(index);
  } catch (e) {
    return { ok: false, reason: 'write_failed' };
  }

  return { ok: true, deduped: false };
}

function updateGapStatus(id, status) {
  if (!id) return { ok: false, reason: 'missing_id' };
  if (!['open', 'posted', 'responded', 'resolved'].includes(status)) {
    return { ok: false, reason: 'invalid_status' };
  }
  const index = readGapsIndex();
  if (!index.gaps) index.gaps = [];
  const gap = index.gaps.find(g => g.id === id);
  if (!gap) return { ok: false, reason: 'not_found' };
  gap.status = status;
  try {
    writeGapsIndex(index);
  } catch (e) {
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true, id, status };
}

function getAllGaps() {
  const index = readGapsIndex();
  return Array.isArray(index.gaps) ? index.gaps : [];
}

function getGapById(id) {
  if (!id) return null;
  return getAllGaps().find(g => g.id === id) || null;
}

function getGapsForRepo(repo) {
  const target = normalizeRepo(repo);
  if (!target) return { repo: repo || '', gaps: [] };
  const gaps = getAllGaps().filter(g =>
    Array.isArray(g.repos) && g.repos.some(r => (r.repo || '').toLowerCase() === target)
  );
  return { repo: target, gaps };
}

module.exports = {
  recordGap,
  updateGapStatus,
  getAllGaps,
  getGapById,
  getGapsForRepo,
  readGapsIndex,
  writeGapsIndex
};
