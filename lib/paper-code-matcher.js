/**
 * CLASHD-27 — Paper-to-Code Matcher
 *
 * Detects gaps between academic papers and GitHub implementations:
 *   GAP TYPE A: Paper without code → "Unimplemented Research"
 *   GAP TYPE B: Code without paper → "Undocumented Innovation"
 *   GAP TYPE C: Paper + code but code diverges → "Implementation Drift"
 *
 * Uses:
 *   - GitHub Search API for code matching
 *   - Papers With Code API for paper→code links
 *   - Internal findings from the cube pipeline
 *
 * Cache: data/paper-code-cache.json, 6-hour TTL
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'paper-code-cache.json');
const GAPS_FILE = path.join(DATA_DIR, 'paper-code-gaps.json');
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// ─────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'CLASHD27-PaperCodeMatcher/1.0',
        ...headers
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { queries: {}, timestamp: null };
}

function writeCache(cache) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[PAPER-CODE] Cache write error: ${e.message}`);
  }
}

function readGaps() {
  try {
    if (fs.existsSync(GAPS_FILE)) {
      return JSON.parse(fs.readFileSync(GAPS_FILE, 'utf8'));
    }
  } catch (_) {}
  return { gaps: [], updated: null };
}

function writeGaps(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = GAPS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, GAPS_FILE);
  } catch (e) {
    console.error(`[PAPER-CODE] Gaps write error: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Papers With Code API
// ─────────────────────────────────────────────────────────────
async function searchPapersWithCode(title) {
  try {
    const query = encodeURIComponent(title.slice(0, 100));
    const data = await httpGet(`https://paperswithcode.com/api/v1/papers/?q=${query}&items_per_page=5`);
    return (data.results || []).map(p => ({
      pwc_id: p.id,
      title: p.title,
      abstract: (p.abstract || '').slice(0, 300),
      url_abs: p.url_abs,
      url_pdf: p.url_pdf,
      proceeding: p.proceeding,
      has_code: false, // will check repos below
      repos: []
    }));
  } catch (e) {
    console.error(`[PAPER-CODE] PWC search failed: ${e.message}`);
    return [];
  }
}

async function getPaperRepos(pwcId) {
  try {
    const data = await httpGet(`https://paperswithcode.com/api/v1/papers/${pwcId}/repositories/`);
    return (data.results || []).map(r => ({
      url: r.url,
      owner: r.owner,
      name: r.name,
      stars: r.stars || 0,
      framework: r.framework,
      is_official: r.is_official || false
    }));
  } catch (_) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// GitHub repo search by paper keywords
// ─────────────────────────────────────────────────────────────
async function searchGitHubForPaper(paperTitle, paperKeywords = []) {
  if (!GITHUB_TOKEN) return [];

  const query = extractSearchQuery(paperTitle, paperKeywords);
  try {
    const data = await httpGet(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`,
      {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    );
    return (data.items || []).map(r => ({
      full_name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      url: r.html_url,
      topics: r.topics || [],
      language: r.language,
      updated_at: r.updated_at
    }));
  } catch (e) {
    console.error(`[PAPER-CODE] GitHub search failed: ${e.message}`);
    return [];
  }
}

function extractSearchQuery(title, keywords = []) {
  // Extract meaningful words from paper title
  const stopwords = new Set([
    'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'from', 'as', 'is', 'was', 'are', 'and', 'or', 'but', 'not', 'this',
    'that', 'we', 'our', 'their', 'its', 'can', 'via', 'using', 'based'
  ]);
  const words = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));

  const queryParts = [...words.slice(0, 5), ...keywords.slice(0, 3)];
  return queryParts.join(' ');
}

// ─────────────────────────────────────────────────────────────
// GAP TYPE A: Paper without code
// ─────────────────────────────────────────────────────────────
async function findUnimplementedPapers(papers, { maxCheck = 50 } = {}) {
  const gaps = [];
  const checked = papers.slice(0, maxCheck);

  for (const paper of checked) {
    if (!paper.title || paper.source === 'github') continue;
    await wait(200); // rate limit

    // Check Papers With Code
    const pwcResults = await searchPapersWithCode(paper.title);
    let hasCode = false;

    if (pwcResults.length > 0) {
      for (const pwc of pwcResults.slice(0, 2)) {
        await wait(200);
        const repos = await getPaperRepos(pwc.pwc_id);
        if (repos.length > 0) {
          hasCode = true;
          break;
        }
      }
    }

    if (!hasCode) {
      // Double-check with GitHub search
      await wait(200);
      const ghRepos = await searchGitHubForPaper(paper.title, paper.concepts || []);
      const relevantRepos = ghRepos.filter(r =>
        r.description && titleSimilarity(paper.title, r.description) > 0.3
      );

      if (relevantRepos.length === 0) {
        gaps.push({
          type: 'A',
          gap_type: 'Unimplemented Research',
          paper: {
            paperId: paper.paperId,
            title: paper.title,
            abstract: (paper.abstract || '').slice(0, 300),
            year: paper.year,
            citations: paper.citationCount || 0,
            source: paper.source
          },
          repos: [],
          score: computeGapScore(paper, 'A'),
          detected_at: new Date().toISOString()
        });
      }
    }
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────
// GAP TYPE B: Code without paper
// ─────────────────────────────────────────────────────────────
async function findUndocumentedInnovations(repos) {
  const gaps = [];

  for (const repo of repos) {
    if (!repo.github_repo || !repo.title) continue;
    await wait(200);

    // Check if there's a paper for this repo
    const pwcResults = await searchPapersWithCode(repo.title);
    const hasRelatedPaper = pwcResults.some(p =>
      titleSimilarity(repo.title, p.title) > 0.3
    );

    if (!hasRelatedPaper && (repo.github_stars || 0) > 100) {
      gaps.push({
        type: 'B',
        gap_type: 'Undocumented Innovation',
        repo: {
          name: repo.github_repo,
          description: repo.abstract || '',
          stars: repo.github_stars || 0,
          language: repo.github_languages?.[0] || 'unknown',
          topics: repo.github_topics || [],
          url: repo.github_url
        },
        papers: [],
        score: computeGapScore(repo, 'B'),
        detected_at: new Date().toISOString()
      });
    }
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────
function computeGapScore(item, type) {
  let score = 50; // base score

  if (type === 'A') {
    // Paper without code — higher citations = bigger gap
    const citations = item.citationCount || 0;
    if (citations > 500) score += 30;
    else if (citations > 100) score += 20;
    else if (citations > 20) score += 10;

    // Recency bonus
    const year = item.year || 2020;
    if (year >= 2025) score += 10;
    else if (year >= 2023) score += 5;
  } else if (type === 'B') {
    // Code without paper — more stars = bigger gap
    const stars = item.github_stars || 0;
    if (stars > 10000) score += 30;
    else if (stars > 1000) score += 20;
    else if (stars > 100) score += 10;

    // AI topics bonus
    const aiTopics = (item.github_topics || []).filter(t =>
      AI_KEYWORDS.some(k => t.includes(k))
    );
    score += Math.min(10, aiTopics.length * 3);
  }

  return Math.min(100, score);
}

const AI_KEYWORDS = [
  'machine-learning', 'deep-learning', 'llm', 'transformer', 'neural',
  'ai', 'gpt', 'nlp', 'computer-vision', 'reinforcement-learning'
];

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ─────────────────────────────────────────────────────────────
// Main: detect all paper-code gaps
// ─────────────────────────────────────────────────────────────
async function detectGaps(papers = [], repos = [], { maxCheck = 30 } = {}) {
  console.log(`[PAPER-CODE] Detecting gaps: ${papers.length} papers, ${repos.length} repos`);

  const typeA = await findUnimplementedPapers(papers, { maxCheck });
  const typeB = await findUndocumentedInnovations(repos);

  const allGaps = [...typeA, ...typeB].sort((a, b) => b.score - a.score);

  // Persist gaps
  const existing = readGaps();
  const existingIds = new Set(existing.gaps.map(g =>
    g.paper?.paperId || g.repo?.name || ''
  ));

  let added = 0;
  for (const gap of allGaps) {
    const id = gap.paper?.paperId || gap.repo?.name || '';
    if (!existingIds.has(id)) {
      existing.gaps.push(gap);
      added++;
    }
  }

  // Keep only last 500 gaps
  if (existing.gaps.length > 500) {
    existing.gaps = existing.gaps.slice(-500);
  }
  existing.updated = new Date().toISOString();
  writeGaps(existing);

  console.log(`[PAPER-CODE] Gaps detected: ${allGaps.length} total (${typeA.length} type A, ${typeB.length} type B), ${added} new`);

  return {
    gaps: allGaps,
    typeA: typeA.length,
    typeB: typeB.length,
    total: allGaps.length
  };
}

// ─────────────────────────────────────────────────────────────
// Read persisted gaps
// ─────────────────────────────────────────────────────────────
function getPersistedGaps({ limit = 50, type = null } = {}) {
  const data = readGaps();
  let gaps = data.gaps || [];
  if (type) gaps = gaps.filter(g => g.type === type);
  return gaps.sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = {
  detectGaps,
  findUnimplementedPapers,
  findUndocumentedInnovations,
  searchPapersWithCode,
  searchGitHubForPaper,
  getPersistedGaps,
  titleSimilarity,
  GAPS_FILE,
};
