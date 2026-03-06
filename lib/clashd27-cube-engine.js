const fs = require('fs');
const path = require('path');
const { mapToCubeCell: mapParityToCubeCell } = require('./mapping-parity');

const AXIS_WHAT = ['trust-model', 'surface', 'architecture'];
const AXIS_WHERE = ['internal', 'external', 'engine'];
const AXIS_TIME = ['historical', 'current', 'emerging'];

const WHAT_KEYWORDS = {
  'trust-model': ['consent', 'trust', 'permission'],
  surface: ['channel', 'api', 'ui', 'mcp'],
  architecture: ['kernel', 'audit', 'policy']
};

const DECAY_PER_TICK = 0.995;
const GRAVITY_FACTOR = 0.02;
const SPILLOVER_FACTOR = 0.08;
const FAR_APART_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SIGNAL_LOG = 800;
const MAX_EVENT_LOG = 256;
const MAX_EMERGENCE_EVENTS = 400;
const MAX_MOMENTUM_LOG = 54;

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function round(num, decimals = 6) {
  const f = 10 ** decimals;
  return Math.round(num * f) / f;
}

function hash32(input) {
  const str = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function entropySeedFromSignalId(signalId) {
  const h = hash32(String(signalId || ''));
  return round(0.9 + ((h % 1000) / 1000), 6);
}

function coordsToCell(a, b, c) {
  return (c * 9) + (b * 3) + a;
}

function cellToCoords(cellId) {
  const id = Number(cellId);
  const a = id % 3;
  const b = Math.floor(id / 3) % 3;
  const c = Math.floor(id / 9);
  return { a, b, c };
}

function manhattanDistance(cellA, cellB) {
  const a = cellToCoords(cellA);
  const b = cellToCoords(cellB);
  return Math.abs(a.a - b.a) + Math.abs(a.b - b.b) + Math.abs(a.c - b.c);
}

function cellAxes(cellId) {
  const { a, b, c } = cellToCoords(cellId);
  return {
    what: AXIS_WHAT[a],
    where: AXIS_WHERE[b],
    time: AXIS_TIME[c]
  };
}

function heatChar(score) {
  if (score < 0.2) return '·';
  if (score < 0.4) return '░';
  if (score < 0.6) return '▒';
  if (score < 0.8) return '▓';
  return '█';
}

function createEmptyCell(cellId) {
  const axes = cellAxes(cellId);
  return {
    cellId,
    axes,
    score: 0,
    events: 0,
    uniqueSources: [],
    uniqueSourceTypes: [],
    ticks: [],
    entropySeeds: [],
    lastTick: null,
    lastSignalTs: null,
    interactionCount: 0,
    peerDiversity: 0,
    timeSpread: 0,
    entropySeed: 0,
    formulaResidue: 0,
    momentum: 0,
    momentumHistory: [],
    gravityMass: 0
  };
}

function emptyState() {
  const cells = {};
  for (let i = 0; i < 27; i += 1) {
    cells[String(i)] = createEmptyCell(i);
  }
  return {
    version: 1,
    clock: 0,
    updatedAt: null,
    cells,
    signals: [],
    collisions: [],
    emergenceEvents: []
  };
}

function sourceTypeFromSource(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('github') || s.includes('competitor')) return 'github-competitor';
  if (s.includes('paper') || s.includes('theory') || s.includes('scientific')) return 'paper-theory';
  if (s.includes('skill')) return 'agent-skill';
  return 'internal-system';
}

function normalizeSourceForParity(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('github') || s.includes('competitor')) return 'competitors';
  if (s.includes('openclaw')) return 'openclaw';
  if (s.includes('paper') || s.includes('theory') || s.includes('scientific')) return 'knowledge_openalex';
  if (s.includes('openclaw-skill')) return 'openclaw-skills';
  if (s.includes('skill')) return 'internal';
  if (s.includes('commonphone')) return 'commonphone-traffic';
  if (s.includes('burnerphone')) return 'burnerphone-traffic';
  if (s.includes('lobby')) return 'lobby-proposals';
  if (s.includes('internal')) return 'internal';
  return 'internal';
}

function deterministicFallbackIndex(seed, size) {
  return hash32(seed) % size;
}

function mapWhatAxis(keywords, identitySeed) {
  const words = (keywords || []).map(k => String(k).toLowerCase());
  const scores = {
    'trust-model': 0,
    surface: 0,
    architecture: 0
  };

  for (const word of words) {
    for (const axis of Object.keys(WHAT_KEYWORDS)) {
      const rules = WHAT_KEYWORDS[axis];
      if (rules.some(rule => word.includes(rule))) scores[axis] += 1;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return AXIS_WHAT.indexOf(a[0]) - AXIS_WHAT.indexOf(b[0]);
  });
  if (ranked[0][1] > 0) return ranked[0][0];
  return AXIS_WHAT[deterministicFallbackIndex(identitySeed, AXIS_WHAT.length)];
}

