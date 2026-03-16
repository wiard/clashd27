export interface RealityAuditDecisionInput {
  decision_id: string;
  candidate_id: string;
  decision_type: string;
  candidate_type?: string;
  theme?: string;
  region?: string;
  signal_family?: string;
  proposal_id?: string;
  signal_id?: string;
  decided_at: string;
  confidence: number;
  outcome_status?: string;
  outcome_signal?: string;
  residue_value?: number;
}

export interface RealityAuditSignalInput {
  signal_id: string;
  node_id: string;
  region: string;
  signal_type: string;
  detected_at: string;
}

export interface RealityAuditResidueInput {
  region: string;
  node_ids: string[];
  signal_types: string[];
  decision: string;
  residue_value: number;
}

export interface RealityAuditRepeatedPatternInput {
  pattern_id: string;
  region: string;
  signal_family: string;
  occurrence_count: number;
  confirmed_count: number;
  average_confidence: number;
}

export interface RealityAuditKnowledgeInput {
  title?: string;
  summary?: string;
  namespace?: string;
  key?: string;
}

export interface RealityAudit {
  audit_id: string;
  target_decision_id: string;
  anomaly_score: number;
  entropy_delta: number;
  contradiction_signals: string[];
  adjusted_confidence: number;
  audit_summary: string;
  decision_type: string;
  theme: string;
  region?: string;
  signal_family?: string;
  original_confidence: number;
}

export interface RealityAuditState {
  generated_at: string;
  recent_audits: RealityAudit[];
  highest_anomaly_decisions: RealityAudit[];
  entropy_trend: {
    direction: "improving" | "stable" | "degrading";
    average_entropy_delta: number;
    average_adjusted_confidence: number;
  };
}

interface RealityAuditContext {
  decisions: RealityAuditDecisionInput[];
  signals: RealityAuditSignalInput[];
  residueEntries: RealityAuditResidueInput[];
  repeatedPatterns: RealityAuditRepeatedPatternInput[];
  knowledgeObjects: RealityAuditKnowledgeInput[];
  nowIso: string;
}

const MAX_RECENT_AUDITS = 8;
const MAX_ANOMALY_DECISIONS = 5;
const LOOKBACK_WINDOW_MS = 45 * 60 * 1000;

export function buildRealityAuditState(input: RealityAuditContext): RealityAuditState {
  const audits = buildRealityAudits(input);
  const recentAudits = audits.slice(0, MAX_RECENT_AUDITS);
  const highestAnomalyDecisions = audits
    .slice()
    .sort((left, right) => {
      if (left.anomaly_score !== right.anomaly_score) {
        return right.anomaly_score - left.anomaly_score;
      }
      return left.audit_id.localeCompare(right.audit_id);
    })
    .slice(0, MAX_ANOMALY_DECISIONS);

  const averageEntropyDelta = audits.length > 0
    ? round2(audits.reduce((sum, audit) => sum + audit.entropy_delta, 0) / audits.length)
    : 0;
  const averageAdjustedConfidence = audits.length > 0
    ? round2(audits.reduce((sum, audit) => sum + audit.adjusted_confidence, 0) / audits.length)
    : 0;

  return {
    generated_at: input.nowIso,
    recent_audits: recentAudits,
    highest_anomaly_decisions: highestAnomalyDecisions,
    entropy_trend: {
      direction: averageEntropyDelta >= 0.12
        ? "improving"
        : averageEntropyDelta <= -0.12
          ? "degrading"
          : "stable",
      average_entropy_delta: averageEntropyDelta,
      average_adjusted_confidence: averageAdjustedConfidence
    }
  };
}

export function buildRealityAudits(input: RealityAuditContext): RealityAudit[] {
  return input.decisions
    .slice()
    .sort((left, right) => {
      if (left.decided_at !== right.decided_at) {
        return right.decided_at.localeCompare(left.decided_at);
      }
      return left.decision_id.localeCompare(right.decision_id);
    })
    .map((decision) => buildRealityAuditForDecision(decision, input));
}

