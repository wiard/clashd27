/**
 * CLASHD-27 — Cross-Repo Dependency Graph
 *
 * Detects "invisible bridges" between repos in different domains
 * that share unexpected dependencies.
 *
 * Example: A robotics repo and an NLP repo both using 'einops'
 * → methodological bridge that nobody has noticed.
 *
 * Implementation:
 *   1. Collect dependencies from trending + watchlist repos
 *   2. Build dependency→repo graph
 *   3. Find dependencies shared across repos in different domains
 *   4. Score & rank collision candidates for the tick engine
 *
 * Cache: data/dependency-graph.json, 6-hour TTL
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GRAPH_FILE = path.join(DATA_DIR, 'dependency-graph.json');
const COLLISIONS_FILE = path.join(DATA_DIR, 'dependency-collisions.json');

// ─────────────────────────────────────────────────────────────
// Domain classification for repos
// ─────────────────────────────────────────────────────────────
const DOMAIN_SIGNALS = {
  'nlp': ['nlp', 'natural-language', 'text', 'language-model', 'llm', 'chatbot', 'tokenizer', 'bert', 'gpt'],
  'computer-vision': ['computer-vision', 'image', 'video', 'object-detection', 'segmentation', 'ocr', 'diffusion'],
  'robotics': ['robotics', 'robot', 'control', 'motion-planning', 'ros', 'simulation', 'embodied'],
  'reinforcement-learning': ['reinforcement-learning', 'rl', 'gym', 'environment', 'reward', 'policy'],
  'ai-safety': ['ai-safety', 'alignment', 'interpretability', 'mechanistic', 'jailbreak', 'red-team'],
  'ai-agents': ['ai-agents', 'agent', 'tool-use', 'agentic', 'orchestration', 'crew', 'autogen'],
  'ml-infra': ['serving', 'inference', 'training', 'distributed', 'gpu', 'cuda', 'optimization', 'compiler'],
  'data-science': ['data-science', 'analytics', 'visualization', 'pandas', 'notebook', 'statistics'],
  'audio': ['audio', 'speech', 'tts', 'asr', 'music', 'voice', 'whisper'],
  'bioml': ['bioinformatics', 'protein', 'drug', 'molecular', 'genomics', 'medical', 'clinical'],
};

// Common deps that are too generic to form interesting collisions
const BORING_DEPS = new Set([
  'numpy', 'scipy', 'pandas', 'matplotlib', 'requests', 'pytest', 'setuptools',
  'pip', 'wheel', 'tqdm', 'pyyaml', 'pydantic', 'click', 'typing-extensions',
  'express', 'react', 'lodash', 'axios', 'typescript', 'eslint', 'prettier',
  'jest', 'dotenv', 'cors', 'nodemon', 'webpack', 'babel', 'uuid',
  'torch', 'tensorflow', 'jax', 'transformers', 'datasets', 'tokenizers',
  'huggingface-hub', 'accelerate', 'safetensors', 'sentencepiece',
  'python', 'node', 'npm', 'pip', 'setuptools', 'wheel',
]);

// ─────────────────────────────────────────────────────────────
// Domain detection
// ─────────────────────────────────────────────────────────────
function detectDomain(repo) {
  const signals = [
    ...(repo.github_topics || []),
    ...(repo.concepts || []),
    (repo.abstract || '').toLowerCase(),
    (repo.title || '').toLowerCase(),
    (repo.watchlist_label || '').toLowerCase(),
  ].join(' ').toLowerCase();

  const scores = {};
  for (const [domain, keywords] of Object.entries(DOMAIN_SIGNALS)) {
    scores[domain] = keywords.filter(k => signals.includes(k)).length;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] === 0) return 'general';
  return sorted[0][0];
}

// ─────────────────────────────────────────────────────────────
// Build dependency graph
// ─────────────────────────────────────────────────────────────
function buildGraph(repos) {
  // dep → [{ repo, domain, stars }]
  const depToRepos = new Map();
  const repoToDeps = new Map();

  for (const repo of repos) {
    const deps = repo.github_dependencies || [];
    const domain = detectDomain(repo);
    const repoInfo = {
      name: repo.github_repo || repo.paperId,
      domain,
      stars: repo.github_stars || repo.citationCount || 0,
      title: repo.title,
      topics: repo.github_topics || [],
    };

    repoToDeps.set(repoInfo.name, { deps, domain });

    for (const dep of deps) {
      const depLower = dep.toLowerCase().trim();
      if (BORING_DEPS.has(depLower)) continue;
      if (depLower.length < 2) continue;

      if (!depToRepos.has(depLower)) {
        depToRepos.set(depLower, []);
      }
      depToRepos.get(depLower).push(repoInfo);
    }
  }

  return { depToRepos, repoToDeps };
}

// ─────────────────────────────────────────────────────────────
// Find cross-domain collisions
// ─────────────────────────────────────────────────────────────
function findCollisions(repos, { minRepos = 2 } = {}) {
  console.log(`[DEP-GRAPH] Building graph from ${repos.length} repos`);
  const { depToRepos } = buildGraph(repos);
  const collisions = [];

  for (const [dep, repoList] of depToRepos.entries()) {
    if (repoList.length < minRepos) continue;

    // Get unique domains for this dependency
    const domains = [...new Set(repoList.map(r => r.domain))];
    if (domains.length < 2) continue; // same domain = boring

    // Cross-domain collision found
    const score = computeCollisionScore(dep, repoList, domains);
    collisions.push({
      dependency: dep,
      domains,
      repos: repoList.map(r => ({
        name: r.name,
        domain: r.domain,
        stars: r.stars,
        title: r.title
      })),
      score,
      bridge_type: domains.length >= 3 ? 'multi-domain' : 'cross-domain',
      detected_at: new Date().toISOString()
    });
  }

  // Sort by score
  collisions.sort((a, b) => b.score - a.score);

  console.log(`[DEP-GRAPH] Found ${collisions.length} cross-domain dependency collisions`);
  return collisions;
}

function computeCollisionScore(dep, repos, domains) {
  let score = 40; // base

  // More unique domains = more interesting
  score += (domains.length - 1) * 15;

  // Higher total stars = more impactful connection
  const totalStars = repos.reduce((s, r) => s + r.stars, 0);
  if (totalStars > 50000) score += 20;
  else if (totalStars > 10000) score += 15;
  else if (totalStars > 1000) score += 10;

  // Niche deps are more interesting than common ones
  if (repos.length <= 3) score += 10; // very niche
  if (repos.length > 10) score -= 10; // too common

  return Math.min(100, Math.max(0, score));
}

// ─────────────────────────────────────────────────────────────
// Persist & read
// ─────────────────────────────────────────────────────────────
function writeJSONAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function saveCollisions(collisions) {
  writeJSONAtomic(COLLISIONS_FILE, {
    updated: new Date().toISOString(),
    total: collisions.length,
    collisions
  });
}

function readCollisions() {
  try {
    if (fs.existsSync(COLLISIONS_FILE)) {
      return JSON.parse(fs.readFileSync(COLLISIONS_FILE, 'utf8'));
    }
  } catch (_) {}
  return { collisions: [], updated: null, total: 0 };
}

function saveGraph(repos) {
  const { depToRepos, repoToDeps } = buildGraph(repos);

  // Serialize (Maps → Objects)
  const serialized = {
    updated: new Date().toISOString(),
    repo_count: repos.length,
    unique_deps: depToRepos.size,
    dep_to_repos: {},
    repo_to_domain: {}
  };

  for (const [dep, repoList] of depToRepos.entries()) {
    serialized.dep_to_repos[dep] = repoList.map(r => r.name);
  }
  for (const [repo, info] of repoToDeps.entries()) {
    serialized.repo_to_domain[repo] = info.domain;
  }

  writeJSONAtomic(GRAPH_FILE, serialized);
  return serialized;
}

// ─────────────────────────────────────────────────────────────
// Main: analyze deps and find collisions
// ─────────────────────────────────────────────────────────────
async function analyzeAndFindCollisions(repos) {
  console.log(`[DEP-GRAPH] Analyzing ${repos.length} repos for dependency collisions`);

  // Only include repos that have deps
  const reposWithDeps = repos.filter(r => (r.github_dependencies || []).length > 0);
  console.log(`[DEP-GRAPH] ${reposWithDeps.length} repos have dependencies`);

  if (reposWithDeps.length < 3) {
    console.log('[DEP-GRAPH] Not enough repos with dependencies — skipping');
    return { collisions: [], graph: null };
  }

  // Build & save graph
  const graph = saveGraph(reposWithDeps);

  // Find collisions
  const collisions = findCollisions(reposWithDeps);
  saveCollisions(collisions);

  return { collisions, graph };
}

module.exports = {
  analyzeAndFindCollisions,
  findCollisions,
  buildGraph,
  detectDomain,
  readCollisions,
  saveCollisions,
  GRAPH_FILE,
  COLLISIONS_FILE,
};