function mapWhereAxis(source) {
  const s = String(source || '').toLowerCase();
  if (s.includes('github') || s.includes('competitor')) return 'external';
  if (s.includes('paper') || s.includes('theory') || s.includes('scientific')) return 'engine';
  return 'internal';
}

function mapTimeAxis(timestamp, keywords, referenceTime) {
  const words = (keywords || []).map(k => String(k).toLowerCase());
  if (words.some(w => w.includes('gap') || w.includes('trend') || w.includes('anomaly'))) {
    return 'emerging';
  }

  const ts = new Date(timestamp).getTime();
  if (!Number.isFinite(ts)) return 'current';

  const ref = new Date(referenceTime || Date.now()).getTime();
  const ageDays = Math.floor((ref - ts) / (24 * 60 * 60 * 1000));

  if (ageDays > 30) return 'historical';
  if (ageDays >= 1 && ageDays <= 30) return 'current';
  return 'current';
}

function normalizeSignal(rawSignal, opts = {}) {
  const signal = rawSignal || {};
  const id = String(signal.id || '');
  const source = String(signal.source || 'internal system');
  const timestamp = signal.timestamp || new Date(0).toISOString();
  const keywords = Array.isArray(signal.keywords)
    ? signal.keywords.map(k => String(k).toLowerCase()).filter(Boolean)
    : [];

  const mapped = mapParityToCubeCell({
    text: keywords.join(' '),
    source: normalizeSourceForParity(source),
    timestampIso: timestamp,
    category: String(signal.category || signal.key || ''),
    publishedAtIso: signal.publishedAtIso || null
  });
  const [what, where, time] = mapped.cubeCell;
  const cellId = mapped.cellIndex;

  return {
    id,
    source,
    sourceType: sourceTypeFromSource(source),
    timestamp: new Date(timestamp).toISOString(),
    keywords,
    trustLevel: signal.trustLevel || null,
    surfaceType: signal.surfaceType || null,
    architectureAspect: signal.architectureAspect || null,
    what,
    where,
    time,
    cellId,
    isGapSignal: keywords.some(k => k.includes('gap')),
    entropySeed: entropySeedFromSignalId(id)
  };
}

function unionSorted(numsA, numsB) {
  const set = new Set([...(numsA || []), ...(numsB || [])]);
  return [...set].sort((a, b) => a - b);
}

