const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = process.env.GITHUB_CACHE_FILE || path.join(DATA_DIR, 'github-cache.json');
const USAGE_FILE = process.env.GITHUB_USAGE_FILE || path.join(DATA_DIR, 'github-usage.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_DAILY_CALLS = 20;

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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readUsage() {
  const usage = readJSON(USAGE_FILE, { date: todayKey(), count: 0 });
  if (usage.date !== todayKey()) {
    usage.date = todayKey();
    usage.count = 0;
  }
  return usage;
}

function canSpendCalls(n) {
  const usage = readUsage();
  return (usage.count + n) <= MAX_DAILY_CALLS;
}

function spendCalls(n) {
  const usage = readUsage();
  usage.count += n;
  safeWriteJSON(USAGE_FILE, usage);
}

function readCache() {
  const cache = readJSON(CACHE_FILE, {});
  if (cache && typeof cache === 'object') return cache;
  return {};
}

function writeCache(cache) {
  safeWriteJSON(CACHE_FILE, cache);
}

function isFresh(entry) {
  if (!entry || !entry.lastChecked) return false;
  const ts = new Date(entry.lastChecked).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) < TTL_MS;
}

function normalizeRepo(input) {
  if (!input || typeof input !== 'string') return null;
  let val = input.trim();
  if (!val) return null;
  val = val.replace(/\.git$/i, '');
  const m = val.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!/[A-Za-z]/.test(owner) || !/[A-Za-z]/.test(repo)) return null;
  return `${owner}/${repo}`;
}

function extractXHandleFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let trimmed = url.trim();
  if (!trimmed) return null;
  try {
    if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('twitter.com') || host.includes('x.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        const handle = parts[0].replace(/[^A-Za-z0-9_]/g, '');
        if (handle) return `@${handle}`;
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

function githubRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      method: 'GET',
      path: apiPath,
      headers: {
        'User-Agent': 'clashd27',
        'Accept': 'application/vnd.github+json'
      }
    };
    if (GITHUB_TOKEN) {
      options.headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    }
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('GitHub API timeout (15s)'));
    });
    req.end();
  });
}

async function fetchOwnerProfile(ownerUrl) {
  if (!ownerUrl) return null;
  const pathMatch = ownerUrl.match(/^https:\/\/api\.github\.com(\/.*)$/);
  const apiPath = pathMatch ? pathMatch[1] : null;
  if (!apiPath) return null;
  const response = await githubRequest(apiPath);
  if (response.status !== 200) return null;
  try {
    return JSON.parse(response.body);
  } catch (e) {
    return null;
  }
}

async function fetchRepoInfo(owner, repo) {
  const response = await githubRequest(`/repos/${owner}/${repo}`);
  return response;
}

function formatCacheEntry(fullName, owner, repo, stars, xHandle, inactive) {
  return {
    full_name: fullName,
    owner,
    repo,
    xHandle: xHandle || null,
    stars: typeof stars === 'number' ? stars : 0,
    lastChecked: new Date().toISOString(),
    inactive: !!inactive
  };
}

async function enrichRepo(fullName, cache) {
  const cached = cache[fullName];
  if (isFresh(cached)) {
    return cached;
  }
  if (!GITHUB_TOKEN && !cached) {
    return cached || formatCacheEntry(fullName, fullName.split('/')[0], fullName.split('/')[1], 0, null, false);
  }
  if (!canSpendCalls(1)) {
    return cached || formatCacheEntry(fullName, fullName.split('/')[0], fullName.split('/')[1], 0, null, false);
  }

  const [owner, repo] = fullName.split('/');
  let repoResponse;
  try {
    spendCalls(1);
    repoResponse = await fetchRepoInfo(owner, repo);
  } catch (e) {
    return cached || formatCacheEntry(fullName, owner, repo, 0, null, false);
  }

  if (repoResponse.status === 404) {
    const inactiveEntry = formatCacheEntry(fullName, owner, repo, 0, null, true);
    cache[fullName] = inactiveEntry;
    return inactiveEntry;
  }

  if (repoResponse.status !== 200) {
    return cached || formatCacheEntry(fullName, owner, repo, 0, null, false);
  }

  let payload;
  try {
    payload = JSON.parse(repoResponse.body);
  } catch (e) {
    return cached || formatCacheEntry(fullName, owner, repo, 0, null, false);
  }

  const stars = payload.stargazers_count || 0;
  const ownerLogin = payload.owner?.login || owner;
  let xHandle = payload.owner?.twitter_username ? `@${payload.owner.twitter_username}` : null;

  if (!xHandle) {
    const blogUrl = payload.owner?.blog || null;
    xHandle = extractXHandleFromUrl(blogUrl);
  }

  if (!xHandle && payload.owner?.url) {
    try {
      if (!canSpendCalls(1)) throw new Error('github_usage_limit');
      spendCalls(1);
      const ownerProfile = await fetchOwnerProfile(payload.owner.url);
      if (ownerProfile) {
        if (ownerProfile.twitter_username) {
          xHandle = `@${ownerProfile.twitter_username}`;
        } else {
          xHandle = extractXHandleFromUrl(ownerProfile.blog);
        }
      }
    } catch (e) {
      // ignore owner profile errors
    }
  }

  const entry = formatCacheEntry(fullName, ownerLogin, repo, stars, xHandle, false);
  cache[fullName] = entry;
  return entry;
}

async function enrichRepos(repoList) {
  const cache = readCache();
  const normalized = (repoList || [])
    .map(normalizeRepo)
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));

  const results = [];
  for (const fullName of unique) {
    try {
      const enriched = await enrichRepo(fullName, cache);
      results.push(enriched);
    } catch (e) {
      const [owner, repo] = fullName.split('/');
      results.push(formatCacheEntry(fullName, owner, repo, 0, null, false));
    }
  }

  try {
    writeCache(cache);
  } catch (e) {
    // ignore cache write errors
  }

  return results;
}

module.exports = {
  enrichRepos
};
