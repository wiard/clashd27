const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OVERRIDES_FILE = path.join(DATA_DIR, 'x-handles-overrides.json');
const CACHE_FILE = path.join(DATA_DIR, 'x-handles-cache.json');
const USAGE_FILE = path.join(DATA_DIR, 'github-usage.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_DAILY_CALLS = 30;

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
  const usage = readJSON(USAGE_FILE, { date: todayKey(), user_calls: 0 });
  if (usage.date !== todayKey()) {
    usage.date = todayKey();
    usage.user_calls = 0;
  }
  if (usage.user_calls === undefined && usage.count !== undefined) {
    usage.user_calls = usage.count;
  }
  return usage;
}

function canSpendCalls(n) {
  const usage = readUsage();
  return (usage.user_calls + n) <= MAX_DAILY_CALLS;
}

function spendCalls(n) {
  const usage = readUsage();
  usage.user_calls += n;
  safeWriteJSON(USAGE_FILE, usage);
}

function isFresh(entry) {
  if (!entry || !entry.checkedAt) return false;
  const ts = new Date(entry.checkedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) < TTL_MS;
}

function normalizeUsername(username) {
  if (!username || typeof username !== 'string') return null;
  const clean = username.trim().replace(/^@/, '');
  if (!clean) return null;
  return clean.toLowerCase();
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

async function resolveXHandle(githubUsername) {
  const username = normalizeUsername(githubUsername);
  if (!username) return { handle: null, source: 'invalid', confidence: 0 };

  const overrides = readJSON(OVERRIDES_FILE, {});
  if (overrides && overrides[username]) {
    return { handle: overrides[username], source: 'override', confidence: 1.0 };
  }

  const cache = readJSON(CACHE_FILE, {});
  const cached = cache[username];
  if (isFresh(cached)) return cached;

  if (!GITHUB_TOKEN) {
    return cached || { handle: null, source: 'no_token', confidence: 0 };
  }

  if (!canSpendCalls(1)) {
    return cached || { handle: null, source: 'rate_limited', confidence: 0 };
  }

  let response;
  try {
    spendCalls(1);
    response = await githubRequest(`/users/${username}`);
  } catch (e) {
    return cached || { handle: null, source: 'error', confidence: 0 };
  }

  if (response.status === 404) {
    const entry = { handle: null, source: 'not_found', confidence: 0, checkedAt: new Date().toISOString() };
    cache[username] = entry;
    safeWriteJSON(CACHE_FILE, cache);
    return entry;
  }

  if (response.status !== 200) {
    return cached || { handle: null, source: 'error', confidence: 0 };
  }

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch (e) {
    return cached || { handle: null, source: 'error', confidence: 0 };
  }

  let handle = payload.twitter_username ? `@${payload.twitter_username}` : null;
  let source = 'github_profile';
  let confidence = handle ? 0.9 : 0;

  if (!handle) {
    const blogHandle = extractXHandleFromUrl(payload.blog);
    if (blogHandle) {
      handle = blogHandle;
      source = 'blog';
      confidence = 0.6;
    }
  }

  if (!handle) {
    source = 'not_found';
    confidence = 0;
  }

  const entry = {
    handle: handle || null,
    source,
    confidence,
    checkedAt: new Date().toISOString()
  };

  cache[username] = entry;
  safeWriteJSON(CACHE_FILE, cache);
  return entry;
}

module.exports = {
  resolveXHandle
};
