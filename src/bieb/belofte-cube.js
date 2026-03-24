import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

import { DEFAULT_GAP_LIBRARY_PATH, resolvePromiseLibraryLayout } from './promise-paths.js';
import {
  loadAanhaakpunten,
  selectAanhaakpuntenForCube,
  aanhaakpuntToCubeItem,
  computeAanhaakpuntBridgeScore
} from './aanhaakpunt.js';

const FALLBACK_CONCEPTS = [
  'pattern recognition', 'data fusion', 'knowledge graphs',
  'distributed systems', 'human-AI collaboration', 'causal inference',
  'anomaly detection', 'model validation', 'emergent systems',
  'multi-agent coordination', 'probabilistic reasoning',
  'scientific reproducibility', 'cross-domain analogy',
  'uncertainty quantification', 'algorithmic governance',
  'reinforcement learning', 'data compression', 'collective intelligence',
  'decision theory', 'network resilience', 'adaptive algorithms',
  'signal processing', 'system modeling', 'innovation diffusion',
  'complex systems', 'knowledge discovery', 'semantic mapping'
];

const LAYER_LABELS = ['historical', 'current', 'emerging'];
const SHORT_NAME_MODEL = 'claude-haiku-4-5-20251001';
const SHORT_NAME_SYSTEM_PROMPT = 'Je bent een wetenschappelijk redacteur. Geef een korte, krachtige Nederlandse naam (max 4 woorden) voor dit onderzoekspatroon. Geen technisch jargon. Geef alleen de naam, niets anders.';
const SHORT_NAME_SEGMENT_MAP = {
  'trust-model': 'vertrouwen',
  architecture: 'architectuur',
  surface: 'interface',
  engine: 'kern',
  internal: 'intern',
  external: 'extern',
  historical: 'historisch',
  current: 'huidig',
  emerging: 'nieuw'
};

let anthropicClient = null;

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value || 0)));
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

function createSeededRandom(seedInput) {
  const seed = String(seedInput || 'belofte-cube-default');
  let state = 0;
  for (let index = 0; index < seed.length; index += 1) {
    state = (state * 31 + seed.charCodeAt(index)) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;

  return function next() {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, random) {
  const copy = array.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = current;
  }
  return copy;
}

function safeReadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function isSignalClusterLabel(label) {
  return /^Signals clustered in\s+/i.test(String(label || ''));
}

function mappedSegment(segment) {
  return SHORT_NAME_SEGMENT_MAP[segment] || segment.replace(/-/g, ' ');
}

function fallbackShortName(label) {
  const rawLabel = String(label || '').trim();
  if (!isSignalClusterLabel(rawLabel)) {
    return rawLabel;
  }

  const match = rawLabel.match(/^Signals clustered in\s+(.+?)\s+indicate/i);
  const signature = match ? match[1].trim() : rawLabel;
  const refs = signature.split(/\s+x\s+/i).map((ref) => ref.trim()).filter(Boolean);
  const parsedRefs = refs.map((ref) => ref.split('/').map((part) => part.trim()).filter(Boolean));

  if (
    parsedRefs.length >= 2
    && parsedRefs.every((parts) => parts.length === 3)
    && parsedRefs.every((parts) => parts[0] === parsedRefs[0][0] && parts[1] === parsedRefs[0][1])
  ) {
    return [
      mappedSegment(parsedRefs[0][0]),
      mappedSegment(parsedRefs[0][1]),
      'verschuiving'
    ].join(' ');
  }

  const words = Array.from(new Set(
    parsedRefs.flatMap((parts) => parts.map(mappedSegment))
  )).slice(0, 4);

  return words.join(' ') || rawLabel;
}

function sanitizeShortName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split('\n')[0]
    .replace(/[.,:;!?]+$/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length > 0 ? words.join(' ') : fallback;
}

function getAnthropicClient(options = {}) {
  const apiKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function extractTextBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .trim();
}

async function generateShortName(label, options = {}) {
  const fallback = fallbackShortName(label);
  if (options.enableAnthropicShortNames === false) {
    return fallback;
  }

  const client = getAnthropicClient(options);
  if (!client) {
    return fallback;
  }

  try {
    const message = await client.messages.create({
      model: SHORT_NAME_MODEL,
      max_tokens: 24,
      system: SHORT_NAME_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: label }
      ]
    });
    return sanitizeShortName(extractTextBlocks(message.content), fallback);
  } catch (_) {
    return fallback;
  }
}