function buildRealityAuditForDecision(
  decision: RealityAuditDecisionInput,
  input: RealityAuditContext
): RealityAudit {
  const relatedSignals = findRelatedSignals(decision, input.signals);
  const signalDiversity = resolveSignalDiversity(relatedSignals);
  const evidenceIndependence = resolveEvidenceIndependence(relatedSignals);
  const residueConcentration = resolveResidueConcentration(decision, input.residueEntries);
  const correlationStability = resolveCorrelationStability(decision, input.repeatedPatterns);
  const domainDrift = resolveDomainDrift(decision, input.knowledgeObjects, input.repeatedPatterns);

  const contradictionSignals: string[] = [];
  if (signalDiversity < 0.5) contradictionSignals.push("low signal diversity");
  if (evidenceIndependence < 0.55) contradictionSignals.push("low evidence independence");
  if (residueConcentration > 0.58) contradictionSignals.push("residue concentration risk");
  if (correlationStability < 0.45) contradictionSignals.push("correlation stability weak");
  if (domainDrift > 0.5) contradictionSignals.push("domain drift warning");

  const anomalyScore = clamp01(round2(
    (1 - signalDiversity) * 0.24 +
    (1 - evidenceIndependence) * 0.22 +
    residueConcentration * 0.20 +
    (1 - correlationStability) * 0.18 +
    domainDrift * 0.16
  ));
  const entropyDelta = round2(
    ((signalDiversity + evidenceIndependence + correlationStability) / 3)
    - ((residueConcentration + domainDrift) / 2)
  );
  const confidenceReduction = round2(
    anomalyScore * 0.18 + Math.max(0, -entropyDelta) * 0.10
  );
  const adjustedConfidence = clamp01(round2(decision.confidence - confidenceReduction));

  return {
    audit_id: `${decision.decision_id}:${normalizeText(decision.region)}:${normalizeText(decision.signal_family)}`,
    target_decision_id: decision.decision_id,
    anomaly_score: anomalyScore,
    entropy_delta: entropyDelta,
    contradiction_signals: contradictionSignals,
    adjusted_confidence: adjustedConfidence,
    audit_summary: buildAuditSummary({
      decision,
      contradictionSignals,
      adjustedConfidence,
      entropyDelta
    }),
    decision_type: decision.decision_type,
    theme: decision.theme ?? "autonomy decision",
    region: decision.region,
    signal_family: decision.signal_family,
    original_confidence: round2(decision.confidence)
  };
}

function findRelatedSignals(
  decision: RealityAuditDecisionInput,
  signals: RealityAuditSignalInput[]
): RealityAuditSignalInput[] {
  const decisionMs = Date.parse(decision.decided_at);
  const exact = decision.signal_id
    ? signals.filter((signal) => signal.signal_id === decision.signal_id)
    : [];
  const contextual = signals.filter((signal) => {
    if (decision.region && normalizeText(signal.region) !== normalizeText(decision.region)) {
      return false;
    }
    if (decision.signal_family && classifySignalFamily(signal.signal_type) !== normalizeText(decision.signal_family)) {
      return false;
    }
    if (Number.isNaN(decisionMs)) {
      return true;
    }
    const detectedMs = Date.parse(signal.detected_at);
    return !Number.isNaN(detectedMs) && Math.abs(detectedMs - decisionMs) <= LOOKBACK_WINDOW_MS;
  });

  return [...exact, ...contextual]
    .reduce<RealityAuditSignalInput[]>((acc, signal) => {
      if (!acc.some((candidate) => candidate.signal_id === signal.signal_id)) {
        acc.push(signal);
      }
      return acc;
    }, [])
    .sort((left, right) => {
      if (left.detected_at !== right.detected_at) {
        return left.detected_at.localeCompare(right.detected_at);
      }
      return left.signal_id.localeCompare(right.signal_id);
    });
}

function resolveSignalDiversity(signals: RealityAuditSignalInput[]): number {
  if (signals.length === 0) return 0.25;
  const uniqueNodes = new Set(signals.map((signal) => normalizeText(signal.node_id)));
  const uniqueTypes = new Set(signals.map((signal) => classifySignalFamily(signal.signal_type)));
  return clamp01(round2((uniqueNodes.size / signals.length) * 0.7 + (uniqueTypes.size / 3) * 0.3));
}

