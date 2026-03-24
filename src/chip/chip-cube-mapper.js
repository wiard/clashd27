'use strict';

const CHIP_AXIS_WHAT = Object.freeze(['setup', 'hold', 'power', 'area', 'congestion']);
const CHIP_AXIS_SEVERITY = Object.freeze(['margin', 'violation', 'critical', 'surprise']);
const CHIP_AXIS_ACTION = Object.freeze(['retime', 'buffer', 'resize', 'delay', 'monitor']);

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function classifyWhat(signal) {
  const classification = normalizeText(signal.classification);
  const subdomain = normalizeText(signal.subdomain);
  const combined = `${classification} ${subdomain}`;

  if (combined.includes('hold') || combined.includes('min')) return 'hold';
  if (combined.includes('power') || combined.includes('ir-drop') || combined.includes('voltage')) return 'power';
  if (combined.includes('area') || combined.includes('density')) return 'area';
  if (combined.includes('congestion') || combined.includes('routing') || combined.includes('route')) return 'congestion';
  return 'setup';
}

function classifySeverity(signal) {
  const slackNs = safeNumber(signal.slack_ns);
  const blocking = signal.blocking === true;
  const combined = `${normalizeText(signal.classification)} ${normalizeText(signal.subdomain)}`;

  if (slackNs !== null) {
    if (slackNs < -1.0) return 'critical';
    if (slackNs < 0) return blocking ? 'critical' : 'violation';
    if (slackNs <= 0.5) return blocking ? 'surprise' : 'margin';
  }

  if (blocking) return 'surprise';
  if (combined.includes('surprise')) return 'surprise';
  if (combined.includes('critical')) return 'critical';
  if (combined.includes('violation')) return 'violation';
  return 'margin';
}

function classifyActionHint(what, severity, signal) {
  const classification = normalizeText(signal.classification);
  const subdomain = normalizeText(signal.subdomain);
  const blocking = signal.blocking === true;

  if (what === 'hold') {
    if (severity === 'critical' || severity === 'violation') return 'delay';
    return 'monitor';
  }

  if (what === 'power') {
    return severity === 'critical' ? 'resize' : 'monitor';
  }

  if (what === 'area' || what === 'congestion') {
    return severity === 'critical' ? 'resize' : 'monitor';
  }

  if (blocking && (severity === 'critical' || severity === 'surprise')) return 'retime';
  if (severity === 'critical') return 'retime';
  if (severity === 'violation') {
    if (classification.includes('setup') || subdomain.includes('setup')) return 'buffer';
    return 'resize';
  }
  if (severity === 'surprise') return 'retime';
  return 'monitor';
}

function normalizeChipAction(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized.includes('retime')) return 'retime';
  if (normalized.includes('buffer')) return 'buffer';
  if (normalized.includes('resize') || normalized.includes('size')) return 'resize';
  if (normalized.includes('delay') || normalized.includes('hold')) return 'delay';
  if (normalized.includes('monitor') || normalized.includes('margin')) return 'monitor';
  return null;
}

function mapChipSignalToCube(signal) {
  const what = classifyWhat(signal);
  const severity = classifySeverity(signal);
  const action_hint = classifyActionHint(what, severity, signal);
  return {
    what,
    severity,
    action_hint,
    cell_id: `${what}/${severity}/${action_hint}`
  };
}

module.exports = {
  CHIP_AXIS_ACTION,
  CHIP_AXIS_SEVERITY,
  CHIP_AXIS_WHAT,
  mapChipSignalToCube,
  normalizeChipAction
};
