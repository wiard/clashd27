'use strict';

const fs = require('fs');
const path = require('path');

/**
 * v2 Knowledge Publisher — publishes high-value discovery findings
 * to the openclashd-v2 gateway via HTTP POST.
 *
 * Payloads are enriched for:
 *   - proposal ranking (novelty, evidence, governance scores)
 *   - action creation (recommendedActionKind, candidateSummary)
 *   - knowledge graph linking (graphHints, parentCandidateId)
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const EXTENSION_PROPOSALS_FILE = process.env.EXTENSION_PROPOSALS_FILE || path.join(DATA_DIR, 'extension-proposals.json');
const GAP_HANDOFF_LOG_FILE = process.env.GAP_HANDOFF_LOG_FILE || path.join(DATA_DIR, 'gap-proposal-handoffs.json');
const MAX_EXTENSION_LOG = parseInt(process.env.EXTENSION_PROPOSAL_LOG_MAX || '2000', 10);

let extensionStoreLock = Promise.resolve();
let gapHandoffStoreLock = Promise.resolve();

function safeReadJSON(filePath, fallback, opts = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    if (opts.throwOnError) throw err;
  }
  return fallback;
}

function safeWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function backupCorruptJSON(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${filePath}.bak-${stamp}`;
  try {
    fs.renameSync(filePath, backup);
  } catch (_) {
    // ignore backup failures
  }
}

function loadExtensionStore(filePath = EXTENSION_PROPOSALS_FILE) {
  try {
    const parsed = safeReadJSON(filePath, null, { throwOnError: true });
    if (parsed && Array.isArray(parsed.proposals) && parsed.proposedKeys && typeof parsed.proposedKeys === 'object') {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.proposals)) {
      const proposedKeys = {};
      for (const item of parsed.proposals) {
        if (item && item.dedupeKey && item.publishStatus === 'published') {
          proposedKeys[item.dedupeKey] = item.publishedAt || item.lastAttemptAt || new Date().toISOString();
        }
      }
      return { proposals: parsed.proposals, proposedKeys };
    }
  } catch (_) {
    backupCorruptJSON(filePath);
  }
  return { proposals: [], proposedKeys: {} };
}

function saveExtensionStore(store, filePath = EXTENSION_PROPOSALS_FILE) {
  const bounded = {
    proposals: (store.proposals || []).slice(-MAX_EXTENSION_LOG),
    proposedKeys: store.proposedKeys || {}
  };
  safeWriteJSON(filePath, bounded);
}

function withExtensionStoreLock(work) {
  extensionStoreLock = extensionStoreLock
    .then(() => work())
    .catch(err => ({ published: false, failed: true, reason: `store_error:${err.message}` }));
  return extensionStoreLock;
}

function loadGapHandoffStore(filePath = GAP_HANDOFF_LOG_FILE) {
  try {
    const parsed = safeReadJSON(filePath, null, { throwOnError: true });
    if (parsed && Array.isArray(parsed.handoffs) && parsed.deliveredKeys && typeof parsed.deliveredKeys === 'object') {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.handoffs)) {
      const deliveredKeys = {};
      for (const item of parsed.handoffs) {
        if (item && item.dedupeKey && item.publishStatus === 'published') {
          deliveredKeys[item.dedupeKey] = item.publishedAt || item.lastAttemptAt || new Date().toISOString();
        }
      }
      return { handoffs: parsed.handoffs, deliveredKeys };
    }
  } catch (_) {
    backupCorruptJSON(filePath);
  }
  return { handoffs: [], deliveredKeys: {} };
}

function saveGapHandoffStore(store, filePath = GAP_HANDOFF_LOG_FILE) {
  safeWriteJSON(filePath, {
    handoffs: (store.handoffs || []).slice(-MAX_EXTENSION_LOG),
    deliveredKeys: store.deliveredKeys || {}
  });
}

function withGapHandoffStoreLock(work) {
  gapHandoffStoreLock = gapHandoffStoreLock
    .then(() => work())
    .catch(err => ({ published: false, failed: true, reason: `store_error:${err.message}` }));
  return gapHandoffStoreLock;
}

/**
 * Derives a recommended action kind from finding characteristics.
 */