function resolveEvidenceIndependence(signals: RealityAuditSignalInput[]): number {
  if (signals.length === 0) return 0.2;
  const uniqueNodes = new Set(signals.map((signal) => normalizeText(signal.node_id))).size;
  const uniqueRegions = new Set(signals.map((signal) => normalizeText(signal.region))).size;
  const independence = (uniqueNodes / signals.length) * 0.8 + Math.min(1, uniqueRegions) * 0.2;
  return clamp01(round2(independence));
}

function resolveResidueConcentration(
  decision: RealityAuditDecisionInput,
  residueEntries: RealityAuditResidueInput[]
): number {
  const approvedEntries = residueEntries.filter((entry) => entry.decision === "approved");
  if (approvedEntries.length === 0) return 0;

  const totalResidue = approvedEntries.reduce((sum, entry) => sum + Math.max(0, entry.residue_value), 0);
  if (totalResidue <= 0) return 0;

  const regionResidue = approvedEntries
    .filter((entry) => normalizeText(entry.region) === normalizeText(decision.region))
    .reduce((sum, entry) => sum + Math.max(0, entry.residue_value), 0);
  const familyResidue = approvedEntries
    .filter((entry) => entry.signal_types.some((signalType) => classifySignalFamily(signalType) === normalizeText(decision.signal_family)))
    .reduce((sum, entry) => sum + Math.max(0, entry.residue_value), 0);

  const concentration = Math.max(regionResidue, familyResidue) / totalResidue;
  return clamp01(round2(concentration));
}

function resolveCorrelationStability(
  decision: RealityAuditDecisionInput,
  repeatedPatterns: RealityAuditRepeatedPatternInput[]
): number {
  const relatedPattern = repeatedPatterns.find((pattern) =>
    normalizeText(pattern.region) === normalizeText(decision.region)
    && normalizeText(pattern.signal_family) === normalizeText(decision.signal_family)
  );
  if (!relatedPattern) {
    return 0.28;
  }
  const stability = (
    Math.min(1, relatedPattern.occurrence_count / 4) * 0.4 +
    Math.min(1, relatedPattern.confirmed_count / 3) * 0.35 +
    clamp01(relatedPattern.average_confidence) * 0.25
  );
  return clamp01(round2(stability));
}

function resolveDomainDrift(
  decision: RealityAuditDecisionInput,
  knowledgeObjects: RealityAuditKnowledgeInput[],
  repeatedPatterns: RealityAuditRepeatedPatternInput[]
): number {
  const themeKey = normalizeText(decision.theme);
  const familyKey = normalizeText(decision.signal_family);
  const relatedKnowledgeCount = knowledgeObjects.filter((object) => {
    const haystack = normalizeText([
      object.title,
      object.summary,
      object.namespace,
      object.key
    ].filter(Boolean).join(" "));
    return (themeKey && haystack.includes(themeKey)) || (familyKey && haystack.includes(familyKey));
  }).length;
  const relatedPatterns = repeatedPatterns.filter((pattern) =>
    normalizeText(pattern.region) === normalizeText(decision.region)
    && normalizeText(pattern.signal_family) === familyKey
  ).length;

  if (relatedKnowledgeCount >= 2 || relatedPatterns >= 1) {
    return 0.12;
  }
  if (relatedKnowledgeCount === 1) {
    return 0.28;
  }
  return 0.62;
}

function buildAuditSummary(input: {
  decision: RealityAuditDecisionInput;
  contradictionSignals: string[];
  adjustedConfidence: number;
  entropyDelta: number;
}): string {
  const contradictionSummary = input.contradictionSignals.length > 0
    ? input.contradictionSignals.join(", ")
    : "no major contradictions";
  const direction = input.entropyDelta >= 0.12
    ? "entropy lowering"
    : input.entropyDelta <= -0.12
      ? "entropy rising"
      : "entropy stable";
  return `${input.decision.decision_type} for ${input.decision.theme ?? "autonomy decision"} shows ${contradictionSummary}; ${direction}; adjusted confidence ${input.adjustedConfidence.toFixed(2)}.`;
}

function classifySignalFamily(signalType: string | undefined): string {
  const normalized = normalizeText(signalType);
  if (normalized === "node_degraded" || normalized === "power_instability") {
    return "degradation";
  }
  return normalized;
}

function normalizeText(value: string | undefined | null): string {
  return String(value ?? "").trim().toLowerCase();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}