async function enrichCellsWithShortNames(cells, options = {}) {
  const targetCells = cells.filter((cell) => isSignalClusterLabel(cell.label));
  for (const cell of cells) {
    cell.shortName = cell.label;
  }
  if (targetCells.length === 0) {
    return cells;
  }

  const concurrency = Math.max(
    1,
    Math.min(5, Number.isFinite(options.shortNameConcurrency) ? options.shortNameConcurrency : 5)
  );
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < targetCells.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const cell = targetCells[currentIndex];
      cell.shortName = await generateShortName(cell.label, options);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targetCells.length) }, () => worker())
  );

  return cells;
}

function normalizeGapPacket(entry) {
  const domains = Array.isArray(entry.domains) && entry.domains.length > 0
    ? entry.domains.filter(Boolean)
    : [entry.domainId || entry.domain || 'ai-general'].filter(Boolean);
  const cells = Array.isArray(entry.cells) ? entry.cells.filter(Boolean) : [];
  return {
    gapId: entry.gapId || entry.packetId || entry.libraryId || `gap-${crypto.randomBytes(4).toString('hex')}`,
    fingerprint: entry.fingerprint || entry.libraryId || entry.gapId || '',
    label: String(entry.title || entry.hypothesis || 'Untitled gap').trim(),
    title: String(entry.title || entry.hypothesis || 'Untitled gap').trim(),
    hypothesis: String(entry.hypothesis || entry.title || '').trim(),
    score: clamp01(entry.score != null ? entry.score : (entry.metadata && entry.metadata.scores && entry.metadata.scores.total)),
    domain: String(entry.domainId || entry.domain || domains[0] || 'ai-general'),
    domains: Array.from(new Set(domains)),
    cells,
    paperCount: Number(entry.paperCount || (Array.isArray(entry.papers) ? entry.papers.length : 0)),
    papers: Array.isArray(entry.papers) ? entry.papers.slice(0, 10) : [],
    runCount: Number(entry.runCount || 1),
    scoreHistory: Array.isArray(entry.scoreHistory) ? entry.scoreHistory.slice() : []
  };
}

function loadRealGaps(gapLibraryPath) {
  const lines = safeReadJsonl(gapLibraryPath);
  const latestByFingerprint = new Map();

  for (const line of lines) {
    const normalized = normalizeGapPacket(line);
    const key = normalized.fingerprint || normalized.gapId || normalized.title;
    latestByFingerprint.set(key, normalized);
  }

  return Array.from(latestByFingerprint.values())
    .sort((left, right) => (right.score || 0) - (left.score || 0) || left.title.localeCompare(right.title));
}

function overlapRatio(valuesA, valuesB) {
  const setA = new Set((valuesA || []).filter(Boolean));
  const setB = new Set((valuesB || []).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const value of setA) {
    if (setB.has(value)) shared += 1;
  }
  return shared / Math.max(setA.size, setB.size);
}

function semanticSimilarity(a, b) {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }
  return shared / new Set([...wordsA, ...wordsB]).size;
}

function looksLikeGithubRepo(paper) {
  const url = String((paper && paper.url) || '').toLowerCase();
  const title = String((paper && paper.title) || '').toLowerCase();
  return url.includes('github.com')
    || /\b(repo|repository|sdk|toolkit|framework|library|plugin|package|copilot)\b/.test(title);
}

function looksCommercial(paper) {
  const url = String((paper && paper.url) || '').toLowerCase();
  const title = String((paper && paper.title) || '').toLowerCase();
  return /\b(platform|product|enterprise|commercial|startup|market|industry|deployment|service)\b/.test(title)
    || url.includes('springer')
    || url.includes('ieeexplore')
    || url.includes('acm.org');
}

