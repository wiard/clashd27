#!/usr/bin/env node
/**
 * CLASHD-27 — Doctor: run all health checks
 * Usage: node tools/doctor.js  (or: npm run doctor)
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];

function run(label, cmd) {
  process.stdout.write(`\n--- ${label} ---\n`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit', timeout: 30000 });
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, code: e.status });
  }
}

run('Syntax check: bot.js', 'node -c bot.js');
run('Syntax check: lib/verifier.js', 'node -c lib/verifier.js');
run('Secrets verification', 'node tools/verify-secrets.js');
run('Key diagnostic', 'node tools/diag-openai-key.js');
run('OpenAI connectivity', 'node tools/test-openai-models.js');
run('Verifier self-test', `node -e "require('./lib/verifier').verifierSelfTest().then(r=>{console.log('[SELFTEST]',JSON.stringify(r));if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})"`);

console.log('\n========== DOCTOR SUMMARY ==========');
let allPass = true;
for (const r of results) {
  const tag = r.ok ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${r.label}`);
  if (!r.ok) allPass = false;
}
console.log('====================================');
console.log(allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
process.exit(allPass ? 0 : 1);