function deriveActionKind(finding) {
  const total = (finding.scores && finding.scores.total) || 0;
  const gptVerdict = finding.gpt_verdict || finding.verification || '';
  const upper = typeof gptVerdict === 'string' ? gptVerdict.toUpperCase() : '';

  if (upper === 'CONFIRMED' && total >= 80) return 'governance_review';
  if (total >= 70) return 'deep_investigation';
  if ((finding.abc_chain || []).length >= 3) return 'evidence_synthesis';
  return 'standard_review';
}

/**
 * Builds a compact summary string for the finding.
 */
function buildFindingSummary(finding) {
  const parts = [];
  if (finding.finding) parts.push(finding.finding.slice(0, 80));
  if (finding.scores) parts.push(`score ${finding.scores.total}`);
  if (finding.abc_chain) parts.push(`${finding.abc_chain.length} evidence links`);
  return parts.join(' — ') || finding.id;
}

function buildExtensionDedupeKey(candidate) {
  const candidateId = candidate.candidateId || candidate.parentCandidateId || candidate.extensionId || 'unknown';
  return `extension:${candidateId}`;
}

function round(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function normalizeExtensionPayload(candidate) {
  return {
    extensionId: candidate.extensionId,
    title: String(candidate.title || `Extension proposal ${candidate.extensionId || ''}`).slice(0, 180),
    purpose: String(candidate.purpose || '').slice(0, 500),
    recommendedActionKind: candidate.recommendedActionKind || 'standard_review',
    capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities.slice(0, 8) : [],
    noveltyScore: round(candidate.noveltyScore),
    governanceValue: round(candidate.governanceValue),
    evidenceRefs: Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs.slice(0, 10) : [],
    primaryCells: Array.isArray(candidate.primaryCells) ? candidate.primaryCells.slice(0, 10) : [],
    domainAxes: candidate.domainAxes && typeof candidate.domainAxes === 'object'
      ? candidate.domainAxes
      : { what: [], where: [], time: [] },
    reasoningTraceShort: String(candidate.reasoningTraceShort || '').slice(0, 320),
    candidateId: candidate.candidateId || candidate.parentCandidateId || null,
    candidateScore: round(candidate.candidateScore),
    parentCandidateId: candidate.parentCandidateId || candidate.candidateId || null,
    relatedCandidateIds: Array.isArray(candidate.relatedCandidateIds) ? candidate.relatedCandidateIds.slice(0, 10) : [],
    originatingTick: typeof candidate.originatingTick === 'number' ? candidate.originatingTick : null,
    originatingClusterId: candidate.originatingClusterId || null,
    graphHints: candidate.graphHints && typeof candidate.graphHints === 'object' ? candidate.graphHints : null
  };
}

function appendProposalRecord(store, record) {
  store.proposals.push(record);
  if (store.proposals.length > MAX_EXTENSION_LOG) {
    store.proposals = store.proposals.slice(-MAX_EXTENSION_LOG);
  }
}

function persistExtensionKnowledge(payload) {
  try {
    const { persistKnowledgeObject } = require('./knowledge-persistence');
    persistKnowledgeObject({
      kind: 'extension_proposal',
      title: payload.title,
      summary: payload.purpose,
      sourceRefs: payload.evidenceRefs || [],
      metadata: {
        extensionId: payload.extensionId,
        recommendedActionKind: payload.recommendedActionKind,
        capabilities: payload.capabilities,
        noveltyScore: payload.noveltyScore,
        governanceValue: payload.governanceValue,
        candidateScore: payload.candidateScore,
        primaryCells: payload.primaryCells,
        domainAxes: payload.domainAxes,
        reasoningTraceShort: payload.reasoningTraceShort
      },
      parentCandidateId: payload.parentCandidateId,
      relatedCandidateIds: payload.relatedCandidateIds,
      originatingTick: payload.originatingTick,
      originatingClusterId: payload.originatingClusterId,
      graphHints: payload.graphHints || {
        nodeType: 'extension_proposal',
        edgeLabels: ['proposal_published'],
        weight: payload.candidateScore || 0
      }
    });
  } catch (err) {
    console.warn(`[clashd27] extension knowledge persistence failed: ${err.message}`);
  }
}

async function publishExtensionProposal(candidate, options = {}) {
  const gatewayUrl = options.gatewayUrl || process.env.OPENCLASHD_GATEWAY_URL;
  const token = options.token || process.env.OPENCLASHD_TOKEN;
  const storeFile = options.storeFile || EXTENSION_PROPOSALS_FILE;
  const fetchImpl = options.fetchImpl || fetch;
  const persistKnowledge = options.persistKnowledge !== false;
  const candidateThreshold = Number.isFinite(options.candidateThreshold)
    ? options.candidateThreshold
    : parseFloat(process.env.EXTENSION_CANDIDATE_SCORE_THRESHOLD || '0.72');
  const governanceThreshold = Number.isFinite(options.governanceThreshold)
    ? options.governanceThreshold
    : parseFloat(process.env.EXTENSION_GOVERNANCE_THRESHOLD || '0.65');

  if (!candidate || typeof candidate !== 'object') {
    return { published: false, reason: 'invalid_candidate' };
  }

  const payload = normalizeExtensionPayload(candidate);
  const dedupeKey = buildExtensionDedupeKey(payload);
  const now = new Date().toISOString();

  return withExtensionStoreLock(async () => {
    const store = loadExtensionStore(storeFile);
    if (store.proposedKeys[dedupeKey]) {
      return { published: false, deduped: true, reason: 'deduped', dedupeKey };
    }

    if ((payload.candidateScore || 0) < candidateThreshold) {
      appendProposalRecord(store, {
        dedupeKey,
        extensionId: payload.extensionId,
        candidateId: payload.candidateId,
        payload,
        publishStatus: 'skipped_threshold',
        reason: `candidate_score_below_${candidateThreshold}`,
        lastAttemptAt: now,
        parentCandidateId: payload.parentCandidateId,
        relatedCandidateIds: payload.relatedCandidateIds,
        originatingTick: payload.originatingTick,
        originatingClusterId: payload.originatingClusterId,
        graphHints: payload.graphHints
      });
      saveExtensionStore(store, storeFile);
      return { published: false, reason: 'candidate_threshold', dedupeKey };
    }

    if ((payload.governanceValue || 0) < governanceThreshold) {
      appendProposalRecord(store, {
        dedupeKey,
        extensionId: payload.extensionId,
        candidateId: payload.candidateId,
        payload,
        publishStatus: 'skipped_governance',
        reason: `governance_below_${governanceThreshold}`,
        lastAttemptAt: now,
        parentCandidateId: payload.parentCandidateId,
        relatedCandidateIds: payload.relatedCandidateIds,
        originatingTick: payload.originatingTick,
        originatingClusterId: payload.originatingClusterId,
        graphHints: payload.graphHints
      });
      saveExtensionStore(store, storeFile);
      return { published: false, reason: 'governance_threshold', dedupeKey };
    }

    if (!gatewayUrl || !token) {
      appendProposalRecord(store, {
        dedupeKey,
        extensionId: payload.extensionId,
        candidateId: payload.candidateId,
        payload,
        publishStatus: 'skipped_missing_gateway',
        reason: 'missing_gateway_or_token',
        lastAttemptAt: now,
        parentCandidateId: payload.parentCandidateId,
        relatedCandidateIds: payload.relatedCandidateIds,
        originatingTick: payload.originatingTick,
        originatingClusterId: payload.originatingClusterId,
        graphHints: payload.graphHints
      });
      saveExtensionStore(store, storeFile);
      return { published: false, reason: 'missing_gateway_or_token', dedupeKey };
    }

    const url = `${gatewayUrl.replace(/\/$/, '')}/api/extensions/propose?token=${encodeURIComponent(token)}`;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        store.proposedKeys[dedupeKey] = now;
        appendProposalRecord(store, {
          dedupeKey,
          extensionId: payload.extensionId,
          candidateId: payload.candidateId,
          payload,
          publishStatus: 'published',
          httpStatus: response.status,
          lastAttemptAt: now,
          publishedAt: now,
          parentCandidateId: payload.parentCandidateId,
          relatedCandidateIds: payload.relatedCandidateIds,
          originatingTick: payload.originatingTick,
          originatingClusterId: payload.originatingClusterId,
          graphHints: payload.graphHints
        });
        saveExtensionStore(store, storeFile);
        if (persistKnowledge) {
          persistExtensionKnowledge(payload);
        }
        return { published: true, dedupeKey, extensionId: payload.extensionId, status: response.status };
      }

      const text = await response.text().catch(() => '');
      appendProposalRecord(store, {
        dedupeKey,
        extensionId: payload.extensionId,
        candidateId: payload.candidateId,
        payload,
        publishStatus: 'failed_http',
        httpStatus: response.status,
        reason: text.slice(0, 200),
        lastAttemptAt: now,
        parentCandidateId: payload.parentCandidateId,
        relatedCandidateIds: payload.relatedCandidateIds,
        originatingTick: payload.originatingTick,
        originatingClusterId: payload.originatingClusterId,
        graphHints: payload.graphHints
      });
      saveExtensionStore(store, storeFile);
      return { published: false, failed: true, dedupeKey, status: response.status };
    } catch (err) {
      appendProposalRecord(store, {
        dedupeKey,
        extensionId: payload.extensionId,
        candidateId: payload.candidateId,
        payload,
        publishStatus: 'failed_error',
        reason: err.message,
        lastAttemptAt: now,
        parentCandidateId: payload.parentCandidateId,
        relatedCandidateIds: payload.relatedCandidateIds,
        originatingTick: payload.originatingTick,
        originatingClusterId: payload.originatingClusterId,
        graphHints: payload.graphHints
      });
      saveExtensionStore(store, storeFile);
      return { published: false, failed: true, dedupeKey, reason: 'network_error' };
    }
  });
}