function buildOpportunityTarget(cell, cells, realGaps) {
  if (cell.type === 'gap-packet') {
    const direct = realGaps.find((gap) =>
      (cell.fingerprint && gap.fingerprint === cell.fingerprint)
      || (cell.gapId && gap.gapId === cell.gapId)
    );
    if (direct) return direct;
  }

  const neighboringGaps = neighborsFor(cell, cells)
    .filter((neighbor) => neighbor.type === 'gap-packet')
    .map((neighbor) => realGaps.find((gap) =>
      (neighbor.fingerprint && gap.fingerprint === neighbor.fingerprint)
      || (neighbor.gapId && gap.gapId === neighbor.gapId)
    ))
    .filter(Boolean);

  if (neighboringGaps.length === 0) {
    return {
      label: cell.label,
      hypothesis: cell.hypothesis || '',
      score: clamp01(cell.score),
      domains: cell.domains || [cell.domain],
      cells: [cell.positionKey],
      paperCount: 0,
      papers: [],
      runCount: 1,
      scoreHistory: []
    };
  }

  return {
    label: cell.label,
    hypothesis: neighboringGaps.map((gap) => gap.hypothesis || gap.title || '').join(' '),
    score: round(neighboringGaps.reduce((sum, gap) => sum + (gap.score || 0), 0) / neighboringGaps.length),
    domains: Array.from(new Set(neighboringGaps.flatMap((gap) => gap.domains || []))),
    cells: Array.from(new Set(neighboringGaps.flatMap((gap) => gap.cells || []))),
    paperCount: neighboringGaps.reduce((sum, gap) => sum + Number(gap.paperCount || 0), 0),
    papers: neighboringGaps.flatMap((gap) => gap.papers || []).slice(0, 12),
    runCount: Math.max(...neighboringGaps.map((gap) => Number(gap.runCount || 1)), 1),
    scoreHistory: neighboringGaps.flatMap((gap) => gap.scoreHistory || [])
  };
}

function estimateSolutionOverlap(target, realGaps) {
  const relatedGaps = realGaps.filter((gap) => {
    if (gap.fingerprint === target.fingerprint || gap.gapId === target.gapId) return false;
    const cellOverlap = overlapRatio(target.cells, gap.cells);
    const domainOverlap = overlapRatio(target.domains, gap.domains);
    const semanticOverlap = semanticSimilarity(target.hypothesis || target.label, gap.hypothesis || gap.label);
    return cellOverlap >= 0.5 || (domainOverlap >= 0.5 && semanticOverlap >= 0.28);
  });

  const githubSignals = (target.papers || []).filter(looksLikeGithubRepo).length;
  const commercialSignals = (target.papers || []).filter(looksCommercial).length;
  const gapSignal = Math.min(1, relatedGaps.length / 5);
  const repoSignal = Math.min(1, githubSignals / 3);
  const commercialSignal = Math.min(1, commercialSignals / 3);

  return clamp01(round(gapSignal * 0.5 + repoSignal * 0.25 + commercialSignal * 0.25));
}

function estimateTechnologyReadiness(target, solutionOverlap) {
  const paperSignal = Math.min(1, Number(target.paperCount || 0) / 6);
  const domainSignal = Math.min(1, (target.domains || []).length / 4);
  const componentSignal = Math.min(1, (target.cells || []).length / 2);
  return clamp01(round(
    (paperSignal * 0.5 + domainSignal * 0.25 + componentSignal * 0.25) * (1 - solutionOverlap * 0.65)
  ));
}

function estimateDomainActivity(target) {
  const history = Array.isArray(target.scoreHistory) ? target.scoreHistory : [];
  const recentRuns = Math.min(1, history.length / 6);
  const paperSignal = Math.min(1, Number(target.paperCount || 0) / 6);
  const breadthSignal = Math.min(1, (target.domains || []).length / 4);
  return clamp01(round(paperSignal * 0.45 + recentRuns * 0.35 + breadthSignal * 0.20));
}

function opportunityLabelFor(score) {
  if (score > 0.7) return 'Vroeg stadium';
  if (score >= 0.4) return 'Opkomend';
  return 'Verzadigd';
}

