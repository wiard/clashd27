'use strict';

const crypto = require('crypto');

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function normalizeScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 0;
  if (score <= 1) return Math.max(0, Math.min(1, score));
  return Math.max(0, Math.min(1, score / 100));
}

function compactText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function normalizeSourceRef(src) {
  if (!src) return null;
  if (typeof src === 'string') {
    return { sourceType: 'text', sourceId: src, label: compactText(src, 120) };
  }
  const sourceType = src.sourceType || src.type || 'unknown';
  const sourceId = src.sourceId || src.id || src.source || '';
  const label = compactText(src.label || src.claim || src.title || sourceId, 120);
  return { sourceType, sourceId, label };
}

function toCandidateId(discovery) {
  return discovery.candidateId || discovery.discovery_id || discovery.id || null;
}

function getPairKey(discovery) {
  if (discovery.goldenCollision && discovery.goldenCollision.cellA && discovery.goldenCollision.cellB) {
    const a = `${discovery.goldenCollision.cellA.method || ''}:${discovery.goldenCollision.cellA.surprise || ''}`.toLowerCase();
    const b = `${discovery.goldenCollision.cellB.method || ''}:${discovery.goldenCollision.cellB.surprise || ''}`.toLowerCase();
    return [a, b].filter(Boolean).sort().join('|');
  }

  const labels = Array.isArray(discovery.cellLabels)
    ? discovery.cellLabels.map(v => String(v || '').toLowerCase().trim()).filter(Boolean)
    : [];

  if (labels.length >= 2) {
    return labels.slice(0, 2).sort().join('|');
  }

  if (discovery.cellLabel) {
    return String(discovery.cellLabel).toLowerCase().trim();
  }

  const agents = Array.isArray(discovery.agents)
    ? discovery.agents.map(v => String(v || '').toLowerCase().trim()).filter(Boolean)
    : [];
  return agents.sort().join('|');
}

function getCorridorKey(discovery) {
  const labels = Array.isArray(discovery.cellLabels)
    ? discovery.cellLabels.map(v => String(v || '').trim()).filter(Boolean)
    : [];
  if (labels.length > 0) return labels.join('×');
  if (discovery.corridor) return String(discovery.corridor);
  return 'cross-domain';
}