async function publishExtensionProposals(candidates, options = {}) {
  const summary = {
    published: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    results: []
  };

  for (const candidate of candidates || []) {
    const result = await publishExtensionProposal(candidate, options);
    summary.results.push(result);
    if (result.published) summary.published += 1;
    else if (result.deduped) summary.deduped += 1;
    else if (result.failed) summary.failed += 1;
    else summary.skipped += 1;
  }

  if (summary.published > 0) {
    const noun = summary.published === 1 ? 'extension proposal' : 'extension proposals';
    console.log(`[clashd27] published ${summary.published} ${noun} to v2`);
  }

  return summary;
}

function appendGapHandoffRecord(store, record) {
  store.handoffs.push(record);
  if (store.handoffs.length > MAX_EXTENSION_LOG) {
    store.handoffs = store.handoffs.slice(-MAX_EXTENSION_LOG);
  }
}

function buildGapHandoffDedupeKey(handoff) {
  const packetId = handoff && handoff.packetId ? handoff.packetId : 'unknown';
  return `gap_handoff:${packetId}`;
}

function normalizeGapHandoffProposal(handoff) {
  if (!handoff || typeof handoff !== 'object') {
    return null;
  }
  if (handoff.destinationSystem !== 'openclashd-v2' || handoff.executionMode !== 'forbidden') {
    return null;
  }
  if (handoff.proposal && typeof handoff.proposal === 'object') {
    return handoff.proposal;
  }

  const packet = handoff.packet || {};
  const metadata = packet.metadata || {};
  return {
    agentId: 'clashd27',
    title: packet.title || `Gap proposal ${handoff.packetId || ''}`.trim(),
    candidateSummary: packet.summary || '',
    reasoningTraceShort: (((metadata.scoringTrace || {}).formulas || {}).total || '').slice(0, 320),
    recommendedActionKind: metadata.recommendedAction && metadata.recommendedAction.class
      ? metadata.recommendedAction.class
      : 'standard_review',
    intent: {
      kind: 'gap_candidate',
      key: `gap_candidate:${handoff.packetId || 'unknown'}`,
      requiresConsent: true,
      risk: 'green',
      payload: {
        packetId: handoff.packetId || null,
        summary: packet.summary || '',
        hypothesis: metadata.hypothesis || null,
        verificationPlan: metadata.verificationPlan || [],
        killTests: metadata.killTests || [],
        cube: metadata.cube || null,
        normalization: metadata.normalization || null,
        scores: metadata.scores || null,
        evidenceRefs: packet.evidence || [],
        lifecycleState: metadata.lifecycleState || null,
        scoringTrace: metadata.scoringTrace || null
      }
    }
  };
}