function enrichCellsWithOpportunity(cells, realGaps) {
  for (const cell of cells) {
    const target = buildOpportunityTarget(cell, cells, realGaps);
    const solutionOverlap = estimateSolutionOverlap(target, realGaps);
    const openFieldScore = 1 - solutionOverlap;
    const domainActivity = estimateDomainActivity(target);
    const technologyReadiness = estimateTechnologyReadiness(target, solutionOverlap);
    const opportunityScore = clamp01(round(
      clamp01(target.score || cell.score || 0) * 0.4 +
      domainActivity * 0.3 +
      openFieldScore * 0.2 +
      technologyReadiness * 0.1
    ));

    cell.opportunityScore = opportunityScore;
    cell.opportunityLabel = opportunityLabelFor(opportunityScore);
    cell.opportunity_score = opportunityScore;
    cell.opportunity_label = cell.opportunityLabel;
  }

  return cells;
}

function buildCoordinates() {
  const coords = [];
  let index = 0;
  for (let z = 0; z < 3; z += 1) {
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        coords.push({
          index,
          x,
          y,
          z,
          layer: LAYER_LABELS[z],
          positionKey: `${LAYER_LABELS[z]}-${y}-${x}`
        });
        index += 1;
      }
    }
  }
  return coords;
}

function buildCubeCells(items, random) {
  return placeCellsWithLayerConstraint(items, random);
}

function neighborsFor(cell, cells) {
  return cells.filter((candidate) => {
    const distance = Math.abs(candidate.x - cell.x) + Math.abs(candidate.y - cell.y) + Math.abs(candidate.z - cell.z);
    return distance === 1;
  });
}

function uniqueDomains(cells) {
  return Array.from(new Set(
    cells
      .flatMap((cell) => Array.isArray(cell.domains) && cell.domains.length > 0 ? cell.domains : [cell.domain])
      .filter((domain) => domain && domain !== 'concept' && domain !== 'cross-domain')
  ));
}

function averageGapScore(cells) {
  const real = cells.filter((cell) => cell.type === 'gap-packet');
  if (real.length === 0) return 0.35;
  return round(real.reduce((sum, cell) => sum + (cell.score || 0), 0) / real.length);
}

function computeDomainDistance(domains) {
  if (domains.length <= 1) return 0;
  return round((domains.length - 1) / 4);
}

function computeNovelty(center, neighbors, domains) {
  const conceptCount = neighbors.filter((cell) => cell.type === 'concept').length;
  const aanhaakpuntCount = neighbors.filter((cell) => cell.type === 'aanhaakpunt').length;
  const bridgeCount = conceptCount + aanhaakpuntCount;
  const uniqueLabels = new Set([center, ...neighbors].map((cell) => cell.label.toLowerCase())).size;
  return clamp01(round(
    (bridgeCount / Math.max(1, neighbors.length)) * 0.45 +
    (domains.length / 5) * 0.35 +
    (uniqueLabels / Math.max(1, neighbors.length + 1)) * 0.20
  ));
}

function computeEntropy(cells) {
  const scores = cells.map((cell) => Number(cell.score || 0));
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + ((score - mean) ** 2), 0) / scores.length;
  const typeMix = new Set(cells.map((cell) => cell.type)).size > 1 ? 0.2 : 0;
  return clamp01(round(Math.min(1, Math.sqrt(variance) * 2 + typeMix)));
}

function classifyConstellation(center, neighbors, domains, score) {
  const conceptNeighbors = neighbors.filter((cell) => cell.type === 'concept').length;
  const realNeighbors = neighbors.filter((cell) => cell.type === 'gap-packet').length;
  const aanhaakpuntNeighbors = neighbors.filter((cell) => cell.type === 'aanhaakpunt').length;
  const hasAanhaakpunt = center.type === 'aanhaakpunt' || aanhaakpuntNeighbors > 0;

  if (center.type === 'gap-packet' && (conceptNeighbors > 0 || (aanhaakpuntNeighbors > 0 && conceptNeighbors === 0))) {
    return 'serendipiteit';
  }
  if (domains.length >= 2 && score >= 0.72) {
    return 'cross_domein_botsing';
  }
  if (domains.length >= 3 && realNeighbors >= 2) {
    return 'herhalende_structuur';
  }
  if (domains.length >= 2 && hasAanhaakpunt) {
    return 'verborgen_verbinding';
  }
  if (domains.length >= 2 && conceptNeighbors > 0) {
    return 'gemiste_innovatie';
  }
  if (domains.length >= 2) {
    return 'verborgen_verbinding';
  }
  return 'herhalende_structuur';
}

