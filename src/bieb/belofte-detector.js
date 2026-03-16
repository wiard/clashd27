'use strict';

const { BELOFTE_TYPES, createBelofte, fingerprintBelofte } = require('./belofte');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function uniqueDomains(gap) {
  const domains = Array.isArray(gap.domains) ? gap.domains : [];
  if (domains.length > 0) return Array.from(new Set(domains));
  const history = Array.isArray(gap.domainHistory) ? gap.domainHistory : [];
  return Array.from(new Set(history.map((h) => h.domainId).filter(Boolean)));
}

function gapCells(gap) {
  return Array.isArray(gap.cells) ? gap.cells : [];
}

function computeSemanticOverlap(gapA, gapB) {
  const wordsA = new Set(tokenize(gapA.hypothesis || gapA.title || ''));
  const wordsB = new Set(tokenize(gapB.hypothesis || gapB.title || ''));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection += 1;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  const wordOverlap = union === 0 ? 0 : intersection / union;

  const cellsA = new Set(gapCells(gapA));
  const cellsB = new Set(gapCells(gapB));
  let cellIntersection = 0;
  for (const cell of cellsA) {
    if (cellsB.has(cell)) cellIntersection += 1;
  }
  const cellUnion = new Set([...cellsA, ...cellsB]).size;
  const cellOverlap = cellUnion === 0 ? 0 : cellIntersection / cellUnion;

  return round(cellOverlap * 0.6 + wordOverlap * 0.4);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function computeDomainDistance(domainsA, domainsB) {
  const setA = new Set(domainsA);
  const setB = new Set(domainsB);
  if (setA.size === 0 || setB.size === 0) return 1;
  let shared = 0;
  for (const d of setA) {
    if (setB.has(d)) shared += 1;
  }
  const total = new Set([...setA, ...setB]).size;
  return total === 0 ? 0 : round(1 - shared / total);
}

function computeEntropy(gap) {
  const history = Array.isArray(gap.scoreHistory) ? gap.scoreHistory : [];
  if (history.length < 2) return 0;
  const scores = history.map((h) => h.score || 0);
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
  return round(Math.min(1, Math.sqrt(variance) * 3));
}

function computeNovelty(gap) {
  const runCount = gap.runCount || 1;
  const domains = uniqueDomains(gap);
  const domainCount = domains.length;
  const recency = gap.lastSeenDaysAgo != null ? Math.max(0, 1 - gap.lastSeenDaysAgo / 30) : 1;
  return round(Math.min(1, (1 / Math.sqrt(runCount)) * 0.5 + (domainCount / 7) * 0.3 + recency * 0.2));
}

function buildTitle(type, gapA, gapB) {
  const domainA = (uniqueDomains(gapA)[0] || 'domein A').replace(/-/g, ' ');
  const domainB = gapB ? (uniqueDomains(gapB)[0] || 'domein B').replace(/-/g, ' ') : domainA;
  const cellRef = gapCells(gapA)[0] || 'onbekende cel';

  switch (type) {
    case BELOFTE_TYPES.VERBORGEN_VERBINDING:
      return `Verborgen verband tussen ${domainA} en ${domainB} in ${cellRef}`;
    case BELOFTE_TYPES.GEMISTE_INNOVATIE:
      return `Methode uit ${domainA} toepasbaar in ${domainB} via ${cellRef}`;
    case BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR:
      return `Herhalend patroon in ${cellRef} over ${uniqueDomains(gapA).length} domeinen`;
    case BELOFTE_TYPES.CROSS_DOMEIN_BOTSING:
      return `Cross-domein botsing tussen ${domainA} en ${domainB} in ${cellRef}`;
    case BELOFTE_TYPES.SERENDIPITEIT:
      return `Onverwachte convergentie in ${cellRef} vanuit ${domainA}`;
    default:
      return `Belofte in ${cellRef}`;
  }
}

function buildHypothese(type, gapA, gapB) {
  const cellRef = gapCells(gapA).join(', ') || 'onbekende cellen';
  const domainA = uniqueDomains(gapA)[0] || 'domein A';
  const domainB = gapB ? uniqueDomains(gapB)[0] || 'domein B' : '';

  switch (type) {
    case BELOFTE_TYPES.VERBORGEN_VERBINDING:
      return `Gaps in ${domainA} en ${domainB} delen structurele patronen in ${cellRef} die wijzen op een onontdekt verband.`;
    case BELOFTE_TYPES.GEMISTE_INNOVATIE:
      return `Methodologie uit ${domainA} is direct toepasbaar in ${domainB} gebaseerd op gedeelde celposities in ${cellRef}.`;
    case BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR:
      return `Het probleem in ${cellRef} herhaalt zich over ${uniqueDomains(gapA).length} domeinen — de structuur is domein-onafhankelijk.`;
    case BELOFTE_TYPES.CROSS_DOMEIN_BOTSING:
      return `Hoog-score signalen uit ${domainA} en ${domainB} botsen in ${cellRef} — spanning die nog niet benoemd is.`;
    case BELOFTE_TYPES.SERENDIPITEIT:
      return `Onverwachte signaalconvergentie in ${cellRef} suggereert een niet-voor-de-hand-liggend innovatiepad.`;
    default:
      return `Gaps in ${cellRef} bevatten een onontdekte mogelijkheid.`;
  }
}

function buildVerborgenVerband(type, gapA, gapB) {
  const domainsA = uniqueDomains(gapA).join(', ');
  const domainsB = gapB ? uniqueDomains(gapB).join(', ') : domainsA;
  const cellRef = gapCells(gapA).join(', ');

  switch (type) {
    case BELOFTE_TYPES.VERBORGEN_VERBINDING:
      return `Beide gaps delen celposities [${cellRef}] maar komen uit verschillende domeinen (${domainsA} vs ${domainsB}). De overlap duidt op een structurele gelijkenis die niet eerder gezien is.`;
    case BELOFTE_TYPES.GEMISTE_INNOVATIE:
      return `De methodologie in ${domainsA} heeft parallellen in ${domainsB} die via de kubus-mapping zichtbaar worden in [${cellRef}].`;
    case BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR:
      return `Hetzelfde probleemtype verschijnt steeds opnieuw in [${cellRef}] over meerdere domeinen heen. De herhaling is structureel, niet toevallig.`;
    case BELOFTE_TYPES.CROSS_DOMEIN_BOTSING:
      return `Hoge scores in [${cellRef}] uit ${domainsA} en ${domainsB} creëren een botsingszone. De spanning tussen deze signalen wijst op een onbenoemde grensovergang.`;
    case BELOFTE_TYPES.SERENDIPITEIT:
      return `Signalen uit [${cellRef}] convergeren onverwacht. De entropie en nieuwheid van het patroon suggereren een toevalstreffer met potentieel.`;
    default:
      return `Verborgen verband in [${cellRef}].`;
  }
}

function scoreBelofteCandidate(candidate) {
  const overlap = Number.isFinite(candidate.overlap) ? candidate.overlap : 0;
  const domainDistance = Number.isFinite(candidate.domainDistance) ? candidate.domainDistance : 0;
  const bevestigingScore = Number.isFinite(candidate.bevestigingScore) ? candidate.bevestigingScore : 0;
  const novelty = Number.isFinite(candidate.novelty) ? candidate.novelty : 0;
  const entropy = Number.isFinite(candidate.entropy) ? candidate.entropy : 0;

  const weighted = {
    overlap: round(overlap * 0.30),
    domainDistance: round(domainDistance * 0.25),
    bevestigingScore: round(bevestigingScore * 0.20),
    novelty: round(novelty * 0.15),
    entropy: round(entropy * 0.10)
  };

  const score = round(
    weighted.overlap +
    weighted.domainDistance +
    weighted.bevestigingScore +
    weighted.novelty +
    weighted.entropy
  );

  return {
    score: Math.max(0, Math.min(1, score)),
    scoreTrace: {
      overlap: { raw: round(overlap), weight: 0.30, contribution: weighted.overlap },
      domainDistance: { raw: round(domainDistance), weight: 0.25, contribution: weighted.domainDistance },
      bevestigingScore: { raw: round(bevestigingScore), weight: 0.20, contribution: weighted.bevestigingScore },
      novelty: { raw: round(novelty), weight: 0.15, contribution: weighted.novelty },
      entropy: { raw: round(entropy), weight: 0.10, contribution: weighted.entropy }
    }
  };
}

function classifyBelofte(candidate) {
  if (candidate.type) return candidate.type;

  const overlap = candidate.overlap || 0;
  const domainDistance = candidate.domainDistance || 0;
  const entropy = candidate.entropy || 0;
  const novelty = candidate.novelty || 0;
  const domainCount = (candidate.domeinen || []).length;
  const runCount = candidate.runCount || 0;

  if (runCount >= 2 && domainCount >= 3) {
    return BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR;
  }
  if (entropy > 0.6 && novelty > 0.6) {
    return BELOFTE_TYPES.SERENDIPITEIT;
  }
  if (overlap > 0.6 && domainDistance > 0.4) {
    if (domainDistance > 0.7) {
      return BELOFTE_TYPES.CROSS_DOMEIN_BOTSING;
    }
    return BELOFTE_TYPES.VERBORGEN_VERBINDING;
  }
  if (overlap > 0.5 && domainDistance > 0.3) {
    return BELOFTE_TYPES.GEMISTE_INNOVATIE;
  }
  return BELOFTE_TYPES.VERBORGEN_VERBINDING;
}

function detectBeloftes(gapLibraryEntries) {
  const gaps = Array.isArray(gapLibraryEntries) ? gapLibraryEntries : [];
  if (gaps.length === 0) return [];

  const candidates = [];
  const seen = new Set();

  // Group gaps by cells
  const byCells = new Map();
  for (const gap of gaps) {
    for (const cell of gapCells(gap)) {
      if (!byCells.has(cell)) byCells.set(cell, []);
      byCells.get(cell).push(gap);
    }
  }

  // Step 3: Pairwise comparison of gaps from different domains sharing cells
  for (const [, cellGaps] of byCells) {
    for (let i = 0; i < cellGaps.length; i++) {
      for (let j = i + 1; j < cellGaps.length; j++) {
        const gapA = cellGaps[i];
        const gapB = cellGaps[j];
        const domainsA = uniqueDomains(gapA);
        const domainsB = uniqueDomains(gapB);

        const domainDistance = computeDomainDistance(domainsA, domainsB);
        if (domainDistance < 0.4) continue;

        const overlap = computeSemanticOverlap(gapA, gapB);
        if (overlap < 0.6) continue;

        const pairKey = [gapA.fingerprint, gapB.fingerprint].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const allDomains = Array.from(new Set([...domainsA, ...domainsB]));
        const allCells = Array.from(new Set([...gapCells(gapA), ...gapCells(gapB)]));
        const bevestigingScore = round(Math.min(1, ((gapA.runCount || 1) + (gapB.runCount || 1)) / 20));
        const novelty = round((computeNovelty(gapA) + computeNovelty(gapB)) / 2);
        const entropy = round((computeEntropy(gapA) + computeEntropy(gapB)) / 2);

        const rawCandidate = {
          overlap,
          domainDistance,
          bevestigingScore,
          novelty,
          entropy,
          domeinen: allDomains,
          cellen: allCells,
          bronnengaps: [gapA.fingerprint, gapB.fingerprint].filter(Boolean),
          runCount: Math.max(gapA.runCount || 0, gapB.runCount || 0),
          gapA,
          gapB
        };

        rawCandidate.type = classifyBelofte(rawCandidate);
        const { score, scoreTrace } = scoreBelofteCandidate(rawCandidate);

        if (score < 0.55) continue;

        candidates.push(createBelofte({
          titel: buildTitle(rawCandidate.type, gapA, gapB),
          type: rawCandidate.type,
          domeinen: allDomains,
          cellen: allCells,
          hypothese: buildHypothese(rawCandidate.type, gapA, gapB),
          verborgenVerband: buildVerborgenVerband(rawCandidate.type, gapA, gapB),
          bronnengaps: rawCandidate.bronnengaps,
          score,
          scoreTrace
        }));
      }
    }
  }

  // Step 4: Gaps appearing in 3+ domains → herhalende_probleemstructuur
  for (const gap of gaps) {
    const domains = uniqueDomains(gap);
    if (domains.length < 3 || (gap.runCount || 0) < 2) continue;

    const fingerprint = gap.fingerprint || '';
    const alreadyCovered = candidates.some((c) =>
      c.type === BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR &&
      c.bronnengaps.includes(fingerprint)
    );
    if (alreadyCovered) continue;

    const bevestigingScore = round(Math.min(1, (gap.runCount || 1) / 10));
    const novelty = computeNovelty(gap);
    const entropy = computeEntropy(gap);
    const overlap = round(Math.min(1, domains.length / 7));
    const domainDistance = round(Math.min(1, (domains.length - 1) / 6));

    const rawCandidate = {
      overlap,
      domainDistance,
      bevestigingScore,
      novelty,
      entropy,
      domeinen: domains,
      cellen: gapCells(gap),
      bronnengaps: [fingerprint].filter(Boolean),
      runCount: gap.runCount || 0
    };

    rawCandidate.type = BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR;
    const { score, scoreTrace } = scoreBelofteCandidate(rawCandidate);

    if (score < 0.55) continue;

    candidates.push(createBelofte({
      titel: buildTitle(BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR, gap),
      type: BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR,
      domeinen: domains,
      cellen: gapCells(gap),
      hypothese: buildHypothese(BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR, gap),
      verborgenVerband: buildVerborgenVerband(BELOFTE_TYPES.HERHALENDE_PROBLEEMSTRUCTUUR, gap),
      bronnengaps: [fingerprint].filter(Boolean),
      score,
      scoreTrace
    }));
  }

  // Step 5: High entropy + high novelty → serendipiteit
  for (const gap of gaps) {
    const entropy = computeEntropy(gap);
    const novelty = computeNovelty(gap);

    if (entropy <= 0.6 || novelty <= 0.6) continue;

    const fingerprint = gap.fingerprint || '';
    const alreadyCovered = candidates.some((c) =>
      c.type === BELOFTE_TYPES.SERENDIPITEIT &&
      c.bronnengaps.includes(fingerprint)
    );
    if (alreadyCovered) continue;

    const domains = uniqueDomains(gap);
    const domainDistance = round(Math.min(1, (domains.length - 1) / 6));
    const bevestigingScore = round(Math.min(1, (gap.runCount || 1) / 10));

    const rawCandidate = {
      overlap: round(entropy * 0.5 + novelty * 0.5),
      domainDistance,
      bevestigingScore,
      novelty,
      entropy,
      domeinen: domains,
      cellen: gapCells(gap),
      bronnengaps: [fingerprint].filter(Boolean)
    };

    const { score, scoreTrace } = scoreBelofteCandidate(rawCandidate);

    if (score < 0.55) continue;

    candidates.push(createBelofte({
      titel: buildTitle(BELOFTE_TYPES.SERENDIPITEIT, gap),
      type: BELOFTE_TYPES.SERENDIPITEIT,
      domeinen: domains,
      cellen: gapCells(gap),
      hypothese: buildHypothese(BELOFTE_TYPES.SERENDIPITEIT, gap),
      verborgenVerband: buildVerborgenVerband(BELOFTE_TYPES.SERENDIPITEIT, gap),
      bronnengaps: [fingerprint].filter(Boolean),
      score,
      scoreTrace
    }));
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

module.exports = {
  detectBeloftes,
  scoreBelofteCandidate,
  classifyBelofte,
  computeSemanticOverlap,
  computeDomainDistance,
  computeEntropy,
  computeNovelty
};