function getInvestigationTaskTexts(discovery) {
  const out = [];
  if (discovery.kill_test) out.push(String(discovery.kill_test));
  if (discovery.cheapest_validation) out.push(String(discovery.cheapest_validation));
  if (discovery.proposed_experiment) out.push(String(discovery.proposed_experiment));
  if (Array.isArray(discovery.investigation_tasks)) {
    for (const task of discovery.investigation_tasks) {
      if (typeof task === 'string') out.push(task);
      else if (task && typeof task.title === 'string') out.push(task.title);
    }
  }
  return out.map(v => v.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex');
}

function buildStats(allFindings) {
  const pairCounts = new Map();
  const corridorCounts = new Map();
  const taskCounts = new Map();
  const relatedByPair = new Map();

  for (const finding of allFindings || []) {
    if (!finding || finding.type !== 'discovery') continue;

    const candidateId = toCandidateId(finding);
    const pairKey = getPairKey(finding);
    if (pairKey) {
      pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
      if (!relatedByPair.has(pairKey)) relatedByPair.set(pairKey, []);
      if (candidateId) relatedByPair.get(pairKey).push(candidateId);
    }

    const corridorKey = getCorridorKey(finding);
    corridorCounts.set(corridorKey, (corridorCounts.get(corridorKey) || 0) + 1);

    for (const taskText of getInvestigationTaskTexts(finding)) {
      const taskKey = hashText(taskText.toLowerCase());
      taskCounts.set(taskKey, (taskCounts.get(taskKey) || 0) + 1);
    }
  }

  return { pairCounts, corridorCounts, taskCounts, relatedByPair };
}

function computeNoveltyScore(discovery) {
  const scoreObj = discovery.scores || {};
  if (typeof scoreObj.novelty === 'number') return round(normalizeScore(scoreObj.novelty));

  const total = normalizeScore(scoreObj.total || 0);
  const hasFewSources = (discovery.abc_chain || []).length <= 2;
  return round(Math.max(0, Math.min(1, total * 0.85 + (hasFewSources ? 0.1 : 0))));
}

function computeGovernanceValue(discovery) {
  let value = 0.3;
  const verdict = String((discovery.verdict && discovery.verdict.verdict) || discovery.verdict || '').toUpperCase();
  if (verdict === 'HIGH-VALUE GAP') value += 0.3;
  else if (verdict === 'CONFIRMED DIRECTION') value += 0.15;

  const scoreObj = discovery.scores || {};
  const total = normalizeScore(scoreObj.total || 0);
  value += total * 0.2;

  const evidenceCount = (discovery.abc_chain || []).length;
  if (evidenceCount >= 4) value += 0.15;
  else if (evidenceCount >= 2) value += 0.08;

  if (Array.isArray(discovery.cellLabels) && discovery.cellLabels.length >= 2) value += 0.08;

  return round(Math.max(0, Math.min(1, value)));
}

function deriveActionKind(signals, governanceValue) {
  if (signals.highNoveltyGovernance || governanceValue >= 0.8) return 'governance_review';
  if (signals.repeatedGravityIntersections) return 'cross_domain_probe';
  if (signals.clusterHotspots) return 'hotspot_watch';
  if (signals.repeatedInvestigationTasks) return 'investigation_automation';
  return 'standard_review';
}

function deriveCapabilities(signals) {
  const caps = [];
  if (signals.repeatedGravityIntersections) caps.push('cross_domain_signal_fusion');
  if (signals.clusterHotspots) caps.push('hotspot_drift_tracking');
  if (signals.repeatedInvestigationTasks) caps.push('investigation_pattern_memory');
  if (signals.highNoveltyGovernance) caps.push('governance_priority_projection');
  if (caps.length === 0) caps.push('evidence_linking');
  return caps;
}

function buildEvidenceRefs(discovery) {
  const refs = [];
  for (const item of discovery.abc_chain || []) {
    const normalized = normalizeSourceRef({
      sourceType: 'abc_chain',
      sourceId: item.source || '',
      label: item.claim || item.source || ''
    });
    if (normalized) refs.push(normalized);
  }

  for (const src of discovery.supporting_sources || []) {
    const normalized = normalizeSourceRef(src);
    if (normalized) refs.push(normalized);
  }

  const seen = new Set();
  const deduped = [];
  for (const ref of refs) {
    const key = `${ref.sourceType}:${ref.sourceId}:${ref.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ref);
    if (deduped.length >= 8) break;
  }

  return deduped;
}

function buildDomainAxes(discovery) {
  const what = [];
  const where = [];
  const time = [];

  const labels = Array.isArray(discovery.cellLabels)
    ? discovery.cellLabels.map(v => String(v || '').trim()).filter(Boolean)
    : [];

  if (labels.length > 0) {
    what.push(...labels);
  }

  const gc = discovery.goldenCollision || {};
  if (gc.cellA && gc.cellA.method) what.push(String(gc.cellA.method));
  if (gc.cellB && gc.cellB.method) what.push(String(gc.cellB.method));

  if (discovery.corridor) where.push(String(discovery.corridor));
  if (discovery.tick) time.push(`tick:${discovery.tick}`);

  return {
    what: [...new Set(what.map(v => v.trim()).filter(Boolean))].slice(0, 6),
    where: [...new Set(where.map(v => v.trim()).filter(Boolean))].slice(0, 6),
    time: [...new Set(time.map(v => v.trim()).filter(Boolean))].slice(0, 6)
  };
}

function buildPrimaryCells(discovery) {
  const labels = Array.isArray(discovery.cellLabels) ? discovery.cellLabels : [];
  if (labels.length > 0) {
    return labels.slice(0, 3).map((label, idx) => ({ cellId: idx, label }));
  }

  if (discovery.cellLabel) {
    return [{ cellId: 0, label: discovery.cellLabel }];
  }

  return [{ cellId: 0, label: 'cross-domain' }];
}

function buildExtensionId(candidateId, pairKey, corridorKey) {
  const suffix = crypto
    .createHash('sha1')
    .update(`${candidateId}|${pairKey}|${corridorKey}`)
    .digest('hex')
    .slice(0, 12);
  return `ext-${suffix}`;
}

function buildReasoning(signals, pairCount, corridorCount, repeatedTaskCount, noveltyScore, governanceValue) {
  const parts = [];
  if (signals.repeatedGravityIntersections) {
    parts.push(`gravity intersections repeated ${pairCount}x`);
  }
  if (signals.clusterHotspots) {
    parts.push(`cluster hotspot repeated ${corridorCount}x`);
  }
  if (signals.repeatedInvestigationTasks) {
    parts.push(`investigation pattern repeated ${repeatedTaskCount}x`);
  }
  if (signals.highNoveltyGovernance) {
    parts.push(`novelty ${noveltyScore} + governance ${governanceValue}`);
  }
  if (parts.length === 0) {
    parts.push('high-value discovery candidate');
  }
  return parts.join('; ');
}

function generateExtensionCandidates(discoveries, context = {}) {
  const stats = buildStats(context.allFindings || discoveries || []);
  const minDiscoveryScore = Number.isFinite(context.minDiscoveryScore)
    ? context.minDiscoveryScore
    : parseFloat(process.env.EXTENSION_DISCOVERY_SCORE_MIN || '70');
  const minRepeatedIntersection = Number.isFinite(context.minRepeatedIntersection)
    ? context.minRepeatedIntersection
    : parseInt(process.env.EXTENSION_REPEAT_INTERSECTION_MIN || '2', 10);
  const minRepeatedTasks = Number.isFinite(context.minRepeatedTasks)
    ? context.minRepeatedTasks
    : parseInt(process.env.EXTENSION_REPEAT_TASKS_MIN || '2', 10);
  const minHotspotRepeats = Number.isFinite(context.minHotspotRepeats)
    ? context.minHotspotRepeats
    : parseInt(process.env.EXTENSION_HOTSPOT_MIN || '3', 10);

  const out = [];
  const seen = new Set();

  for (const discovery of discoveries || []) {
    if (!discovery || discovery.type !== 'discovery') continue;

    const totalScore = (discovery.scores && discovery.scores.total) || 0;
    if (typeof totalScore === 'number' && totalScore < minDiscoveryScore) continue;

    const candidateId = toCandidateId(discovery);
    if (!candidateId) continue;

    const pairKey = getPairKey(discovery);
    const corridorKey = getCorridorKey(discovery);
    const pairCount = pairKey ? (stats.pairCounts.get(pairKey) || 0) : 0;
    const corridorCount = stats.corridorCounts.get(corridorKey) || 0;

    const taskKeys = getInvestigationTaskTexts(discovery).map(t => hashText(t.toLowerCase()));
    const repeatedTaskCount = taskKeys.reduce((max, taskKey) => Math.max(max, stats.taskCounts.get(taskKey) || 0), 0);

    const noveltyScore = computeNoveltyScore(discovery);
    const governanceValue = computeGovernanceValue(discovery);

    const signals = {
      repeatedGravityIntersections: pairCount >= minRepeatedIntersection,
      clusterHotspots: corridorCount >= minHotspotRepeats || ((discovery.collisionCount || 0) >= 2),
      repeatedInvestigationTasks: repeatedTaskCount >= minRepeatedTasks,
      highNoveltyGovernance: noveltyScore >= 0.75 && governanceValue >= 0.7
    };

    const hasSignal = Object.values(signals).some(Boolean);
    if (!hasSignal) continue;

    const candidateScore = round(Math.min(1,
      noveltyScore * 0.4 +
      governanceValue * 0.4 +
      (signals.repeatedGravityIntersections ? 0.08 : 0) +
      (signals.clusterHotspots ? 0.06 : 0) +
      (signals.repeatedInvestigationTasks ? 0.06 : 0)
    ));

    if (seen.has(candidateId)) continue;
    seen.add(candidateId);

    const extensionId = buildExtensionId(candidateId, pairKey, corridorKey);
    const related = (stats.relatedByPair.get(pairKey) || []).filter(id => id !== candidateId).slice(0, 5);

    out.push({
      candidateId,
      extensionId,
      title: compactText(`Proposed extension from ${corridorKey} (${candidateId})`, 120),
      purpose: compactText(discovery.finding || discovery.hypothesis || 'Convert repeated discovery signal into a reusable governance extension proposal.', 220),
      recommendedActionKind: deriveActionKind(signals, governanceValue),
      capabilities: deriveCapabilities(signals),
      noveltyScore,
      governanceValue,
      candidateScore,
      evidenceRefs: buildEvidenceRefs(discovery),
      primaryCells: buildPrimaryCells(discovery),
      domainAxes: buildDomainAxes(discovery),
      reasoningTraceShort: buildReasoning(signals, pairCount, corridorCount, repeatedTaskCount, noveltyScore, governanceValue),
      parentCandidateId: candidateId,
      relatedCandidateIds: related,
      originatingTick: typeof discovery.tick === 'number' ? discovery.tick : (context.tick || null),
      originatingClusterId: discovery.originatingClusterId || pairKey || corridorKey,
      graphHints: {
        nodeType: 'extension_proposal',
        edgeLabels: Object.entries(signals).filter(([, value]) => value).map(([key]) => key),
        weight: candidateScore
      },
      triggerSignals: signals
    });
  }

  out.sort((a, b) => (b.candidateScore - a.candidateScore) || (a.extensionId < b.extensionId ? -1 : 1));
  return out;
}

module.exports = {
  generateExtensionCandidates,
  computeNoveltyScore,
  computeGovernanceValue
};
