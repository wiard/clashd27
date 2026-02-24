/**
 * CLASHD-27 — GitHub Monitor
 *
 * Monitors trending AI repos, watchlist repos, and mines issues.
 * Outputs normalized paper-like objects for the cube pipeline.
 *
 * Features:
 *   1. Trending AI repos scanner (daily)
 *   2. Watchlist repos deep monitoring (commits, releases, issues)
 *   3. Issue mining (open problems on large AI repos)
 *
 * Cache: data/github-cache.json, 1-hour TTL (trending), 30-min TTL (watchlist)
 * Rate limit: 100ms between requests (conservative for 5000 req/hr budget)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const ENABLED = process.env.GITHUB_MONITOR_ENABLED !== 'false';
const SCAN_INTERVAL = parseInt(process.env.GITHUB_SCAN_INTERVAL || '3600000', 10);
const WATCHLIST_INTERVAL = parseInt(process.env.GITHUB_WATCHLIST_INTERVAL || '1800000', 10);

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'github-cache.json');
const TRENDING_CACHE_TTL = 60 * 60 * 1000;       // 1 hour
const WATCHLIST_CACHE_TTL = 30 * 60 * 1000;       // 30 min

const AI_TOPICS = [
  'machine-learning', 'deep-learning', 'llm', 'transformers',
  'reinforcement-learning', 'computer-vision', 'nlp',
  'ai-agents', 'ai-safety', 'neural-network'
];

const WATCHLIST = [
  { repo: 'openclaw/openclaw', label: 'AI Agents / Personal Assistant' },
  { repo: 'langchain-ai/langchain', label: 'LLM Orchestration' },
  { repo: 'microsoft/autogen', label: 'Multi-Agent Framework' },
  { repo: 'crewAIInc/crewAI', label: 'Agent Crews' },
  { repo: 'huggingface/transformers', label: 'Model Hub' },
  { repo: 'vllm-project/vllm', label: 'LLM Serving' },
  { repo: 'ggml-ai/llama.cpp', label: 'Local Inference' },
  { repo: 'TransformerLensOrg/TransformerLens', label: 'Mechanistic Interpretability' },
  { repo: 'steipete/peekaboo', label: 'AI Screenshot Tool' },
  { repo: 'steipete/mcporter', label: 'MCP Bridge' },
  { repo: 'steipete/oracle', label: 'GPT-5 Pro CLI' },
  { repo: 'HKUDS/ClawWork', label: 'AI Economic Benchmark' },
];

// ─────────────────────────────────────────────────────────────
// Rate limiter
// ─────────────────────────────────────────────────────────────
let lastRequestTime = 0;
const RATE_LIMIT_MS = 100;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await wait(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

// ─────────────────────────────────────────────────────────────
// GitHub API fetch
// ─────────────────────────────────────────────────────────────
function ghFetch(endpoint) {
  return new Promise((resolve, reject) => {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'CLASHD27-Monitor/1.0',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    };
    if (GITHUB_TOKEN) {
      options.headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`GitHub JSON parse error: ${e.message}`));
          }
        } else if (res.statusCode === 403) {
          reject(new Error(`GitHub rate limited (403). Remaining: ${res.headers['x-ratelimit-remaining']}`));
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('GitHub API timeout (15s)'));
    });
    req.end();
  });
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
    console.error(`[GITHUB] Cache read error: ${e.message}`);
  }
  return { trending: null, watchlist: null, issues: null };
}

function writeCache(cache) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error(`[GITHUB] Cache write error: ${e.message}`);
  }
}

function isCacheValid(section, ttl) {
  const cache = readCache();
  if (!cache[section] || !cache[section].timestamp) return false;
  return (Date.now() - new Date(cache[section].timestamp).getTime()) < ttl;
}

// ─────────────────────────────────────────────────────────────
// 1. Trending AI Repos Scanner
// ─────────────────────────────────────────────────────────────
async function scanTrending({ daysBack = 7, minStars = 50 } = {}) {
  if (!ENABLED) return [];

  // Check cache
  if (isCacheValid('trending', TRENDING_CACHE_TTL)) {
    const cache = readCache();
    console.log(`[GITHUB] Trending from cache: ${cache.trending.repos.length} repos`);
    return cache.trending.repos;
  }

  console.log(`[GITHUB] Scanning trending AI repos (last ${daysBack} days, min ${minStars} stars)`);
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const repos = [];
  const seen = new Set();

  for (const topic of AI_TOPICS) {
    await rateLimit();
    try {
      const query = `topic:${topic}+created:>${since}+stars:>=${minStars}`;
      const data = await ghFetch(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30`);
      for (const item of (data.items || [])) {
        if (seen.has(item.full_name)) continue;
        seen.add(item.full_name);
        repos.push(normalizeRepo(item));
      }
    } catch (e) {
      console.error(`[GITHUB] Trending scan failed for ${topic}: ${e.message}`);
    }
  }

  // Sort by stars descending
  repos.sort((a, b) => b.github_stars - a.github_stars);

  // Cache results
  const cache = readCache();
  cache.trending = { timestamp: new Date().toISOString(), repos };
  writeCache(cache);

  console.log(`[GITHUB] Trending scan complete: ${repos.length} repos`);
  return repos;
}

// ─────────────────────────────────────────────────────────────
// 2. Watchlist Repos Monitor
// ─────────────────────────────────────────────────────────────
async function checkWatchlist() {
  if (!ENABLED) return [];

  // Check cache
  if (isCacheValid('watchlist', WATCHLIST_CACHE_TTL)) {
    const cache = readCache();
    console.log(`[GITHUB] Watchlist from cache: ${cache.watchlist.repos.length} repos`);
    return cache.watchlist.repos;
  }

  console.log(`[GITHUB] Checking watchlist: ${WATCHLIST.length} repos`);
  const results = [];

  for (const entry of WATCHLIST) {
    await rateLimit();
    try {
      // Fetch repo info
      const repo = await ghFetch(`/repos/${entry.repo}`);
      const normalized = normalizeRepo(repo, entry.label);

      // Fetch recent releases
      await rateLimit();
      try {
        const releases = await ghFetch(`/repos/${entry.repo}/releases?per_page=5`);
        normalized.recent_releases = (releases || []).slice(0, 3).map(r => ({
          tag: r.tag_name,
          name: r.name,
          date: r.published_at,
          prerelease: r.prerelease
        }));
      } catch (e) {
        normalized.recent_releases = [];
      }

      // Fetch open issues with actionable labels
      await rateLimit();
      try {
        const issues = await ghFetch(`/repos/${entry.repo}/issues?state=open&labels=bug,help+wanted&sort=reactions&direction=desc&per_page=10`);
        normalized.open_issues = (issues || []).slice(0, 5).map(i => ({
          number: i.number,
          title: i.title,
          labels: (i.labels || []).map(l => l.name),
          reactions: i.reactions?.total_count || 0,
          created_at: i.created_at,
          url: i.html_url
        }));
      } catch (e) {
        normalized.open_issues = [];
      }

      // Fetch recent commits (last 7 days)
      await rateLimit();
      try {
        const since = new Date(Date.now() - 7 * 86400000).toISOString();
        const commits = await ghFetch(`/repos/${entry.repo}/commits?since=${since}&per_page=20`);
        normalized.recent_commits_count = (commits || []).length;
        normalized.github_last_commit = commits?.[0]?.commit?.committer?.date || null;
      } catch (e) {
        normalized.recent_commits_count = 0;
      }

      // Try to detect dependencies from package.json / requirements.txt
      await rateLimit();
      normalized.github_dependencies = await fetchDependencies(entry.repo);

      results.push(normalized);
    } catch (e) {
      console.error(`[GITHUB] Watchlist check failed for ${entry.repo}: ${e.message}`);
      results.push({
        paperId: `github:${entry.repo}`,
        title: entry.repo.split('/')[1],
        source: 'github',
        github_repo: entry.repo,
        watchlist_label: entry.label,
        error: e.message
      });
    }
  }

  // Cache results
  const cache = readCache();
  cache.watchlist = { timestamp: new Date().toISOString(), repos: results };
  writeCache(cache);

  console.log(`[GITHUB] Watchlist check complete: ${results.length} repos`);
  return results;
}

// ─────────────────────────────────────────────────────────────
// 5. Issue Mining
// ─────────────────────────────────────────────────────────────
async function mineIssues({ repos = null, maxPerRepo = 10 } = {}) {
  if (!ENABLED) return [];

  const targetRepos = repos || WATCHLIST.map(w => w.repo);
  const allIssues = [];

  for (const repoName of targetRepos) {
    await rateLimit();
    try {
      const issues = await ghFetch(
        `/repos/${repoName}/issues?state=open&sort=reactions&direction=desc&per_page=${maxPerRepo}`
      );
      for (const issue of (issues || [])) {
        if (issue.pull_request) continue; // skip PRs
        allIssues.push({
          repo: repoName,
          number: issue.number,
          title: issue.title,
          body: (issue.body || '').slice(0, 500),
          labels: (issue.labels || []).map(l => l.name),
          reactions: issue.reactions?.total_count || 0,
          comments: issue.comments || 0,
          created_at: issue.created_at,
          url: issue.html_url
        });
      }
    } catch (e) {
      console.error(`[GITHUB] Issue mining failed for ${repoName}: ${e.message}`);
    }
  }

  // Sort by reactions (most impactful problems first)
  allIssues.sort((a, b) => b.reactions - a.reactions);
  return allIssues;
}

// ─────────────────────────────────────────────────────────────
// Dependency fetching
// ─────────────────────────────────────────────────────────────
async function fetchDependencies(repoName) {
  const deps = [];

  // Try package.json (Node.js)
  try {
    const content = await ghFetch(`/repos/${repoName}/contents/package.json`);
    if (content && content.content) {
      const json = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'));
      const allDeps = {
        ...(json.dependencies || {}),
        ...(json.devDependencies || {})
      };
      deps.push(...Object.keys(allDeps));
    }
  } catch (_) { /* no package.json */ }

  // Try requirements.txt (Python)
  if (deps.length === 0) {
    try {
      const content = await ghFetch(`/repos/${repoName}/contents/requirements.txt`);
      if (content && content.content) {
        const txt = Buffer.from(content.content, 'base64').toString('utf8');
        const lines = txt.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => l.split(/[>=<!\[]/)[0].trim())
          .filter(Boolean);
        deps.push(...lines);
      }
    } catch (_) { /* no requirements.txt */ }
  }

  // Try pyproject.toml (Python)
  if (deps.length === 0) {
    try {
      const content = await ghFetch(`/repos/${repoName}/contents/pyproject.toml`);
      if (content && content.content) {
        const txt = Buffer.from(content.content, 'base64').toString('utf8');
        const depSection = txt.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
        if (depSection) {
          const matches = depSection[1].match(/"([^"]+)"/g);
          if (matches) {
            deps.push(...matches.map(m => m.replace(/"/g, '').split(/[>=<!\[]/)[0].trim()));
          }
        }
      }
    } catch (_) { /* no pyproject.toml */ }
  }

  return [...new Set(deps)];
}

// ─────────────────────────────────────────────────────────────
// Normalize GitHub repo to paper-like object
// ─────────────────────────────────────────────────────────────
function normalizeRepo(ghData, watchlistLabel = null) {
  const repo = ghData;
  const fullName = repo.full_name || `${repo.owner?.login || 'unknown'}/${repo.name}`;

  return {
    // Paper-compatible fields
    paperId: `github:${fullName}`,
    doi: null,
    title: repo.name || fullName.split('/')[1],
    abstract: (repo.description || '').slice(0, 500),
    year: new Date(repo.created_at || Date.now()).getFullYear(),
    citationCount: repo.stargazers_count || 0,
    influentialCitationCount: repo.forks_count || 0,
    fieldsOfStudy: ['Computer Science'],
    concepts: (repo.topics || []).map(t => t.replace(/-/g, ' ')),
    primaryTopic: null,
    authors: repo.owner?.login || '',
    journal: 'GitHub',
    isRetracted: repo.archived || false,
    source: 'github',

    // GitHub-specific fields
    github_repo: fullName,
    github_stars: repo.stargazers_count || 0,
    github_forks: repo.forks_count || 0,
    github_issues_open: repo.open_issues_count || 0,
    github_last_commit: repo.pushed_at || null,
    github_created: repo.created_at || null,
    github_languages: repo.language ? [repo.language] : [],
    github_topics: repo.topics || [],
    github_dependencies: [],
    github_license: repo.license?.spdx_id || null,
    github_url: repo.html_url || `https://github.com/${fullName}`,

    // Watchlist metadata
    watchlist_label: watchlistLabel || null,
    recent_releases: [],
    open_issues: [],
    recent_commits_count: 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Get GitHub projects for sampler integration
// ─────────────────────────────────────────────────────────────
async function getGitHubProjects({ targetCount = 270 } = {}) {
  if (!ENABLED || !GITHUB_TOKEN) {
    console.log('[GITHUB] Disabled or no token — returning empty');
    return { projects: [], sourceBreakdown: { github: 0 }, from_cache: false };
  }

  try {
    const trending = await scanTrending();
    const watchlist = await checkWatchlist();

    // Merge, dedup by repo name
    const seen = new Set();
    const projects = [];

    // Watchlist repos first (higher priority)
    for (const r of watchlist) {
      if (r.error) continue;
      seen.add(r.github_repo);
      projects.push(r);
    }

    // Then trending repos
    for (const r of trending) {
      if (seen.has(r.github_repo)) continue;
      seen.add(r.github_repo);
      projects.push(r);
      if (projects.length >= targetCount) break;
    }

    console.log(`[GITHUB] Projects ready: ${projects.length} (watchlist=${watchlist.length}, trending=${trending.length})`);
    return {
      projects,
      sourceBreakdown: { github: projects.length },
      from_cache: false
    };
  } catch (e) {
    console.error(`[GITHUB] getGitHubProjects failed: ${e.message}`);
    return { projects: [], sourceBreakdown: { github: 0 }, from_cache: false };
  }
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
  scanTrending,
  checkWatchlist,
  mineIssues,
  fetchDependencies,
  getGitHubProjects,
  normalizeRepo,
  WATCHLIST,
  AI_TOPICS,
  CACHE_FILE,
  ENABLED,
};
