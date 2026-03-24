'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DEFAULT_VIVANT_DIR = path.join(ROOT_DIR, 'data', 'vivant');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

// ─── Trends ──────────────────────────────────────────────
const TRENDS = {
  NAUWER: 'nauwer',
  STABIEL: 'stabiel',
  VERVAAGT: 'vervaagt',
  HERLEEFT: 'herleeft'
};

// ─── Fasen ───────────────────────────────────────────────
const FASEN = {
  OPKOMEND: 'opkomend',
  ACTIEF: 'actief',
  GEVESTIGD: 'gevestigd',
  SLAPEND: 'slapend',
  HERLEEFD: 'herleefd'
};

// ─── Fase berekening ─────────────────────────────────────
function berekenFase(node) {
  if (node.trend === TRENDS.HERLEEFT) return FASEN.HERLEEFD;
  if (node.stilteRuns > 7 && node.gewicht < 0.2) return FASEN.SLAPEND;
  if (node.aantalRuns > 10) return FASEN.GEVESTIGD;
  if (node.aantalRuns >= 3) return FASEN.ACTIEF;
  return FASEN.OPKOMEND;
}

// ─── Precisie berekening ─────────────────────────────────
function berekenPrecisie(node) {
  const gewichtFactor = 0.40 * node.gewicht;
  const groeiFactor = 0.25 * (node.aantalRuns / (node.aantalRuns + 5));
  const activiteitFactor = 0.20 * Math.max(0, 1 - node.stilteRuns / 10);
  const herlevingBonus = 0.15 * Math.min(1, node.herlevingenCount * 0.2);
  return round(Math.min(1.0, Math.max(0, gewichtFactor + groeiFactor + activiteitFactor + herlevingBonus)));
}

// ─── Groei berekening ────────────────────────────────────
function groei(node) {
  const oudGewicht = node.gewicht;
  const nextAantalRuns = node.aantalRuns + 1;
  const basisGewicht = round(1 - (1 / (1 + nextAantalRuns * 0.3)));
  let nieuwGewicht;
  let trend;
  let fase;
  let herlevingenCount = node.herlevingenCount;
  let skipConnectionBonus = 0;

  if (node.stilteRuns > 5) {
    skipConnectionBonus = round(Math.min(0.3, node.stilteRuns * 0.04));
    nieuwGewicht = round(Math.min(1.0, basisGewicht + skipConnectionBonus));
    trend = TRENDS.HERLEEFT;
    fase = FASEN.HERLEEFD;
    herlevingenCount += 1;
  } else {
    nieuwGewicht = basisGewicht;
    trend = nieuwGewicht > oudGewicht ? TRENDS.NAUWER : TRENDS.STABIEL;
    fase = null; // will be computed
  }

  const updated = {
    ...node,
    gewicht: nieuwGewicht,
    aantalRuns: nextAantalRuns,
    stilteRuns: 0,
    trend,
    herlevingenCount,
    skipConnectionBonus,
    laatsteActivatie: new Date().toISOString(),
    gewichtHistory: (node.gewichtHistory || []).concat(nieuwGewicht)
  };

  updated.fase = fase || berekenFase(updated);
  updated.precisie = berekenPrecisie(updated);
  return updated;
}

// ─── Vergeten berekening ─────────────────────────────────
function vergeten(node) {
  const oudGewicht = node.gewicht;
  let nieuwGewicht = oudGewicht;
  const stilteRuns = node.stilteRuns + 1;
  let trend = node.trend;

  if (stilteRuns > 3) {
    nieuwGewicht = round(oudGewicht * Math.pow(0.85, stilteRuns - 3));
    trend = TRENDS.VERVAAGT;
  }

  nieuwGewicht = round(Math.max(0.05, nieuwGewicht));

  const updated = {
    ...node,
    gewicht: nieuwGewicht,
    stilteRuns,
    trend,
    gewichtHistory: (node.gewichtHistory || []).concat(nieuwGewicht)
  };

  updated.fase = berekenFase(updated);
  updated.precisie = berekenPrecisie(updated);
  return updated;
}

// ─── Nieuwe node aanmaken ────────────────────────────────
function createNode(patroon, domeinen) {
  const now = new Date().toISOString();
  const node = {
    nodeId: patroon.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    patroon,
    domeinen: Array.isArray(domeinen) ? domeinen.slice() : [],
    gewicht: 0.23,
    gewichtHistory: [0.23],
    aantalRuns: 1,
    stilteRuns: 0,
    trend: TRENDS.NAUWER,
    fase: FASEN.OPKOMEND,
    eersteActivatie: now,
    laatsteActivatie: now,
    herlevingenCount: 0,
    skipConnectionBonus: 0,
    precisie: 0
  };
  node.precisie = berekenPrecisie(node);
  return node;
}

