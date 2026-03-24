/**
 * Quick metrics sanity check — prints strict vs legacy discovery stats
 */
const fs = require('fs');
const path = require('path');

const FINDINGS_FILE = path.join(__dirname, '..', 'data', 'findings.json');
const METRICS_FILE = path.join(__dirname, '..', 'data', 'metrics.json');

function isLegacy(f) {
  return f.type === 'discovery' && (!f.abc_chain || !f.kill_test || !f.scores);
}

try {
  const findings = JSON.parse(fs.readFileSync(FINDINGS_FILE, 'utf8')).findings || [];
  const metrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));

  const discoveries = findings.filter(f => f.type === 'discovery');
  const strict = discoveries.filter(f => !isLegacy(f));
  const legacy = discoveries.filter(isLegacy);
  const attempts = findings.filter(f => f.type === 'attempt');
  const noGap = attempts.filter(a => a.result && a.result.outcome === 'no_gap');

  const att = attempts.length > 0 ? attempts.length : (strict.length + noGap.length);
  const strictGapRate = att > 0 ? Math.round((strict.length / att) * 1000) / 10 : 0;
  const strictHV = strict.filter(f => {
    const v = (f.verdict && f.verdict.verdict) || f.verdict || '';
    return v === 'HIGH-VALUE GAP';
  });
  const strictHVRate = att > 0 ? Math.round((strictHV.length / att) * 1000) / 10 : 0;

  console.log(`\n📊 METRICS SANITY CHECK`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Total discoveries:      ${discoveries.length}`);
  console.log(`    Strict (has abc/kill/scores): ${strict.length}`);
  console.log(`    Legacy (old format):          ${legacy.length}`);
  console.log(`  Attempts:               ${attempts.length}`);
  console.log(`  No-gap:                 ${noGap.length}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Strict gap rate:        ${strictGapRate}%`);
  console.log(`  Strict HV rate:         ${strictHVRate}%`);
  console.log(`  (Total gap rate):       ${metrics.gap_rate || 0}%`);
  console.log(`  (Total HV rate):        ${metrics.high_value_rate || 0}%`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Metrics file rates:`);
  console.log(`    strict_gap_rate:       ${metrics.strict_gap_rate ?? 'not set'}`);
  console.log(`    strict_high_value_rate:${metrics.strict_high_value_rate ?? 'not set'}`);
  console.log(`    legacy_discoveries:    ${metrics.legacy_discoveries_count ?? 'not set'}`);
  console.log(`    strict_discoveries:    ${metrics.strict_discoveries_count ?? 'not set'}`);
  console.log();
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
