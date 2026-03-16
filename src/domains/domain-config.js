'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'domains.json');

function readDomainConfig(configFile = DEFAULT_CONFIG_FILE) {
  const absolute = path.resolve(configFile);
  const raw = fs.readFileSync(absolute, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.domains)) {
    throw new Error(`Invalid domain config at ${absolute}`);
  }

  return parsed;
}

function normalizeDomain(domain, defaultSources = []) {
  const sources = Array.isArray(domain.sources) && domain.sources.length > 0
    ? domain.sources
    : defaultSources;

  return {
    id: String(domain.id || '').trim(),
    label: String(domain.label || domain.id || '').trim(),
    description: String(domain.description || '').trim(),
    queries: Array.isArray(domain.queries)
      ? domain.queries.map((query) => String(query || '').trim()).filter(Boolean)
      : [],
    sources: sources.map((source) => String(source || '').trim()).filter(Boolean),
    sourceWeight: Number.isFinite(Number(domain.sourceWeight)) ? Number(domain.sourceWeight) : 1,
    minScore: Number.isFinite(Number(domain.minScore)) ? Number(domain.minScore) : 0.4,
    enabled: domain.enabled !== false
  };
}

function loadDomains(options = {}) {
  const config = readDomainConfig(options.configFile);
  const defaultSources = Array.isArray(config.defaultSources) ? config.defaultSources : [];

  return config.domains
    .map((domain) => normalizeDomain(domain, defaultSources))
    .filter((domain) => domain.enabled !== false)
    .filter((domain) => !options.domainId || domain.id === options.domainId);
}

function getDomain(id, options = {}) {
  return loadDomains(options).find((domain) => domain.id === id) || null;
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  getDomain,
  loadDomains,
  readDomainConfig
};