// ─── Netwerk beweging classificatie ──────────────────────
function classificeerBeweging(snapshot) {
  if (snapshot.herleefdeNodes > 0) return 'kalibrerend';
  if (snapshot.actieveNodes > snapshot.slapendeNodes * 2) return 'groeiend';
  return 'stabiel';
}

// ─── VIVANT Engine ───────────────────────────────────────
class Vivant {
  constructor(options = {}) {
    this.vivantDir = options.vivantDir || DEFAULT_VIVANT_DIR;
    this.netwerkFile = options.netwerkFile || path.join(this.vivantDir, 'netwerk.json');
    this.bewegingFile = options.bewegingFile || path.join(this.vivantDir, 'beweging.jsonl');
    this.snapshotDir = options.snapshotDir || path.join(this.vivantDir, 'snapshots');
    this._nodes = new Map();
    this._load();
  }

  _ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  _load() {
    this._nodes = new Map();
    if (!fs.existsSync(this.netwerkFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.netwerkFile, 'utf8'));
      const nodes = Array.isArray(raw) ? raw : (raw.nodes || []);
      for (const node of nodes) {
        if (node.nodeId) {
          this._nodes.set(node.nodeId, node);
        }
      }
    } catch (_) {
      // Start fresh on corrupt file.
    }
  }

  _save() {
    this._ensureDir(this.netwerkFile);
    const nodes = Array.from(this._nodes.values());
    fs.writeFileSync(this.netwerkFile, JSON.stringify(nodes, null, 2));
  }

  _saveBeweging(entry) {
    this._ensureDir(this.bewegingFile);
    fs.appendFileSync(this.bewegingFile, JSON.stringify(entry) + '\n');
  }

  _saveSnapshot(runId, snapshot) {
    this._ensureDir(path.join(this.snapshotDir, 'placeholder'));
    const fileName = `${runId}.json`;
    fs.writeFileSync(path.join(this.snapshotDir, fileName), JSON.stringify(snapshot, null, 2));
  }

  getNode(nodeId) {
    return this._nodes.get(nodeId) || null;
  }

  getAllNodes() {
    return Array.from(this._nodes.values());
  }

  updateNetwerk(actievePatronen, runId) {
    const timestamp = new Date().toISOString();
    const actieveIds = new Set();
    const nodeUpdates = [];
    const herleefdeNodes = [];
    const vervaagdeNodes = [];
    const nieuweNodes = [];

    // 1. Process active patterns: groei or create
    for (const patroon of actievePatronen) {
      const patternName = typeof patroon === 'string' ? patroon : patroon.patroon;
      const domeinen = typeof patroon === 'string' ? [] : (patroon.domeinen || []);
      const nodeId = patternName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      actieveIds.add(nodeId);
      const existing = this._nodes.get(nodeId);

      if (existing) {
        const oudGewicht = existing.gewicht;
        // Merge domeinen
        const mergedDomeinen = Array.from(new Set([...(existing.domeinen || []), ...domeinen]));
        const updated = groei({ ...existing, domeinen: mergedDomeinen });
        this._nodes.set(nodeId, updated);

        nodeUpdates.push({
          nodeId,
          patroon: updated.patroon,
          oudGewicht: round(oudGewicht),
          nieuwGewicht: updated.gewicht,
          trend: updated.trend,
          fase: updated.fase
        });

        if (updated.trend === TRENDS.HERLEEFT) {
          herleefdeNodes.push(updated.patroon);
        }
      } else {
        const node = createNode(patternName, domeinen);
        this._nodes.set(nodeId, node);
        nieuweNodes.push(patternName);

        nodeUpdates.push({
          nodeId,
          patroon: patternName,
          oudGewicht: 0,
          nieuwGewicht: node.gewicht,
          trend: node.trend,
          fase: node.fase
        });
      }
    }

    // 2. Process inactive nodes: vergeten
    for (const [nodeId, node] of this._nodes) {
      if (actieveIds.has(nodeId)) continue;

      const oudGewicht = node.gewicht;
      const updated = vergeten(node);
      this._nodes.set(nodeId, updated);

      nodeUpdates.push({
        nodeId,
        patroon: updated.patroon,
        oudGewicht: round(oudGewicht),
        nieuwGewicht: updated.gewicht,
        trend: updated.trend,
        fase: updated.fase
      });

      if (updated.trend === TRENDS.VERVAAGT) {
        vervaagdeNodes.push(updated.patroon);
      }
    }

    // 3. Build snapshot
    const allNodes = Array.from(this._nodes.values());
    const actieveNodesList = allNodes.filter((n) => n.fase !== FASEN.SLAPEND);
    const slapendeNodesList = allNodes.filter((n) => n.fase === FASEN.SLAPEND);
    const herleefdeNodesList = allNodes.filter((n) => n.trend === TRENDS.HERLEEFT);
    const gewichten = allNodes.map((n) => n.gewicht);
    const precisies = allNodes.map((n) => n.precisie);
    const gemiddeldGewicht = gewichten.length > 0 ? round(gewichten.reduce((s, g) => s + g, 0) / gewichten.length) : 0;
    const gemiddeldePrecisie = precisies.length > 0 ? round(precisies.reduce((s, p) => s + p, 0) / precisies.length) : 0;

    const sterksteNode = allNodes.length > 0
      ? allNodes.sort((a, b) => b.precisie - a.precisie || b.gewicht - a.gewicht)[0]
      : null;

    const snapshot = {
      runId,
      timestamp,
      totaalNodes: allNodes.length,
      actieveNodes: actieveNodesList.length,
      slapendeNodes: slapendeNodesList.length,
      herleefdeNodes: herleefdeNodesList.length,
      nieuweNodes: nieuweNodes.length,
      gemiddeldGewicht,
      gemiddeldePrecisie,
      sterksteNode: sterksteNode
        ? { patroon: sterksteNode.patroon, gewicht: sterksteNode.gewicht, precisie: sterksteNode.precisie, fase: sterksteNode.fase }
        : null,
      beweging: classificeerBeweging({
        actieveNodes: actieveNodesList.length,
        slapendeNodes: slapendeNodesList.length,
        herleefdeNodes: herleefdeNodesList.length
      })
    };

    // 4. Save everything
    this._save();

    const bewegingEntry = {
      runId,
      timestamp,
      nodeUpdates,
      herleefdeNodes,
      vervaagdeNodes,
      nieuweNodes,
      snapshot
    };

    this._saveBeweging(bewegingEntry);
    this._saveSnapshot(runId, { ...snapshot, nodes: allNodes });

    return snapshot;
  }

  stats() {
    const allNodes = Array.from(this._nodes.values());
    if (allNodes.length === 0) {
      return {
        totaalNodes: 0,
        actieveNodes: 0,
        slapendeNodes: 0,
        gemiddeldGewicht: 0,
        gemiddeldePrecisie: 0,
        sterksteNode: null,
        beweging: 'stabiel'
      };
    }

    const actief = allNodes.filter((n) => n.fase !== FASEN.SLAPEND);
    const slapend = allNodes.filter((n) => n.fase === FASEN.SLAPEND);
    const herleefd = allNodes.filter((n) => n.trend === TRENDS.HERLEEFT);
    const gewichten = allNodes.map((n) => n.gewicht);
    const precisies = allNodes.map((n) => n.precisie);

    const sterksteNode = allNodes.sort((a, b) => b.precisie - a.precisie || b.gewicht - a.gewicht)[0];

    return {
      totaalNodes: allNodes.length,
      actieveNodes: actief.length,
      slapendeNodes: slapend.length,
      herleefdeNodes: herleefd.length,
      gemiddeldGewicht: round(gewichten.reduce((s, g) => s + g, 0) / gewichten.length),
      gemiddeldePrecisie: round(precisies.reduce((s, p) => s + p, 0) / precisies.length),
      sterksteNode: {
        patroon: sterksteNode.patroon,
        gewicht: sterksteNode.gewicht,
        precisie: sterksteNode.precisie,
        fase: sterksteNode.fase
      },
      beweging: classificeerBeweging({
        actieveNodes: actief.length,
        slapendeNodes: slapend.length,
        herleefdeNodes: herleefd.length
      })
    };
  }

  topNodes(count = 5) {
    return Array.from(this._nodes.values())
      .sort((a, b) => b.precisie - a.precisie || b.gewicht - a.gewicht)
      .slice(0, count);
  }

  lastBeweging() {
    if (!fs.existsSync(this.bewegingFile)) return null;
    const lines = fs.readFileSync(this.bewegingFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    try {
      return JSON.parse(lines[lines.length - 1]);
    } catch (_) {
      return null;
    }
  }

  bewegingHistory(count = 10) {
    if (!fs.existsSync(this.bewegingFile)) return [];
    const lines = fs.readFileSync(this.bewegingFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const entries = [];
    for (let i = Math.max(0, lines.length - count); i < lines.length; i += 1) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch (_) {
        // Skip malformed.
      }
    }
    return entries;
  }
}

module.exports = {
  Vivant,
  TRENDS,
  FASEN,
  createNode,
  groei,
  vergeten,
  berekenPrecisie,
  berekenFase,
  classificeerBeweging
};