function domainLabel(domainId) {
  const labels = {
    'ai-governance': 'AI Governance',
    'ai-safety': 'AI Safety',
    'healthcare-ai': 'Healthcare AI',
    'legal-ai': 'Legal AI',
    'climate-ai': 'Climate AI',
    'education-ai': 'Education AI',
    'finance-ai': 'Finance AI'
  };
  return labels[domainId] || domainId || 'this domain';
}

function findAanhaakpuntInConstellation(center, neighbors) {
  if (center.type === 'aanhaakpunt') return center;
  return neighbors.find((cell) => cell.type === 'aanhaakpunt') || null;
}

function findGapLabelsInConstellation(center, neighbors) {
  const members = [center, ...neighbors];
  return members
    .filter((cell) => cell.type === 'gap-packet')
    .map((cell) => cell.label)
    .slice(0, 2);
}

function hypothesisForConstellation(center, neighbors, domains) {
  const aanhaakpunt = findAanhaakpuntInConstellation(center, neighbors);
  const gapLabels = findGapLabelsInConstellation(center, neighbors);
  const neighborLabels = neighbors.map((cell) => cell.label);
  const representative = neighborLabels.slice(0, 3);
  while (representative.length < 3) {
    representative.push(representative[representative.length - 1] || center.label);
  }

  // With cross-domain aanhaakpunt
  if (aanhaakpunt && domains.length >= 2 && aanhaakpunt.aanhaakpunt && aanhaakpunt.aanhaakpunt.soort === 'cross_domain') {
    const domA = domainLabel(domains[0]);
    const domB = domainLabel(domains[1]);
    const woord = aanhaakpunt.label;
    const gapA = gapLabels[0] || representative[0];
    const gapB = gapLabels[1] || representative[1];
    return `${domA} en ${domB} delen een onbenoemd probleem rond ${woord}. Het verband wordt zichtbaar wanneer ${gapA} en ${gapB} naast elkaar worden gelegd via de lens van ${woord}.`;
  }

  // With domain-specific aanhaakpunt
  if (aanhaakpunt && domains.length >= 1) {
    const domA = domainLabel(domains[0]);
    const woord = aanhaakpunt.label;
    const gapA = gapLabels[0] || representative[0];
    const gapB = gapLabels[1] || representative[1] || representative[0];
    if (domains.length === 1) {
      return `Binnen ${domA} raakt ${woord} aan zowel ${gapA} als ${gapB}. Dit suggereert een structureel probleem dat verder reikt dan de individuele gaps.`;
    }
    const domB = domainLabel(domains[1]);
    return `${domA} en ${domB} delen een onbenoemd probleem rond ${woord}. Het verband wordt zichtbaar wanneer ${gapA} en ${gapB} naast elkaar worden gelegd via de lens van ${woord}.`;
  }

  // Gap + concept serendipity
  if (center.type === 'gap-packet' && neighbors.some((cell) => cell.type === 'concept')) {
    const concept = neighbors.find((cell) => cell.type === 'concept');
    return `The gap ${center.label} may connect unexpectedly to ${concept.label}, opening a research direction no one has named yet.`;
  }

  // Fallback without aanhaakpunt
  if (domains.length <= 1) {
    const domain = domainLabel(domains[0] || center.domain);
    return `Within ${domain}, combining ${representative[0]}, ${representative[1]} and ${representative[2]} may reveal a missing control surface that can be tested against real evidence.`;
  }

  const domA = domainLabel(domains[0]);
  const domB = domainLabel(domains[1]);
  return `${domA} en ${domB} vertonen vergelijkbare patronen. Formele vergelijking kan een gedeeld tekort aan het licht brengen.`;
}

