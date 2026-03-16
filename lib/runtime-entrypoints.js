const fs = require('fs');
const path = require('path');

const ENTRYPOINTS = Object.freeze({
  bot: {
    kind: 'canonical-runtime',
    description: 'Primary CLASHD27 runtime with Discord integration.'
  },
  engine: {
    kind: 'headless-runtime',
    description: 'Standalone console wrapper around TickEngine.'
  },
  dashboard: {
    kind: 'dashboard-server',
    description: 'Read-only dashboard and sandbox governance surface.'
  },
  publicSite: {
    kind: 'public-site-server',
    description: 'Public read-only site for gaps and findings.'
  }
});

const CANONICAL_RUNTIME_ENTRYPOINT = 'bot';
const DEFAULT_SERVER_ENV_PATHS = Object.freeze([
  '/home/greenbanaanas/.secrets/clashd27.env'
]);

function loadClashd27Env(options = {}) {
  const extraPaths = Array.isArray(options.extraPaths) ? options.extraPaths : [];
  const candidates = [
    ...extraPaths,
    path.join(__dirname, '..', '.env')
  ];

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) {
      continue;
    }
    require('dotenv').config({ path: candidate, override: true });
    return candidate;
  }

  return null;
}

function getEntrypointMetadata(name) {
  return ENTRYPOINTS[name] || null;
}

function getCanonicalRuntimeEntrypoint() {
  return CANONICAL_RUNTIME_ENTRYPOINT;
}

function loadClashd27ServerEnv() {
  return loadClashd27Env({ extraPaths: DEFAULT_SERVER_ENV_PATHS });
}

function bootstrapClashd27ServerEntrypoint(name) {
  const loadedEnvPath = loadClashd27ServerEnv();
  const entrypoint = getEntrypointMetadata(name);
  const canonicalRuntime = getCanonicalRuntimeEntrypoint();
  const canonicalMetadata = getEntrypointMetadata(canonicalRuntime);

  console.log(`[BOOT] entrypoint=${entrypoint?.kind || name}`);
  console.log(`[BOOT] canonical_runtime=${canonicalMetadata?.kind || canonicalRuntime}`);
  if (loadedEnvPath) {
    console.log(`[BOOT] env_source=${loadedEnvPath}`);
  }

  return entrypoint;
}

function startClashd27SupportServer(app, options) {
  const port = Number(options.port);
  const label = String(options.label || 'SERVER').trim() || 'SERVER';
  const host = String(options.host || 'localhost').trim() || 'localhost';
  const onStarted = typeof options.onStarted === 'function' ? options.onStarted : null;

  return app.listen(port, () => {
    console.log(`[${label}] Running on http://${host}:${port}`);
    if (onStarted) {
      onStarted();
    }
  });
}

module.exports = {
  bootstrapClashd27ServerEntrypoint,
  CANONICAL_RUNTIME_ENTRYPOINT,
  DEFAULT_SERVER_ENV_PATHS,
  ENTRYPOINTS,
  getCanonicalRuntimeEntrypoint,
  getEntrypointMetadata,
  loadClashd27Env,
  loadClashd27ServerEnv,
  startClashd27SupportServer
};
