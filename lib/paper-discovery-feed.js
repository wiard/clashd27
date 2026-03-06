"use strict";

const crypto = require("crypto");
const { runDiscoveryCycle } = require("./event-emitter");

const AXIS_WHAT = ["trust-model", "surface", "architecture"];
const AXIS_WHERE = ["internal", "external", "engine"];
const AXIS_TIME = ["historical", "current", "emerging"];

function cellAxes(cellIndex) {
  const a = cellIndex % 3;
  const b = Math.floor(cellIndex / 3) % 3;
  const c = Math.floor(cellIndex / 9);
  return [AXIS_WHAT[a] || "trust-model", AXIS_WHERE[b] || "internal", AXIS_TIME[c] || "current"];
}

function toIso(value) {
  const ts = new Date(value || Date.now()).toISOString();
  return Number.isNaN(Date.parse(ts)) ? new Date().toISOString() : ts;
}

function hashId(payload) {
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function normalizePaperSource(source) {
  if (typeof source !== "string" || !source.trim()) return "paper";
  return source.trim().toLowerCase();
}

function buildSignalSummary(paper, cellIndex) {
  const title = typeof paper.title === "string" && paper.title.trim() ? paper.title.trim() : "untitled paper";
  const source = normalizePaperSource(paper.source);
  return `[${source}] ${title} | cell=${cellIndex}`;
}

function paperToSignalEvent(paper, cellIndex, fallbackTimestamp) {
  const paperSource = normalizePaperSource(paper.source);
  const title = typeof paper.title === "string" && paper.title.trim() ? paper.title.trim() : "untitled paper";
  const topic = Array.isArray(paper.fieldsOfStudy) && paper.fieldsOfStudy.length > 0
    ? String(paper.fieldsOfStudy[0] || "paper").toLowerCase()
    : "paper";
  const detectedAtIso = toIso(paper.timestamp || paper.publishedAt || fallbackTimestamp);
  const signalSeed = `${paperSource}|${title}|${cellIndex}|${detectedAtIso}`;
  const signalId = hashId(signalSeed);
  const cubeCell = cellAxes(cellIndex);

  return {
    type: "signal_detected",
    timestamp: detectedAtIso,
    event: "paper.signal.detected",
    signalId,
    sourceId: "clashd27_papers",
    summary: buildSignalSummary(paper, cellIndex),
    paperSource,
    topic,
    title,
    url: typeof paper.url === "string" ? paper.url : (typeof paper.link === "string" ? paper.link : null),
    cellIndex,
    cubeCell,
    confidence: paper.citationCount > 20 ? "high" : (paper.citationCount > 0 ? "medium" : "low")
  };
}

function buildPaperSignalEvents(cube, opts) {
  if (!cube || !cube.cells || typeof cube.cells !== "object") return [];
  const maxSignals = Number.isFinite(opts.maxSignals) ? opts.maxSignals : 120;

  const rows = [];
  for (const [cellKey, cell] of Object.entries(cube.cells)) {
    const cellIndex = Number.parseInt(cellKey, 10);
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 26) continue;
    const papers = Array.isArray(cell.papers) ? cell.papers : [];
    for (const paper of papers) {
      rows.push({ cellIndex, paper });
    }
  }

  rows.sort((a, b) => {
    const aCites = Number(a.paper?.citationCount || 0);
    const bCites = Number(b.paper?.citationCount || 0);
    if (bCites !== aCites) return bCites - aCites;
    const aYear = Number(a.paper?.year || 0);
    const bYear = Number(b.paper?.year || 0);
    if (bYear !== aYear) return bYear - aYear;
    const aTitle = String(a.paper?.title || "");
    const bTitle = String(b.paper?.title || "");
    return aTitle.localeCompare(bTitle);
  });

  return rows.slice(0, maxSignals).map(({ paper, cellIndex }) =>
    paperToSignalEvent(paper, cellIndex, cube.timestamp)
  );
}

function buildPaperDiscoveryFeed(input) {
  const engine = input.engine;
  const cube = input.cube || null;
  const maxSignals = Number.isFinite(input.maxSignals) ? input.maxSignals : 120;

  let discovery = {
    tick: 0,
    timestamp: new Date().toISOString(),
    events: [],
    gravity: { cells: [], hotspots: [], field: {} },
    discovery: { candidates: [], candidateEvents: [] },
    emergence: { clusters: [], gradients: [], corridors: [], collisions: [] }
  };

  try {
    discovery = runDiscoveryCycle(engine, {
      maxHotspots: 8,
      minGravityScore: 0.8
    });
  } catch (e) {
    // non-fatal: return paper signals only
  }

  const signalEvents = buildPaperSignalEvents(cube, { maxSignals });
  const combinedEvents = [
    ...signalEvents,
    ...(Array.isArray(discovery.events) ? discovery.events : [])
  ].sort((a, b) => {
    const ta = String(a.timestamp || "");
    const tb = String(b.timestamp || "");
    if (ta !== tb) return tb.localeCompare(ta);
    return String(a.type || "").localeCompare(String(b.type || ""));
  });

  return {
    tick: discovery.tick || 0,
    timestamp: discovery.timestamp || new Date().toISOString(),
    counts: {
      signal_detected: signalEvents.length,
      emergence_cluster: (discovery.emergence?.clusters || []).length,
      gravity_hotspot: (discovery.gravity?.hotspots || []).length,
      discovery_candidate: (discovery.discovery?.candidateEvents || []).length
    },
    events: combinedEvents,
    signals: signalEvents,
    emergence: discovery.emergence || { clusters: [], gradients: [], corridors: [], collisions: [] },
    gravity: discovery.gravity || { cells: [], hotspots: [], field: {} },
    discovery: discovery.discovery || { candidates: [], candidateEvents: [] }
  };
}

module.exports = {
  buildPaperDiscoveryFeed
};