function explanationForConstellation(center, neighbors, domains, score) {
  const neighborLabels = neighbors.map((cell) => cell.label).slice(0, 4);
  return [
    `${center.label} sits at the center of a ${domains.length > 1 ? 'cross-domain' : 'deep-domain'} cluster.`,
    `Its nearest face neighbors are ${neighborLabels.join(', ')}.`,
    `The scored promise of this constellation is ${score.toFixed(3)} based on domain distance, novelty, entropy, and the underlying gap scores.`
  ].join(' ');
}

function computeAanhaakpuntBridge(center, neighbors) {
  const members = [center, ...neighbors];
  const aanhaakpuntCells = members.filter((cell) => cell.type === 'aanhaakpunt');
  if (aanhaakpuntCells.length === 0) return 0;
  const aanhaakpunten = aanhaakpuntCells
    .map((cell) => cell.aanhaakpunt || { gewicht: cell.score || 0.5 })
    .filter(Boolean);
  return computeAanhaakpuntBridgeScore(aanhaakpunten);
}

function scoreConstellation(center, neighbors, domains) {
  const members = [center, ...neighbors];
  const avgGapScore = averageGapScore(members);
  const domainDistance = computeDomainDistance(domains);
  const crossDomainBonus = domains.length >= 2 ? 1 : 0;
  const novelty = computeNovelty(center, neighbors, domains);
  const entropy = computeEntropy(members);
  const aanhaakpuntBridge = computeAanhaakpuntBridge(center, neighbors);
  const score = clamp01(round(
    avgGapScore * 0.35 +
    domainDistance * 0.30 +
    crossDomainBonus * 0.20 +
    aanhaakpuntBridge * 0.15
  ));

  return {
    score,
    scoreBreakdown: {
      avg_gap_score: round(avgGapScore),
      domain_distance: round(domainDistance),
      cross_domain_bonus: round(crossDomainBonus),
      novelty: round(novelty),
      entropy: round(entropy),
      aanhaakpunt_bridge: round(aanhaakpuntBridge)
    }
  };
}

function buildConstellation(center, cells) {
  const neighbors = neighborsFor(center, cells);
  const domains = uniqueDomains([center, ...neighbors]);
  const { score, scoreBreakdown } = scoreConstellation(center, neighbors, domains);
  const type = classifyConstellation(center, neighbors, domains, score);
  const hypothesis = hypothesisForConstellation(center, neighbors, domains);
  const explanation = explanationForConstellation(center, neighbors, domains, score);
  const fingerprintSource = [
    center.label,
    neighbors.map((cell) => cell.label).sort().join('|'),
    domains.sort().join('|'),
    type
  ].join('|');

  return {
    constellationId: crypto.createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 16),
    centerCell: center.index,
    centerLabel: center.label,
    centerType: center.type,
    centerDomain: center.domain,
    centerGapId: center.gapId,
    neighborCells: neighbors.map((cell) => cell.index),
    neighborLabels: neighbors.map((cell) => cell.label),
    cells: [center.positionKey, ...neighbors.map((cell) => cell.positionKey)],
    domains,
    hypothesis,
    explanation,
    type,
    score,
    scoreBreakdown,
    sourceGapIds: [center, ...neighbors].map((cell) => cell.gapId).filter(Boolean)
  };
}

function buildFallbackItems(count) {
  return FALLBACK_CONCEPTS.slice(0, count).map((concept, index) => ({
    label: concept,
    title: concept,
    hypothesis: null,
    score: 0.35 + (index % 5) * 0.03,
    domain: 'concept',
    domains: ['concept'],
    type: 'concept',
    source: 'fallback'
  }));
}

function buildItems(realGaps, aanhaakpuntItems, random) {
  // Priority: 1. Real gaps (max 18), 2. Aanhaakpunten (max 6), 3. Fallback concepts (rest)
  const maxGaps = Math.min(18, realGaps.length);
  const gapItems = realGaps.slice(0, maxGaps);
  const maxAanhaakpunten = Math.min(6, 27 - gapItems.length, aanhaakpuntItems.length);
  const selectedAanhaakpunten = aanhaakpuntItems.slice(0, maxAanhaakpunten);
  const fallbackCount = 27 - gapItems.length - selectedAanhaakpunten.length;
  const fallbackItems = buildFallbackItems(fallbackCount);

  // Ensure at least 1 cross-domain aanhaakpunt per layer (3 layers)
  // by placing them with a layer-aware strategy after initial assembly
  const items = [...gapItems, ...selectedAanhaakpunten, ...fallbackItems];
  return items.slice(0, 27);
}

