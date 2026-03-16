'use strict';

const crypto = require('crypto');

const BELOFTE_TYPES = {
  VERBORGEN_VERBINDING: 'verborgen_verbinding',
  GEMISTE_INNOVATIE: 'gemiste_innovatie',
  HERHALENDE_PROBLEEMSTRUCTUUR: 'herhalende_probleemstructuur',
  CROSS_DOMEIN_BOTSING: 'cross_domein_botsing',
  SERENDIPITEIT: 'serendipiteit'
};

const BELOFTE_STATUS = {
  NEW: 'new',
  CONFIRMED: 'confirmed',
  STRONG: 'strong',
  ARCHIVED: 'archived'
};

const BELOFTE_TREND = {
  RISING: 'rising',
  STABLE: 'stable',
  FALLING: 'falling'
};

const TYPE_LABELS = {
  verborgen_verbinding: 'Verborgen Verbinding',
  gemiste_innovatie: 'Gemiste Innovatie',
  herhalende_probleemstructuur: 'Herhalende Probleemstructuur',
  cross_domein_botsing: 'Cross-Domein Botsing',
  serendipiteit: 'Serendipiteit'
};

function fingerprintBelofte(candidate) {
  const canonical = [
    candidate.type || '',
    (candidate.domeinen || []).slice().sort().join(','),
    (candidate.cellen || []).slice().sort().join(','),
    (candidate.bronnengaps || []).slice().sort().join(',')
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function createBelofte(candidate) {
  const beloofteId = candidate.beloofteId || fingerprintBelofte(candidate);
  return {
    beloofteId,
    titel: candidate.titel || '',
    type: candidate.type || BELOFTE_TYPES.VERBORGEN_VERBINDING,
    domeinen: Array.isArray(candidate.domeinen) ? candidate.domeinen.slice() : [],
    cellen: Array.isArray(candidate.cellen) ? candidate.cellen.slice() : [],
    hypothese: candidate.hypothese || '',
    verborgenVerband: candidate.verborgenVerband || '',
    bronnengaps: Array.isArray(candidate.bronnengaps) ? candidate.bronnengaps.slice() : [],
    score: Number.isFinite(candidate.score) ? Math.max(0, Math.min(1, candidate.score)) : 0,
    scoreTrace: candidate.scoreTrace || {},
    status: candidate.status || BELOFTE_STATUS.NEW,
    aangemaakt: candidate.aangemaakt || new Date().toISOString(),
    bevestigd: Number.isFinite(candidate.bevestigd) ? candidate.bevestigd : 0,
    trend: candidate.trend || BELOFTE_TREND.STABLE
  };
}

module.exports = {
  BELOFTE_TYPES,
  BELOFTE_STATUS,
  BELOFTE_TREND,
  TYPE_LABELS,
  createBelofte,
  fingerprintBelofte
};