async function publishGapProposalHandoff(handoff, options = {}) {
  const gatewayUrl = options.gatewayUrl || process.env.OPENCLASHD_GATEWAY_URL || process.env.OPENCLASHD_V2_URL;
  const token = options.token || process.env.OPENCLASHD_TOKEN;
  const fetchImpl = options.fetchImpl || fetch;
  const storeFile = options.storeFile || GAP_HANDOFF_LOG_FILE;

  const proposal = normalizeGapHandoffProposal(handoff);
  if (!proposal) {
    return { published: false, reason: 'invalid_handoff' };
  }

  const dedupeKey = buildGapHandoffDedupeKey(handoff);
  const now = new Date().toISOString();

  return withGapHandoffStoreLock(async () => {
    const store = loadGapHandoffStore(storeFile);
    if (store.deliveredKeys[dedupeKey]) {
      return { published: false, deduped: true, dedupeKey, reason: 'deduped' };
    }

    if (!gatewayUrl || !token) {
      appendGapHandoffRecord(store, {
        dedupeKey,
        packetId: handoff.packetId,
        candidateId: proposal.intent && proposal.intent.payload ? proposal.intent.payload.candidateId || null : null,
        proposal,
        publishStatus: 'skipped_missing_gateway',
        reason: 'missing_gateway_or_token',
        lastAttemptAt: now
      });
      saveGapHandoffStore(store, storeFile);
      return { published: false, skipped: true, dedupeKey, reason: 'missing_gateway_or_token' };
    }

    const url = `${gatewayUrl.replace(/\/$/, '')}/api/agents/propose?token=${encodeURIComponent(token)}`;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(proposal)
      });

      if (response.ok) {
        store.deliveredKeys[dedupeKey] = now;
        appendGapHandoffRecord(store, {
          dedupeKey,
          packetId: handoff.packetId,
          candidateId: proposal.intent && proposal.intent.payload ? proposal.intent.payload.candidateId || null : null,
          proposal,
          publishStatus: 'published',
          httpStatus: response.status,
          lastAttemptAt: now,
          publishedAt: now
        });
        saveGapHandoffStore(store, storeFile);
        return { published: true, dedupeKey, packetId: handoff.packetId, status: response.status };
      }

      const text = await response.text().catch(() => '');
      appendGapHandoffRecord(store, {
        dedupeKey,
        packetId: handoff.packetId,
        candidateId: proposal.intent && proposal.intent.payload ? proposal.intent.payload.candidateId || null : null,
        proposal,
        publishStatus: 'failed_http',
        httpStatus: response.status,
        reason: text.slice(0, 200),
        lastAttemptAt: now
      });
      saveGapHandoffStore(store, storeFile);
      return { published: false, failed: true, dedupeKey, packetId: handoff.packetId, status: response.status };
    } catch (err) {
      appendGapHandoffRecord(store, {
        dedupeKey,
        packetId: handoff.packetId,
        candidateId: proposal.intent && proposal.intent.payload ? proposal.intent.payload.candidateId || null : null,
        proposal,
        publishStatus: 'failed_error',
        reason: err.message,
        lastAttemptAt: now
      });
      saveGapHandoffStore(store, storeFile);
      return { published: false, failed: true, dedupeKey, packetId: handoff.packetId, reason: 'network_error' };
    }
  });
}