function placeCellsWithLayerConstraint(items, random) {
  const coordinates = buildCoordinates();

  // Separate aanhaakpunt items and the rest
  const aanhaakpuntIndices = [];
  const otherIndices = [];
  items.forEach((item, index) => {
    if (item.type === 'aanhaakpunt') aanhaakpuntIndices.push(index);
    else otherIndices.push(index);
  });

  // Cross-domain aanhaakpunten get priority placement: one per layer
  const crossDomain = aanhaakpuntIndices.filter((i) =>
    items[i].aanhaakpunt && items[i].aanhaakpunt.soort === 'cross_domain'
  );
  const domainSpecific = aanhaakpuntIndices.filter((i) =>
    !items[i].aanhaakpunt || items[i].aanhaakpunt.soort !== 'cross_domain'
  );

  // Group coordinates by layer
  const coordsByLayer = [[], [], []];
  for (const coord of coordinates) {
    coordsByLayer[coord.z].push(coord);
  }
  // Shuffle each layer
  for (let z = 0; z < 3; z += 1) {
    coordsByLayer[z] = shuffle(coordsByLayer[z], random);
  }

  const assigned = new Array(27);
  const usedCoords = new Set();

  // Place one cross-domain aanhaakpunt per layer (if available)
  const usedWords = [new Set(), new Set(), new Set()];
  for (let z = 0; z < 3; z += 1) {
    if (crossDomain.length === 0) break;
    // Find a cross-domain aanhaakpunt not yet used in this layer
    let placed = false;
    for (let ci = 0; ci < crossDomain.length; ci += 1) {
      const itemIdx = crossDomain[ci];
      const woord = items[itemIdx].label.toLowerCase();
      if (usedWords[z].has(woord)) continue;
      const coord = coordsByLayer[z].find((c) => !usedCoords.has(c.index));
      if (!coord) break;
      usedCoords.add(coord.index);
      usedWords[z].add(woord);
      assigned[coord.index] = assignCell(coord, items[itemIdx]);
      crossDomain.splice(ci, 1);
      placed = true;
      break;
    }
    if (!placed && crossDomain.length > 0) {
      // fallback: place any available cross-domain one
      const itemIdx = crossDomain.shift();
      const coord = coordsByLayer[z].find((c) => !usedCoords.has(c.index));
      if (coord) {
        usedCoords.add(coord.index);
        usedWords[z].add(items[itemIdx].label.toLowerCase());
        assigned[coord.index] = assignCell(coord, items[itemIdx]);
      }
    }
  }

  // Place remaining aanhaakpunten (cross-domain leftovers + domain-specific)
  const remainingAP = [...crossDomain, ...domainSpecific];
  for (const itemIdx of remainingAP) {
    const woord = items[itemIdx].label.toLowerCase();
    // Find a layer where this word is not yet placed
    let placed = false;
    for (let z = 0; z < 3; z += 1) {
      if (usedWords[z].has(woord)) continue;
      const coord = coordsByLayer[z].find((c) => !usedCoords.has(c.index));
      if (!coord) continue;
      usedCoords.add(coord.index);
      usedWords[z].add(woord);
      assigned[coord.index] = assignCell(coord, items[itemIdx]);
      placed = true;
      break;
    }
    if (!placed) {
      // Last resort: any available cell
      for (let z = 0; z < 3; z += 1) {
        const coord = coordsByLayer[z].find((c) => !usedCoords.has(c.index));
        if (coord) {
          usedCoords.add(coord.index);
          assigned[coord.index] = assignCell(coord, items[itemIdx]);
          break;
        }
      }
    }
  }

  // Place remaining items (gaps + fallbacks) in remaining cells
  const remainingCoords = [];
  for (let z = 0; z < 3; z += 1) {
    for (const coord of coordsByLayer[z]) {
      if (!usedCoords.has(coord.index)) remainingCoords.push(coord);
    }
  }
  const shuffledRemaining = shuffle(remainingCoords, random);
  let coordPointer = 0;
  for (const itemIdx of otherIndices) {
    if (coordPointer >= shuffledRemaining.length) break;
    const coord = shuffledRemaining[coordPointer];
    coordPointer += 1;
    assigned[coord.index] = assignCell(coord, items[itemIdx]);
  }

  return assigned;
}

