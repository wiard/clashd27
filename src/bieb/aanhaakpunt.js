'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'aanhaakpunten.json');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function computeBuffer(runCount) {
  return round(1 - (1 / (1 + (runCount || 0) * 0.3)));
}

function fingerprintAanhaakpunt(woord, domeinen) {
  const canonical = [
    String(woord || '').toLowerCase().trim(),
    (domeinen || []).slice().sort().join(',')
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

function createAanhaakpunt(entry, soortKey) {
  const woord = String(entry.woord || '').trim();
  const gewicht = Number.isFinite(entry.gewicht) ? Math.max(0, Math.min(1, entry.gewicht)) : 0.5;
  const domeinen = Array.isArray(entry.domeinen) ? entry.domeinen.slice() : [];
  const soort = soortKey === 'cross_domain' ? 'cross_domain' : 'domain_specific';
  const runCount = Number.isFinite(entry.runCount) ? entry.runCount : 0;

  return {
    aanhaakpuntId: fingerprintAanhaakpunt(woord, domeinen),
    woord,
    gewicht,
    domeinen,
    soort,
    runCount,
    buffer: computeBuffer(runCount)
  };
}

function loadAanhaakpunten(configPath) {
  const filePath = configPath || CONFIG_PATH;
  if (!fs.existsSync(filePath)) return [];

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const result = [];
  const seen = new Set();

  for (const [soortKey, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const woord = String(entry.woord || '').toLowerCase().trim();
      if (!woord || seen.has(woord)) continue;
      seen.add(woord);
      result.push(createAanhaakpunt(entry, soortKey));
    }
  }

  return result.sort((a, b) => b.gewicht - a.gewicht || b.domeinen.length - a.domeinen.length);
}

function selectAanhaakpuntenForCube(aanhaakpunten, maxCount, gapDomains) {
  if (!Array.isArray(aanhaakpunten) || aanhaakpunten.length === 0) return [];

  const gapDomainSet = new Set(gapDomains || []);
  const scored = aanhaakpunten.map((ap) => {
    const domainRelevance = ap.domeinen.filter((d) => gapDomainSet.has(d)).length / Math.max(1, ap.domeinen.length);
    const priority = ap.gewicht * 0.5 + domainRelevance * 0.3 + ap.buffer * 0.2;
    return { ap, priority };
  });

  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, maxCount).map((s) => s.ap);
}

function computeAanhaakpuntBridgeScore(aanhaakpunten) {
  if (!Array.isArray(aanhaakpunten) || aanhaakpunten.length === 0) return 0;
  const totalWeightedScore = aanhaakpunten.reduce((sum, ap) => sum + (ap.gewicht || 0), 0);
  return round(Math.min(1, totalWeightedScore / aanhaakpunten.length));
}

function crossAanhaakpuntBonus(aanhaakpunt) {
  if (!aanhaakpunt || aanhaakpunt.soort !== 'cross_domain') return 0;
  if ((aanhaakpunt.gewicht || 0) <= 0.8) return 0;
  return round(aanhaakpunt.gewicht * 0.15);
}

function aanhaakpuntToCubeItem(ap) {
  return {
    label: ap.woord,
    title: ap.woord,
    hypothesis: null,
    score: round(0.3 + ap.gewicht * 0.4),
    domain: ap.domeinen.length > 1 ? 'cross-domain' : (ap.domeinen[0] || 'concept'),
    domains: ap.domeinen.length > 0 ? ap.domeinen.slice() : ['concept'],
    type: 'aanhaakpunt',
    source: 'aanhaakpunt',
    gapId: null,
    fingerprint: ap.aanhaakpuntId,
    aanhaakpunt: ap
  };
}

function incrementRunCount(aanhaakpunt) {
  const nextRunCount = (aanhaakpunt.runCount || 0) + 1;
  return {
    ...aanhaakpunt,
    runCount: nextRunCount,
    buffer: computeBuffer(nextRunCount)
  };
}

module.exports = {
  loadAanhaakpunten,
  createAanhaakpunt,
  computeBuffer,
  computeAanhaakpuntBridgeScore,
  crossAanhaakpuntBonus,
  selectAanhaakpuntenForCube,
  aanhaakpuntToCubeItem,
  incrementRunCount,
  fingerprintAanhaakpunt
};