class Clashd27CubeEngine {
  constructor(opts = {}) {
    this.stateFile = opts.stateFile || path.join(__dirname, '..', 'data', 'clashd27-cube-state.json');
    this.emergenceThreshold = Number.isFinite(opts.emergenceThreshold)
      ? opts.emergenceThreshold
      : 0.72;
    this.state = emptyState();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        this.state = { ...emptyState(), ...raw };
        for (let i = 0; i < 27; i += 1) {
          const key = String(i);
          this.state.cells[key] = {
            ...createEmptyCell(i),
            ...(raw.cells && raw.cells[key] ? raw.cells[key] : {})
          };
        }
      }
    } catch (err) {
      this.state = emptyState();
    }
  }

  save() {
    const dir = path.dirname(this.stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  getState() {
    return this.state;
  }

  updateResidue(tick, opts = {}) {
    const targetTick = Number.isFinite(tick) ? tick : this.state.clock;
    const previousTick = this.state.clock || 0;
    const dt = Math.max(0, targetTick - previousTick);
    if (dt > 0) {
      // Snapshot scores before updates for momentum calculation
      const prevScores = {};
      for (let i = 0; i < 27; i += 1) {
        prevScores[i] = this.state.cells[String(i)].score;
      }

      // Phase 1: decay
      const decayFactor = Math.pow(DECAY_PER_TICK, dt);
      for (let i = 0; i < 27; i += 1) {
        const cell = this.state.cells[String(i)];
        cell.score = round(cell.score * decayFactor, 6);
      }

      // Phase 2: gravity — high-score cells pull from lower-score face neighbors
      this._applyGravity();

      // Phase 3: momentum — track velocity of score changes
      for (let i = 0; i < 27; i += 1) {
        const cell = this.state.cells[String(i)];
        const velocity = round(cell.score - prevScores[i], 6);
        cell.momentum = velocity;
        cell.momentumHistory.push({ tick: targetTick, v: velocity });
        if (cell.momentumHistory.length > MAX_MOMENTUM_LOG) {
          cell.momentumHistory = cell.momentumHistory.slice(-MAX_MOMENTUM_LOG);
        }
        cell.gravityMass = round(cell.score * (1 + Math.abs(velocity)), 6);
      }

      this.state.clock = targetTick;
    }
    this.state.updatedAt = new Date().toISOString();
    if (opts.persist !== false) this.save();
    return this.state.clock;
  }

  _applyGravity() {
    // Gravity wells: high-score cells pull a fraction of score differential
    // from lower-score face neighbors. Net effect: hot regions get hotter,
    // cold regions drain faster — creating semantic "gravity wells".
    const deltas = new Float64Array(27);
    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      if (cell.score <= 0) continue;
      const neighbors = this._neighborsByManhattan(i);
      for (const nId of neighbors) {
        const neighbor = this.state.cells[String(nId)];
        if (cell.score > neighbor.score) {
          // Pull: transfer fraction of the score gap from neighbor to cell
          const pull = (cell.score - neighbor.score) * GRAVITY_FACTOR;
          deltas[i] += pull;
          deltas[nId] -= pull;
        }
      }
    }
    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      cell.score = round(clamp(cell.score + deltas[i], 0, 1), 6);
    }
  }

  _applySpillover(primaryCellId, scoreDelta) {
    // When a signal hits a cell, a fraction spills to face-adjacent neighbors.
    // This creates natural "heat spread" in the semantic field.
    if (scoreDelta <= 0) return;
    const spillAmount = round(scoreDelta * SPILLOVER_FACTOR, 6);
    if (spillAmount < 0.001) return;
    const neighbors = this._neighborsByManhattan(primaryCellId);
    for (const nId of neighbors) {
      const neighbor = this.state.cells[String(nId)];
      neighbor.score = round(clamp(neighbor.score + spillAmount, 0, 1), 6);
    }
  }

  ingestSignal(rawSignal, opts = {}) {
    const tick = Number.isFinite(opts.tick) ? opts.tick : this.state.clock;
    if (tick > this.state.clock) this.updateResidue(tick, { persist: false });

    const signal = normalizeSignal(rawSignal, {
      referenceTime: opts.referenceTime || new Date().toISOString()
    });
    if (!signal.id) {
      throw new Error('Signal id is required');
    }

    const cell = this.state.cells[String(signal.cellId)];
    const eventTick = Number.isFinite(tick) ? tick : this.state.clock;
    const sourceChanged = cell.uniqueSourceTypes.length > 0 && !cell.uniqueSourceTypes.includes(signal.sourceType);
    const tsMs = new Date(signal.timestamp).getTime();
    const prevMs = cell.lastSignalTs ? new Date(cell.lastSignalTs).getTime() : null;
    const farApart = Number.isFinite(prevMs) && Number.isFinite(tsMs) && Math.abs(tsMs - prevMs) >= FAR_APART_MS;

    let scoreDelta = 0.3;
    if (sourceChanged) scoreDelta += 0.1;
    if (farApart) scoreDelta += 0.1;
    if (signal.isGapSignal) scoreDelta += 0.2;

    cell.score = round(clamp(cell.score + scoreDelta, 0, 1), 6);
    this._applySpillover(signal.cellId, scoreDelta);
    cell.events += 1;
    cell.interactionCount = cell.events;
    if (!cell.uniqueSources.includes(signal.source)) cell.uniqueSources.push(signal.source);
    if (!cell.uniqueSourceTypes.includes(signal.sourceType)) cell.uniqueSourceTypes.push(signal.sourceType);
    if (!cell.ticks.includes(eventTick)) cell.ticks.push(eventTick);
    cell.ticks.sort((a, b) => a - b);
    if (cell.ticks.length > MAX_EVENT_LOG) cell.ticks = cell.ticks.slice(-MAX_EVENT_LOG);
    cell.peerDiversity = cell.uniqueSources.length;
    cell.timeSpread = cell.ticks.length;
    cell.entropySeeds.push(signal.entropySeed);
    if (cell.entropySeeds.length > MAX_EVENT_LOG) cell.entropySeeds = cell.entropySeeds.slice(-MAX_EVENT_LOG);
    const entropyAvg = cell.entropySeeds.length > 0
      ? cell.entropySeeds.reduce((sum, v) => sum + v, 0) / cell.entropySeeds.length
      : 0;
    cell.entropySeed = round(entropyAvg, 6);
    cell.formulaResidue = round(cell.interactionCount * cell.peerDiversity * cell.timeSpread * cell.entropySeed, 6);
    cell.lastTick = eventTick;
    cell.lastSignalTs = signal.timestamp;

    this.state.signals.push({
      id: signal.id,
      source: signal.source,
      timestamp: signal.timestamp,
      cellId: signal.cellId,
      axes: { what: signal.what, where: signal.where, time: signal.time },
      tick: eventTick,
      scoreDelta: round(scoreDelta, 3)
    });
    if (this.state.signals.length > MAX_SIGNAL_LOG) this.state.signals = this.state.signals.slice(-MAX_SIGNAL_LOG);
    this.state.updatedAt = new Date().toISOString();

    if (opts.persist !== false) this.save();
    return {
      signal,
      cell: { ...cell },
      scoreDelta: round(scoreDelta, 3)
    };
  }

  detectCollisions(opts = {}) {
    const tick = Number.isFinite(opts.tick) ? opts.tick : this.state.clock;
    const meaningful = [];
    const emergenceEvents = [];
    const cells = [];

    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      if (cell.score > 0) cells.push(cell);
    }

    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i];
        const b = cells[j];
        const distance = manhattanDistance(a.cellId, b.cellId);
        if (distance > 1) continue;

        const sources = [...new Set([...(a.uniqueSources || []), ...(b.uniqueSources || [])])];
        const ticks = unionSorted(a.ticks, b.ticks);
        const combinedScore = round(a.score + b.score, 3);
        if (sources.length < 2) continue;
        if (combinedScore <= 0.7) continue;
        if (ticks.length < 3) continue;

        const density = round(clamp((combinedScore / 2) * (distance === 0 ? 1 : 0.85), 0, 1), 3);
        const sourceFactor = clamp((sources.length - 1) / 3, 0, 1);
        const tickFactor = clamp(ticks.length / 6, 0, 1);
        const emergenceScore = round((0.5 * density) + (0.3 * sourceFactor) + (0.2 * tickFactor), 3);
        const id = `col-${a.cellId}-${b.cellId}-${hash32(`${sources.join('|')}:${ticks.join(',')}`)}`;

        const collision = {
          id,
          cells: [a.cellId, b.cellId],
          sources,
          ticks,
          density,
          combinedScore,
          emergenceScore
        };
        meaningful.push(collision);

        if (emergenceScore > this.emergenceThreshold) {
          emergenceEvents.push({
            id: `evt-${id}`,
            collisionId: id,
            tick,
            emergenceScore,
            cells: collision.cells,
            sources: collision.sources
          });
        }
      }
    }

    meaningful.sort((x, y) => (y.emergenceScore - x.emergenceScore) || (x.id < y.id ? -1 : 1));
    this.state.collisions = meaningful.slice(0, MAX_SIGNAL_LOG);

    const existing = new Set((this.state.emergenceEvents || []).map(e => e.id));
    for (const evt of emergenceEvents) {
      if (!existing.has(evt.id)) this.state.emergenceEvents.push(evt);
    }
    if (this.state.emergenceEvents.length > MAX_EMERGENCE_EVENTS) {
      this.state.emergenceEvents = this.state.emergenceEvents.slice(-MAX_EMERGENCE_EVENTS);
    }

    this.state.updatedAt = new Date().toISOString();
    if (opts.persist !== false) this.save();
    return meaningful;
  }

  _neighborsByManhattan(cellId) {
    const out = [];
    for (let i = 0; i < 27; i += 1) {
      if (i === cellId) continue;
      if (manhattanDistance(cellId, i) === 1) out.push(i);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  _findClusters(minScore = 0.6) {
    const active = new Set();
    for (let i = 0; i < 27; i += 1) {
      if (this.state.cells[String(i)].score >= minScore) active.add(i);
    }

    const visited = new Set();
    const clusters = [];

    for (const node of [...active].sort((a, b) => a - b)) {
      if (visited.has(node)) continue;
      const q = [node];
      const component = [];
      visited.add(node);
      while (q.length > 0) {
        const cur = q.shift();
        component.push(cur);
        for (const n of this._neighborsByManhattan(cur)) {
          if (!active.has(n) || visited.has(n)) continue;
          visited.add(n);
          q.push(n);
        }
      }
      component.sort((a, b) => a - b);
      const totalScore = round(component.reduce((sum, c) => sum + this.state.cells[String(c)].score, 0), 3);
      const strongestCell = component.slice().sort((a, b) => {
        const da = this.state.cells[String(a)].score;
        const db = this.state.cells[String(b)].score;
        if (da !== db) return db - da;
        return a - b;
      })[0];
      clusters.push({
        id: `cluster-${component.join('-')}`,
        cells: component,
        size: component.length,
        totalScore,
        strongestCell
      });
    }
    clusters.sort((a, b) => (b.totalScore - a.totalScore) || (b.size - a.size));
    return clusters;
  }

  _findGradients(minStep = 0.05, minLength = 3) {
    const candidates = [];
    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      if (cell.score <= 0.15) continue;
      candidates.push({ cellId: i, score: cell.score });
    }
    candidates.sort((a, b) => (a.score - b.score) || (a.cellId - b.cellId));

    const seenSignatures = new Set();
    const gradients = [];

    for (const start of candidates) {
      const path = [start.cellId];
      const scores = [start.score];
      const localVisited = new Set(path);
      let cursor = start.cellId;

      while (true) {
        const currentScore = this.state.cells[String(cursor)].score;
        const nextCandidates = this._neighborsByManhattan(cursor)
          .filter(n => !localVisited.has(n))
          .map(n => ({ cellId: n, score: this.state.cells[String(n)].score }))
          .filter(n => n.score >= currentScore + minStep)
          .sort((a, b) => (b.score - a.score) || (a.cellId - b.cellId));
        if (nextCandidates.length === 0) break;
        const next = nextCandidates[0];
        path.push(next.cellId);
        scores.push(next.score);
        localVisited.add(next.cellId);
        cursor = next.cellId;
      }

      if (path.length < minLength) continue;
      const signature = path.join('>');
      if (seenSignatures.has(signature)) continue;
      seenSignatures.add(signature);

      gradients.push({
        id: `gradient-${hash32(signature)}`,
        path,
        scores: scores.map(s => round(s, 3)),
        slope: round(scores[scores.length - 1] - scores[0], 3)
      });
    }

    gradients.sort((a, b) => (b.slope - a.slope) || (b.path.length - a.path.length));
    return gradients.slice(0, 20);
  }

  _bfsFarthest(componentSet, start) {
    const q = [start];
    const dist = new Map([[start, 0]]);
    const parent = new Map();
    while (q.length > 0) {
      const cur = q.shift();
      for (const n of this._neighborsByManhattan(cur)) {
        if (!componentSet.has(n) || dist.has(n)) continue;
        dist.set(n, dist.get(cur) + 1);
        parent.set(n, cur);
        q.push(n);
      }
    }
    let far = start;
    for (const [node, d] of dist.entries()) {
      if (d > dist.get(far)) far = node;
      else if (d === dist.get(far) && node < far) far = node;
    }
    return { far, dist, parent };
  }

  _reconstructPath(parent, start, end) {
    const path = [end];
    let cur = end;
    while (cur !== start) {
      cur = parent.get(cur);
      if (cur === undefined) break;
      path.push(cur);
    }
    return path.reverse();
  }

  _findCorridors(minScore = 0.35, minLength = 4) {
    const nodes = [];
    for (let i = 0; i < 27; i += 1) {
      if (this.state.cells[String(i)].score >= minScore) nodes.push(i);
    }
    const nodeSet = new Set(nodes);
    const visited = new Set();
    const corridors = [];

    for (const node of nodes.sort((a, b) => a - b)) {
      if (visited.has(node)) continue;
      const q = [node];
      const component = [];
      visited.add(node);
      while (q.length > 0) {
        const cur = q.shift();
        component.push(cur);
        for (const n of this._neighborsByManhattan(cur)) {
          if (!nodeSet.has(n) || visited.has(n)) continue;
          visited.add(n);
          q.push(n);
        }
      }
      if (component.length < minLength) continue;
      const compSet = new Set(component);
      const start = component.slice().sort((a, b) => a - b)[0];
      const first = this._bfsFarthest(compSet, start);
      const second = this._bfsFarthest(compSet, first.far);
      const path = this._reconstructPath(second.parent, first.far, second.far);
      if (path.length < minLength) continue;
      const strength = round(path.reduce((sum, c) => sum + this.state.cells[String(c)].score, 0) / path.length, 3);
      corridors.push({
        id: `corridor-${hash32(path.join('-'))}`,
        cells: component.sort((a, b) => a - b),
        path,
        length: path.length,
        strength
      });
    }
    corridors.sort((a, b) => (b.length - a.length) || (b.strength - a.strength));
    return corridors.slice(0, 20);
  }

  _buildHeatmap() {
    const layers = [];
    for (let z = 0; z < 3; z += 1) {
      const rows = [];
      for (let y = 2; y >= 0; y -= 1) {
        const row = [];
        for (let x = 0; x < 3; x += 1) {
          const cellId = coordsToCell(x, y, z);
          const cell = this.state.cells[String(cellId)];
          row.push({
            cellId,
            score: round(cell.score, 3),
            char: heatChar(cell.score),
            axes: cell.axes
          });
        }
        rows.push(row);
      }
      layers.push({ z, timeAxis: AXIS_TIME[z], rows });
    }
    return layers;
  }

  computeGravityField() {
    // Returns a snapshot of gravity wells — cells ranked by gravitational mass.
    // gravityMass = score * (1 + |momentum|). High mass = strong attractor.
    const wells = [];
    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      if (cell.gravityMass <= 0) continue;
      const neighbors = this._neighborsByManhattan(i);
      const neighborScores = neighbors.map(n => this.state.cells[String(n)].score);
      const avgNeighborScore = neighborScores.length > 0
        ? round(neighborScores.reduce((s, v) => s + v, 0) / neighborScores.length, 3)
        : 0;
      wells.push({
        cellId: i,
        axes: cell.axes,
        score: round(cell.score, 3),
        momentum: round(cell.momentum, 6),
        gravityMass: round(cell.gravityMass, 3),
        avgNeighborScore,
        pullStrength: round(Math.max(0, cell.score - avgNeighborScore) * GRAVITY_FACTOR * neighbors.length, 6)
      });
    }
    wells.sort((a, b) => (b.gravityMass - a.gravityMass) || (a.cellId - b.cellId));
    return wells;
  }

  computeMomentumSnapshot() {
    // Returns cells sorted by absolute momentum — fastest movers (heating or cooling).
    const movers = [];
    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      const absMomentum = Math.abs(cell.momentum);
      if (absMomentum < 1e-9) continue;
      const trend = cell.momentum > 0 ? 'heating' : 'cooling';
      // Compute sustained momentum: average over history
      const history = cell.momentumHistory || [];
      const sustained = history.length > 0
        ? round(history.reduce((s, h) => s + h.v, 0) / history.length, 6)
        : 0;
      movers.push({
        cellId: i,
        axes: cell.axes,
        score: round(cell.score, 3),
        momentum: round(cell.momentum, 6),
        sustained,
        trend
      });
    }
    movers.sort((a, b) => Math.abs(b.momentum) - Math.abs(a.momentum));
    return movers;
  }

  computeOptimalRoutes(startCell, opts = {}) {
    // Compute top-K routes through the cube from startCell that maximize
    // cumulative score exposure. Uses greedy DFS with backtracking.
    const maxDepth = opts.maxDepth || 6;
    const topK = opts.topK || 5;
    const start = Number.isFinite(startCell) ? startCell : 0;
    const results = [];

    const dfs = (current, path, visited, totalScore) => {
      if (path.length >= maxDepth + 1) {
        results.push({
          path: [...path],
          totalScore: round(totalScore, 3),
          avgScore: round(totalScore / path.length, 3)
        });
        return;
      }
      const neighbors = this._neighborsByManhattan(current)
        .filter(n => !visited.has(n))
        .sort((a, b) => this.state.cells[String(b)].score - this.state.cells[String(a)].score);

      if (neighbors.length === 0) {
        if (path.length >= 2) {
          results.push({
            path: [...path],
            totalScore: round(totalScore, 3),
            avgScore: round(totalScore / path.length, 3)
          });
        }
        return;
      }

      // Explore top-3 neighbors to keep search bounded
      for (const n of neighbors.slice(0, 3)) {
        const nScore = this.state.cells[String(n)].score;
        visited.add(n);
        path.push(n);
        dfs(n, path, visited, totalScore + nScore);
        path.pop();
        visited.delete(n);
      }
    };

    const startScore = this.state.cells[String(start)].score;
    dfs(start, [start], new Set([start]), startScore);

    results.sort((a, b) => (b.totalScore - a.totalScore) || (b.path.length - a.path.length));
    return results.slice(0, topK).map((r, i) => ({
      id: `route-${start}-${i}`,
      ...r
    }));
  }

  computeTopology() {
    // Compute the overall "shape" of the semantic field.
    // Returns metrics that detect phase transitions and field structure.
    const scores = [];
    const axisScores = {
      what: { 'trust-model': 0, surface: 0, architecture: 0 },
      where: { internal: 0, external: 0, engine: 0 },
      time: { historical: 0, current: 0, emerging: 0 }
    };
    let totalScore = 0;
    let activeCells = 0;
    let maxScore = 0;
    let minActiveScore = Infinity;

    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      scores.push(cell.score);
      totalScore += cell.score;
      if (cell.score > 0.05) {
        activeCells++;
        if (cell.score < minActiveScore) minActiveScore = cell.score;
      }
      if (cell.score > maxScore) maxScore = cell.score;
      axisScores.what[cell.axes.what] += cell.score;
      axisScores.where[cell.axes.where] += cell.score;
      axisScores.time[cell.axes.time] += cell.score;
    }

    if (activeCells === 0) minActiveScore = 0;
    const meanScore = round(totalScore / 27, 6);

    // Variance and standard deviation
    const variance = round(
      scores.reduce((sum, s) => sum + Math.pow(s - meanScore, 2), 0) / 27, 6
    );
    const stdDev = round(Math.sqrt(variance), 6);

    // Entropy — how evenly distributed is the score across cells
    let entropy = 0;
    if (totalScore > 0) {
      for (const s of scores) {
        if (s <= 0) continue;
        const p = s / totalScore;
        entropy -= p * Math.log2(p);
      }
    }
    const maxEntropy = Math.log2(27);
    const normalizedEntropy = maxEntropy > 0 ? round(entropy / maxEntropy, 6) : 0;

    // Concentration — opposite of entropy. How focused is the field?
    const concentration = round(1 - normalizedEntropy, 6);

    // Dominant axis per dimension
    const dominantWhat = Object.entries(axisScores.what).sort((a, b) => b[1] - a[1])[0];
    const dominantWhere = Object.entries(axisScores.where).sort((a, b) => b[1] - a[1])[0];
    const dominantTime = Object.entries(axisScores.time).sort((a, b) => b[1] - a[1])[0];

    // Phase classification based on field shape
    let phase;
    if (activeCells === 0) phase = 'dormant';
    else if (concentration > 0.7) phase = 'focused';
    else if (concentration > 0.4) phase = 'clustered';
    else if (normalizedEntropy > 0.8) phase = 'diffuse';
    else phase = 'transitional';

    // Layer energy distribution
    const layerScores = [0, 0, 0];
    for (let i = 0; i < 27; i += 1) {
      const layer = Math.floor(i / 9);
      layerScores[layer] += this.state.cells[String(i)].score;
    }

    return {
      totalScore: round(totalScore, 3),
      meanScore: round(meanScore, 6),
      maxScore: round(maxScore, 3),
      minActiveScore: round(minActiveScore, 3),
      activeCells,
      variance: round(variance, 6),
      stdDev: round(stdDev, 6),
      entropy: round(entropy, 3),
      normalizedEntropy: round(normalizedEntropy, 3),
      concentration: round(concentration, 3),
      phase,
      dominantAxes: {
        what: { axis: dominantWhat[0], score: round(dominantWhat[1], 3) },
        where: { axis: dominantWhere[0], score: round(dominantWhere[1], 3) },
        time: { axis: dominantTime[0], score: round(dominantTime[1], 3) }
      },
      layerEnergy: {
        floor: round(layerScores[0], 3),
        middle: round(layerScores[1], 3),
        top: round(layerScores[2], 3)
      }
    };
  }

  summarizeEmergence(opts = {}) {
    const collisions = this.detectCollisions({ ...opts, persist: false });
    const clusters = this._findClusters();
    const gradients = this._findGradients();
    const corridors = this._findCorridors();
    const heatmap = this._buildHeatmap();

    const topCells = [];
    for (let i = 0; i < 27; i += 1) {
      const cell = this.state.cells[String(i)];
      topCells.push({
        cellId: i,
        score: round(cell.score, 3),
        formulaResidue: round(cell.formulaResidue, 3),
        events: cell.events,
        axes: cell.axes
      });
    }
    topCells.sort((a, b) => (b.score - a.score) || (b.formulaResidue - a.formulaResidue) || (a.cellId - b.cellId));
    const strongestCell = topCells[0] || null;

    const topRoutes = [];
    for (const g of gradients.slice(0, 5)) {
      topRoutes.push({
        type: 'gradient',
        id: g.id,
        path: g.path,
        score: g.slope
      });
    }
    for (const c of corridors.slice(0, 5)) {
      topRoutes.push({
        type: 'corridor',
        id: c.id,
        path: c.path,
        score: c.strength
      });
    }
    topRoutes.sort((a, b) => b.score - a.score);

    const gravityWells = this.computeGravityField();
    const momentumSnapshot = this.computeMomentumSnapshot();
    const topology = this.computeTopology();
    const optimalRoutes = strongestCell
      ? this.computeOptimalRoutes(strongestCell.cellId, { maxDepth: 5, topK: 3 })
      : [];

    const suggestions = [];
    if (strongestCell) {
      suggestions.push(
        `Focus on ${strongestCell.axes.what} / ${strongestCell.axes.where} / ${strongestCell.axes.time} (cell ${strongestCell.cellId}).`
      );
    }
    if (corridors.length > 0) {
      suggestions.push(`Probe corridor ${corridors[0].path.join('→')} for sustained cross-cell emergence.`);
    }
    if (collisions.length > 0) {
      suggestions.push(`Highest collision ${collisions[0].cells.join('↔')} has emergence score ${collisions[0].emergenceScore}.`);
    }
    const heating = momentumSnapshot.filter(m => m.trend === 'heating');
    if (heating.length > 0) {
      suggestions.push(`Cell ${heating[0].cellId} is heating (momentum ${heating[0].momentum}).`);
    }
    if (gravityWells.length > 0 && gravityWells[0].pullStrength > 0.001) {
      suggestions.push(`Gravity well at cell ${gravityWells[0].cellId} (mass ${gravityWells[0].gravityMass}, pull ${gravityWells[0].pullStrength}).`);
    }
    if (optimalRoutes.length > 0) {
      suggestions.push(`Optimal route from cell ${strongestCell.cellId}: ${optimalRoutes[0].path.join('→')} (score ${optimalRoutes[0].totalScore}).`);
    }
    suggestions.push(`Field phase: ${topology.phase} (concentration ${topology.concentration}, entropy ${topology.normalizedEntropy}).`);
    suggestions.push(`Dominant: ${topology.dominantAxes.what.axis} / ${topology.dominantAxes.where.axis} / ${topology.dominantAxes.time.axis}.`);

    return {
      clock: this.state.clock,
      heatmap,
      collisions,
      clusters,
      gradients,
      corridors,
      gravityWells: gravityWells.slice(0, 10),
      momentum: momentumSnapshot.slice(0, 10),
      optimalRoutes,
      topology,
      strongestCell,
      topCells: topCells.slice(0, 10),
      topRoutes: topRoutes.slice(0, 10),
      suggestions
    };
  }

  renderAscii(snapshot = null) {
    const snap = snapshot || this.summarizeEmergence({ persist: false });
    const lines = [];
    const primaryCluster = new Set((snap.clusters[0] && snap.clusters[0].cells) || []);
    const primaryGradient = new Set((snap.gradients[0] && snap.gradients[0].path) || []);
    const topWell = (snap.gravityWells && snap.gravityWells[0]) ? snap.gravityWells[0].cellId : -1;
    const heatingCells = new Set(
      (snap.momentum || []).filter(m => m.trend === 'heating').map(m => m.cellId)
    );

    for (let z = 0; z < 3; z += 1) {
      lines.push(`z=${z} (${AXIS_TIME[z]})`);
      for (let y = 2; y >= 0; y -= 1) {
        const row = [];
        for (let x = 0; x < 3; x += 1) {
          const cellId = coordsToCell(x, y, z);
          const score = this.state.cells[String(cellId)].score;
          const ch = heatChar(score);
          let marker = ' ';
          if (cellId === topWell) marker = 'G';
          else if (primaryCluster.has(cellId)) marker = '*';
          else if (primaryGradient.has(cellId)) marker = '+';
          else if (heatingCells.has(cellId)) marker = '^';
          row.push(`${ch}${marker}`);
        }
        lines.push(row.join(' '));
      }
      lines.push('');
    }

    lines.push('Legend: · low  ░ mild  ▒ med  ▓ high  █ peak  * cluster  + gradient  G gravity  ^ heating');
    if (snap.gradients && snap.gradients.length > 0) {
      const g = snap.gradients[0];
      lines.push(`Gradient: ${g.path.join(' -> ')} (slope ${g.slope})`);
    }
    if (snap.clusters && snap.clusters.length > 0) {
      const c = snap.clusters[0];
      lines.push(`Cluster: ${c.cells.join(', ')} (total ${c.totalScore})`);
    }
    if (snap.corridors && snap.corridors.length > 0) {
      const c = snap.corridors[0];
      lines.push(`Corridor: ${c.path.join(' -> ')} (length ${c.length}, strength ${c.strength})`);
    }
    if (snap.gravityWells && snap.gravityWells.length > 0) {
      const w = snap.gravityWells[0];
      lines.push(`Gravity well: cell ${w.cellId} (mass ${w.gravityMass}, pull ${w.pullStrength})`);
    }
    if (snap.optimalRoutes && snap.optimalRoutes.length > 0) {
      const r = snap.optimalRoutes[0];
      lines.push(`Optimal route: ${r.path.join(' -> ')} (score ${r.totalScore})`);
    }
    if (snap.topology) {
      const t = snap.topology;
      lines.push(`Phase: ${t.phase} | active=${t.activeCells}/27 | concentration=${t.concentration} | entropy=${t.normalizedEntropy}`);
    }
    return lines.join('\n');
  }
}

function expectEngine(engine) {
  if (!engine || typeof engine !== 'object') throw new Error('Cube engine instance is required');
  if (typeof engine.ingestSignal !== 'function') throw new Error('Invalid cube engine instance');
}

function ingestSignal(engine, signal, opts) {
  expectEngine(engine);
  return engine.ingestSignal(signal, opts);
}

function updateResidue(engine, tick, opts) {
  expectEngine(engine);
  return engine.updateResidue(tick, opts);
}

function detectCollisions(engine, opts) {
  expectEngine(engine);
  return engine.detectCollisions(opts);
}

function summarizeEmergence(engine, opts) {
  expectEngine(engine);
  return engine.summarizeEmergence(opts);
}

module.exports = {
  AXIS_WHAT,
  AXIS_WHERE,
  AXIS_TIME,
  GRAVITY_FACTOR,
  SPILLOVER_FACTOR,
  coordsToCell,
  cellToCoords,
  manhattanDistance,
  normalizeSignal,
  Clashd27CubeEngine,
  ingestSignal,
  updateResidue,
  detectCollisions,
  summarizeEmergence
};
