const AXIS_WHAT = ['trust-model', 'surface', 'architecture'];
const AXIS_WHERE = ['internal', 'external', 'engine'];
const AXIS_TIME = ['historical', 'current', 'emerging'];

function mapToCubeCell(input) {
  const text = `${String(input.category || '')} ${String(input.text || '')}`.toLowerCase();
  const source = String(input.source || '').toLowerCase();
  const timestampIso = String(input.timestampIso || '');
  const publishedAtIso = typeof input.publishedAtIso === 'string' ? input.publishedAtIso : null;

  const what = resolveWhatAxis(text);
  const where = resolveWhereAxis(source);
  const when = resolveTimeAxis({ text, timestampIso, publishedAtIso });

  const x = AXIS_WHAT.indexOf(what);
  const y = AXIS_WHERE.indexOf(where);
  const z = AXIS_TIME.indexOf(when);
  const cellIndex = (z * 9) + (y * 3) + x;

  return {
    cubeCell: [what, where, when],
    cellIndex
  };
}

function resolveWhatAxis(text) {
  if (
    text.includes('consent') ||
    text.includes('approval') ||
    text.includes('permission') ||
    text.includes('trust') ||
    text.includes('risk') ||
    text.includes('safety') ||
    text.includes('alignment') ||
    text.includes('evaluation') ||
    text.includes('benchmark') ||
    text.includes('reward') ||
    text.includes('adversarial') ||
    text.includes('robustness') ||
    text.includes('verification')
  ) {
    return 'trust-model';
  }

  if (
    text.includes('channel') ||
    text.includes('discord') ||
    text.includes('slack') ||
    text.includes('telegram') ||
    text.includes('api') ||
    text.includes('mcp') ||
    text.includes('ui') ||
    text.includes('surface') ||
    text.includes('tool') ||
    text.includes('plugin') ||
    text.includes('function-calling') ||
    text.includes('server') ||
    text.includes('agent') ||
    text.includes('delegation') ||
    text.includes('orchestration')
  ) {
    return 'surface';
  }

  return 'architecture';
}

function resolveWhereAxis(source) {
  if (
    source === 'competitors' ||
    source === 'openclaw' ||
    source === 'openclaw-skills' ||
    source === 'github' ||
    source === 'github_search'
  ) {
    return 'external';
  }

  if (
    source === 'commonphone-traffic' ||
    source === 'burnerphone-traffic' ||
    source === 'lobby-proposals' ||
    source === 'internal'
  ) {
    return 'internal';
  }

  return 'engine';
}

function resolveTimeAxis(input) {
  if (
    input.text.includes('gap') ||
    input.text.includes('no existing') ||
    input.text.includes('unexplored') ||
    input.text.includes('emerg') ||
    input.text.includes('open problem') ||
    input.text.includes('future work') ||
    input.text.includes('novel') ||
    input.text.includes('preliminary')
  ) {
    return 'emerging';
  }

  if (typeof input.publishedAtIso !== 'string' || !input.publishedAtIso.trim()) {
    return 'current';
  }

  const detectedMs = Date.parse(input.timestampIso);
  const publishedMs = Date.parse(input.publishedAtIso);
  if (!Number.isFinite(detectedMs) || !Number.isFinite(publishedMs)) {
    return 'current';
  }

  const ageDays = Math.floor(Math.max(0, detectedMs - publishedMs) / (24 * 60 * 60 * 1000));
  return ageDays > 30 ? 'historical' : 'current';
}

module.exports = {
  AXIS_WHAT,
  AXIS_WHERE,
  AXIS_TIME,
  mapToCubeCell
};
