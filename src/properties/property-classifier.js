'use strict';

const PROPERTIES = {
  COLLISION:   { id: 1,  name: 'Collision',   axis: 'movement' },
  GRADIENT:    { id: 2,  name: 'Gradient',    axis: 'movement' },
  VELOCITY:    { id: 3,  name: 'Velocity',    axis: 'movement' },
  TENSION:     { id: 4,  name: 'Tension',     axis: 'movement' },
  LEGACY:      { id: 5,  name: 'Legacy',      axis: 'movement' },
  SATURATION:  { id: 6,  name: 'Saturation',  axis: 'movement' },
  STASIS:      { id: 7,  name: 'Stasis',      axis: 'movement' },
  DECAY:       { id: 8,  name: 'Decay',       axis: 'movement' },
  REVIVAL:     { id: 9,  name: 'Revival',     axis: 'movement' },

  GRAVITY:     { id: 10, name: 'Gravity',     axis: 'structure' },
  ORPHAN:      { id: 11, name: 'Orphan',      axis: 'structure' },
  RESIDUE:     { id: 12, name: 'Residue',     axis: 'structure' },
  PARADOX:     { id: 13, name: 'Paradox',     axis: 'structure' },
  BRIDGE:      { id: 14, name: 'Bridge',      axis: 'structure' },
  ANCHOR:      { id: 15, name: 'Anchor',      axis: 'structure' },
  SCAFFOLD:    { id: 16, name: 'Scaffold',    axis: 'structure' },
  OUTLIER:     { id: 17, name: 'Outlier',     axis: 'structure' },
  CONSENSUS:   { id: 18, name: 'Consensus',   axis: 'structure' },

  EMERGENCE:   { id: 19, name: 'Emergence',   axis: 'potential' },
  SERENDIPITY: { id: 20, name: 'Serendipity', axis: 'potential' },
  SEED:        { id: 21, name: 'Seed',        axis: 'potential' },
  CATALYST:    { id: 22, name: 'Catalyst',    axis: 'potential' },
  BLIND_SPOT:  { id: 23, name: 'Blind Spot',  axis: 'potential' },
  SIGNAL:      { id: 24, name: 'Signal',      axis: 'potential' },
  GAP:         { id: 25, name: 'Gap',         axis: 'potential' },
  PROOF:       { id: 26, name: 'Proof',       axis: 'potential' },
  ANOMALY:     { id: 27, name: 'Anomaly',     axis: 'potential' }
};

const PROPERTY_DESCRIPTIONS = {
  Collision: 'Botst onverwacht met een ander domein',
  Gradient: 'Kennis beweegt zichtbaar in een richting',
  Velocity: 'Verspreidt zich snel door het veld',
  Tension: 'Nadert een collision',
  Legacy: 'Bewezen maar verliest relevantie',
  Saturation: 'Plafond bereikt in dit domein',
  Stasis: 'Stabiel — stil maar aanwezig',
  Decay: 'Lost op uit het actieve veld',
  Revival: 'Komt terug na vergeten te zijn',
  Gravity: 'Trekt andere kennis aan',
  Orphan: 'Bewezen maar heeft geen thuisdomein',
  Residue: 'Blijft achter na een paradigmaverschuiving',
  Paradox: 'Tegenspreekt bewezen kennis in hetzelfde veld',
  Bridge: 'Verbindt expliciet twee domeinen',
  Anchor: 'Houdt een veld op zijn plaats',
  Scaffold: 'Ondersteunt andere kennis',
  Outlier: 'Staat buiten het herkenbare patroon',
  Consensus: 'Is wat iedereen in het veld gelooft',
  Emergence: 'Iets nieuws ontstaat hier',
  Serendipity: 'Onverwachte structurele overeenkomst',
  Seed: 'Klein maar met grote implicatie',
  Catalyst: 'Versnelt andere kennis',
  'Blind Spot': 'Wat niemand in het veld ziet',
  Signal: 'Vroeg teken van iets groters',
  Gap: 'Ontbreekt maar zou er moeten zijn',
  Proof: 'Bevestigt wat al vermoed werd',
  Anomaly: 'Past niet in het patroon'
};

function classifyProperty(paper = {}, context = {}) {
  const citationCount = Number(context.citationCount || paper.citationCount || 0);
  const citationVelocity = Number(context.citationVelocity || 0);
  const domainCoverage = Array.isArray(context.domainCoverage) ? context.domainCoverage.filter(Boolean) : [];
  const yearsSincePublication = Number(context.yearsSincePublication || 0);
  const relatedPapers = Array.isArray(context.relatedPapers) ? context.relatedPapers : [];
  const fieldSaturation = Number(context.fieldSaturation || 0);

  if (citationVelocity > 50) return PROPERTIES.VELOCITY;
  if (citationCount > 500) return PROPERTIES.GRAVITY;
  if (fieldSaturation > 0.85) return PROPERTIES.SATURATION;
  if (yearsSincePublication > 10 && citationCount > 100) return PROPERTIES.LEGACY;
  if (yearsSincePublication > 5 && citationVelocity > 20) return PROPERTIES.REVIVAL;
  if (yearsSincePublication < 2 && domainCoverage.length > 2 && citationCount < 20) return PROPERTIES.SEED;
  if (context.hasGapStatement) return PROPERTIES.GAP;
  if (yearsSincePublication < 1 && relatedPapers.length < 5) return PROPERTIES.EMERGENCE;
  if (domainCoverage.length >= 3 && relatedPapers.length < 2) return PROPERTIES.ORPHAN;
  if (domainCoverage.length >= 2 && Number(context.domainDistance || 0) > 0.7) return PROPERTIES.TENSION;
  if (Number(context.collisionScore || 0) > 0.8) return PROPERTIES.COLLISION;
  if (domainCoverage.length === 2 && Number(context.bridgeScore || 0) > 0.6) return PROPERTIES.BRIDGE;
  if (Number(context.anomalyScore || 0) > 0.75) return PROPERTIES.ANOMALY;
  if (Number(context.fieldAge || 0) < 3 && citationVelocity > 10) return PROPERTIES.SIGNAL;
  if (context.isConfirmatory && citationCount > 50) return PROPERTIES.PROOF;
  if (citationCount > 200 && fieldSaturation > 0.5) return PROPERTIES.CONSENSUS;
  if (yearsSincePublication > 5 && citationCount > 300) return PROPERTIES.ANCHOR;

  return PROPERTIES.STASIS;
}

function getPropertyDescription(propertyName) {
  return PROPERTY_DESCRIPTIONS[propertyName] || 'Onbekend';
}

module.exports = {
  PROPERTIES,
  classifyProperty,
  getPropertyDescription
};