async function publishGapProposalHandoffs(handoffs, options = {}) {
  const summary = {
    published: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    results: []
  };

  for (const handoff of handoffs || []) {
    const result = await publishGapProposalHandoff(handoff, options);
    summary.results.push(result);
    if (result.published) summary.published += 1;
    else if (result.deduped) summary.deduped += 1;
    else if (result.failed) summary.failed += 1;
    else summary.skipped += 1;
  }

  return summary;
}

/**
 * Publish qualifying discoveries to the openclashd-v2 gateway.
 *
 * @param {Array} findings - Array of finding objects from the tick engine
 * @param {object} options
 * @param {string} options.gatewayUrl - Base URL of the openclashd-v2 gateway
 * @param {string} options.token - Authentication token
 * @returns {Promise<{published: number, failed: number}>}
 */
async function publishToV2(findings, { gatewayUrl, token }) {
  let published = 0;
  let failed = 0;

  // Filter to only high-value discoveries
  const qualifying = (findings || []).filter(f =>
    f.type === 'discovery' &&
    f.scores &&
    typeof f.scores.total === 'number' &&
    f.scores.total >= 50
  );

  if (qualifying.length === 0) {
    return { published, failed };
  }

  const url = `${gatewayUrl}/api/agents/propose?token=${token}`;

  for (const finding of qualifying) {
    try {
      const novelty = (finding.scores.novelty || 0) / 100;
      const evidenceDensity = Math.min(
        (finding.abc_chain || []).length / 5,
        1.0
      );

      const gptVerdict = finding.gpt_verdict || finding.verification || '';
      let sourceConfidence = 0.3;
      if (typeof gptVerdict === 'string') {
        const upper = gptVerdict.toUpperCase();
        if (upper === 'CONFIRMED') sourceConfidence = 0.9;
        else if (upper === 'WEAKENED') sourceConfidence = 0.6;
      }

      const supportingSources = (finding.supporting_sources || []).slice(0, 5);
      const governanceValue = sourceConfidence >= 0.7 ? 0.8 : sourceConfidence >= 0.5 ? 0.5 : 0.3;

      const title = finding.finding
        ? finding.finding.slice(0, 120)
        : finding.id;

      const body = {
        agentId: 'clashd27',
        title,
        candidateSummary: buildFindingSummary(finding),
        reasoningTraceShort: finding.hypothesis
          ? finding.hypothesis.slice(0, 200)
          : 'Discovery identified via cube emergence pipeline',
        recommendedActionKind: deriveActionKind(finding),
        intent: {
          key: 'intent.discovery.persist',
          payload: {
            discoveryId: finding.id,
            corridor: finding.corridor,
            novelty,
            evidenceDensity,
            crossDomain: true,
            crossDomainScore: 0.8,
            sourceConfidence,
            governanceValue,
            supportingSourceCount: supportingSources.length,
            collisionCount: finding.collisionCount || 0,
            sources: supportingSources,
            finding: finding.finding,
            scores: finding.scores,
            verdict: finding.verdict?.verdict,
            evidenceRefs: (finding.abc_chain || []).slice(0, 5).map(c => ({
              sourceType: 'abc_chain',
              sourceId: c.source || '',
              label: c.claim
            })),
            graphHints: {
              nodeType: 'published_discovery',
              edgeLabels: finding.abc_verified ? ['verified_chain'] : ['unverified'],
              weight: (finding.scores.total || 0) / 100,
              parentCandidateId: finding.candidateId || null
            }
          },
          risk: 'green',
          requiresConsent: false
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        published++;
      } else {
        const text = await response.text().catch(() => '');
        console.warn(`[clashd27] v2 publish HTTP ${response.status} for ${finding.id}: ${text}`);
        failed++;
      }
    } catch (err) {
      console.warn(`[clashd27] v2 publish error for ${finding.id}: ${err.message}`);
      failed++;
    }
  }

  if (published > 0) {
    const noun = published === 1 ? 'discovery' : 'discoveries';
    console.log(`[clashd27] published ${published} ${noun} to v2`);
  }

  return { published, failed };
}

module.exports = {
  publishToV2,
  publishGapProposalHandoff,
  publishGapProposalHandoffs,
  publishExtensionProposal,
  publishExtensionProposals,
  deriveActionKind,
  buildFindingSummary,
  buildExtensionDedupeKey,
  normalizeExtensionPayload,
  normalizeGapHandoffProposal,
  loadExtensionStore,
  saveExtensionStore,
  loadGapHandoffStore,
  saveGapHandoffStore
};