function assignCell(position, item) {
  return {
    index: position.index,
    x: position.x,
    y: position.y,
    z: position.z,
    layer: position.layer,
    row: position.y,
    column: position.x,
    positionKey: position.positionKey,
    label: item.label,
    shortName: item.shortName || item.label,
    domain: item.domain,
    domains: item.domains ? item.domains.slice() : [item.domain],
    score: clamp01(item.score),
    type: item.type,
    gapId: item.gapId || null,
    fingerprint: item.fingerprint || null,
    hypothesis: item.hypothesis || null,
    source: item.source,
    aanhaakpunt: item.aanhaakpunt || null
  };
}

async function runBelofteCube(options = {}) {
  const gapLibraryPath = options.gapLibraryPath || DEFAULT_GAP_LIBRARY_PATH;
  const maxRealGaps = Math.max(0, Math.min(27, Number.isFinite(options.maxRealGaps) ? options.maxRealGaps : 27));
  const timestamp = new Date().toISOString();
  const seed = options.seed || timestamp;
  const random = createSeededRandom(seed);

  const realGaps = loadRealGaps(gapLibraryPath)
    .slice(0, maxRealGaps)
    .map((gap) => ({
      ...gap,
      type: 'gap-packet',
      source: 'gap-library'
    }));

  // Load aanhaakpunten and select for cube
  const allAanhaakpunten = options.aanhaakpunten || loadAanhaakpunten(options.aanhaakpuntenConfig);
  const gapDomains = Array.from(new Set(realGaps.flatMap((gap) => gap.domains)));
  const selectedAP = selectAanhaakpuntenForCube(allAanhaakpunten, 6, gapDomains);
  const aanhaakpuntItems = selectedAP.map(aanhaakpuntToCubeItem);

  const items = buildItems(realGaps, aanhaakpuntItems, random);
  const cells = placeCellsWithLayerConstraint(items, random);
  await enrichCellsWithShortNames(cells, options);
  enrichCellsWithOpportunity(cells, realGaps);
  const constellations = cells
    .map((cell) => buildConstellation(cell, cells))
    .sort((left, right) => right.score - left.score || left.centerCell - right.centerCell);

  const topConstellations = constellations.slice(0, 10);
  const domainsRepresented = Array.from(new Set(realGaps.flatMap((gap) => gap.domains))).sort();
  const runId = `cube-${crypto.createHash('sha1').update(`${timestamp}|${seed}`).digest('hex').slice(0, 12)}`;
  const aanhaakpuntenUsed = items.filter((item) => item.type === 'aanhaakpunt').map((item) => item.label);
  const fallbackCount = items.filter((item) => item.type === 'concept').length;

  return {
    runId,
    timestamp,
    seed: String(seed),
    cells,
    topConstellations,
    aanhaakpunten: selectedAP,
    summary: {
      realGapsLoaded: realGaps.length,
      aanhaakpuntenUsed: aanhaakpuntenUsed.length,
      aanhaakpuntenLabels: aanhaakpuntenUsed,
      fallbackConceptsUsed: fallbackCount,
      domainsRepresented,
      topScore: topConstellations[0] ? topConstellations[0].score : 0,
      topHypothesis: topConstellations[0] ? topConstellations[0].hypothesis : ''
    }
  };
}

export {
  FALLBACK_CONCEPTS,
  buildItems,
  runBelofteCube
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runBelofteCube();
  console.log(JSON.stringify(result, null, 2));

  const outputPath = process.env.CLASHD27_BIEB_LATEST_PATH
    || resolvePromiseLibraryLayout().latestCubeFile;
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`Bieb geschreven naar: ${outputPath}`);
}
