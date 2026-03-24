'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const REPORT_BASE = path.join(HOME, 'jeeves-office', 'reports');

const REPOS = {
  'openclashd-v2': path.join(HOME, 'openclashd-v2'),
  'clashd27': path.join(HOME, 'clashd27'),
  'safeclash': path.join(HOME, 'safeclash'),
  'jeeves': path.join(HOME, 'jeeves')
};

const AUDIT_REPOS = ['openclashd-v2', 'clashd27', 'safeclash'];
const SECRET_SCAN_REPOS = ['openclashd-v2', 'clashd27', 'safeclash', 'jeeves'];
const SSL_DOMAINS = ['openclashd.com', 'safeclash.com', 'clashd27.com'];

const SOURCE_EXTENSIONS = new Set([
  '.cjs', '.conf', '.cpp', '.cs', '.go', '.h', '.hpp', '.ini', '.java', '.js',
  '.json', '.jsx', '.kt', '.kts', '.mjs', '.plist', '.properties', '.py', '.rb',
  '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml'
]);

const SECRET_PATTERNS = [
  { type: 'anthropic_env_marker', regex: /ANTHROPIC_[A-Z0-9_]+/g, severity: 'medium' },
  { type: 'api_key_prefix', regex: /sk-[A-Za-z0-9_-]+/g, severity: 'high' },
  { type: 'rsa_private_key_marker', regex: /BEGIN RSA/gi, severity: 'critical' },
  { type: 'password_assignment', regex: /\bpassword\s*=/gi, severity: 'high' },
  { type: 'secret_assignment', regex: /\bsecret\s*=/gi, severity: 'high' },
  { type: 'token_assignment', regex: /\btoken\s*=/gi, severity: 'medium' }
];

const BOUNDARY_PATTERNS = [
  { type: 'shell_execution', regex: /\b(?:execSync|execFileSync|spawnSync|execFile|spawn|fork)\s*\(/g, severity: 'high' },
  { type: 'process_execution', regex: /\bProcess\s*\(/g, severity: 'high' },
  { type: 'governed_execution_token', regex: /\bapproved_(?:write|patch|dispatch|persist)\b/g, severity: 'high' },
  { type: 'direct_execution_token', regex: /\bexecute_change\b|\bexecute_directly\b/g, severity: 'high' },
  { type: 'approval_bypass_token', regex: /\bauto_approve\b/g, severity: 'critical' }
];

function isoNow() {
  return new Date().toISOString();
}

function hashSignal(parts) {
  return crypto
    .createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16);
}

function severityRank(value) {
  switch (String(value || '').toLowerCase()) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function normalizeSeverity(value, fallback = 'low') {
  const normalized = String(value || '').toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function signalTemplate({ signal_type, severity, source, target, detected_at, evidence, remediation_proposal }) {
  return {
    signal_id: hashSignal([signal_type, severity, source, target, evidence, remediation_proposal]),
    signal_type,
    severity,
    source,
    target,
    detected_at,
    evidence,
    remediation_proposal
  };
}

function scannerErrorSignal({ source, target, evidence, detectedAt }) {
  return signalTemplate({
    signal_type: 'scanner_error',
    severity: 'low',
    source,
    target,
    detected_at: detectedAt,
    evidence,
    remediation_proposal: 'Review scanner reachability or local tooling before relying on this finding. No remediation may run automatically.'
  });
}

function relativeTarget(repoName, absolutePath) {
  const repoRoot = REPOS[repoName];
  return path.relative(repoRoot, absolutePath) || path.basename(absolutePath);
}

function shouldSkipDir(entryName) {
  return entryName === 'node_modules'
    || entryName === '.git'
    || entryName === 'data'
    || entryName === 'dist'
    || entryName === 'build'
    || entryName === 'DerivedData'
    || entryName === '.next'
    || entryName === '.turbo'
    || entryName === 'reports';
}

function shouldSkipFile(filePath) {
  const base = path.basename(filePath);
  if (base.startsWith('.env')) {
    return true;
  }
  if (base === 'security-signals.js') {
    return true;
  }
  return false;
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walkSourceFiles(rootDir, visitor) {
  const queue = [rootDir];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          queue.push(absolute);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (shouldSkipFile(absolute) || !isSourceFile(absolute)) {
        continue;
      }

      visitor(absolute);
    }
  }
}

function safeReadText(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    if (data.includes('\u0000')) {
      return null;
    }
    return data;
  } catch (_error) {
    return null;
  }
}

function extractCves(value) {
  const text = JSON.stringify(value || '');
  const matches = text.match(/CVE-\d{4}-\d+/gi) || [];
  return Array.from(new Set(matches.map((match) => match.toUpperCase())));
}

function normalizeFixAvailable(fixAvailable) {
  if (fixAvailable === true) {
    return 'available';
  }
  if (fixAvailable === false || fixAvailable === null || fixAvailable === undefined) {
    return 'not available';
  }
  if (typeof fixAvailable === 'object') {
    if (fixAvailable.name) {
      return `available via ${fixAvailable.name}`;
    }
    return 'available';
  }
  return String(fixAvailable);
}

function extractAuditFindings(repoName, payload, detectedAt) {
  const vulnerabilities = payload && typeof payload === 'object' ? payload.vulnerabilities : null;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    return [];
  }

  const signals = [];
  for (const [packageName, entry] of Object.entries(vulnerabilities)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const via = Array.isArray(entry.via) ? entry.via : [];
    const viaObjects = via.filter((item) => item && typeof item === 'object');
    const highestViaSeverity = viaObjects
      .map((item) => normalizeSeverity(item.severity, 'low'))
      .sort((left, right) => severityRank(right) - severityRank(left))[0];

    const severity = normalizeSeverity(entry.severity || highestViaSeverity, 'medium');
    const cves = extractCves(viaObjects.length > 0 ? viaObjects : via);
    const cveText = cves.length > 0 ? cves.join(', ') : 'none reported';
    const fixAvailability = normalizeFixAvailable(entry.fixAvailable);

    signals.push(signalTemplate({
      signal_type: 'dependency_vulnerability',
      severity,
      source: 'dependency-scanner',
      target: `${repoName}:${packageName}`,
      detected_at: detectedAt,
      evidence: `package ${packageName}; severity ${severity}; cve ${cveText}; fix ${fixAvailability}`,
      remediation_proposal: 'Prepare a governed proposal to inspect the affected package, evaluate patch scope, and apply a bounded update only after explicit approval.'
    }));
  }

  return signals;
}

function scanDependencies(detectedAt) {
  const signals = [];

  for (const repoName of AUDIT_REPOS) {
    const cwd = REPOS[repoName];
    const result = spawnSync('npm', ['audit', '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 20 * 1024 * 1024
    });

    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    let parsed = null;

    if (result.stdout && result.stdout.trim()) {
      try {
        parsed = JSON.parse(result.stdout);
      } catch (_error) {
        parsed = null;
      }
    }

    if (!parsed && raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (_error) {
        parsed = null;
      }
    }

    if (parsed) {
      const findings = extractAuditFindings(repoName, parsed, detectedAt);
      if (findings.length > 0) {
        signals.push(...findings);
        continue;
      }
      if (result.status === 0) {
        continue;
      }
    }

    signals.push(scannerErrorSignal({
      source: 'dependency-scanner',
      target: repoName,
      detectedAt,
      evidence: `npm audit failed in ${repoName} — scanner_error; scan continued for other repositories`
    }));
  }

  return signals;
}

function scanSecrets(detectedAt) {
  const signals = [];

  for (const repoName of SECRET_SCAN_REPOS) {
    walkSourceFiles(REPOS[repoName], (filePath) => {
      const contents = safeReadText(filePath);
      if (!contents) {
        return;
      }

      const lines = contents.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of SECRET_PATTERNS) {
          pattern.regex.lastIndex = 0;
          if (!pattern.regex.test(line)) {
            continue;
          }

          signals.push(signalTemplate({
            signal_type: 'secret_detected',
            severity: pattern.severity,
            source: 'secrets-detector',
            target: `${repoName}:${relativeTarget(repoName, filePath)}`,
            detected_at: detectedAt,
            evidence: `possible match — human review required; line ${index + 1}; pattern ${pattern.type}`,
            remediation_proposal: 'Prepare a governed proposal to inspect the file, validate exposure risk, and rotate or remove the secret only after explicit approval.'
          }));
        }
      });
    });
  }

  return dedupeSignals(signals);
}

function sslSignalSeverity(daysRemaining) {
  if (daysRemaining < 0) {
    return 'critical';
  }
  if (daysRemaining <= 7) {
    return 'high';
  }
  return 'medium';
}

function scanSsl(detectedAt) {
  const signals = [];

  for (const domain of SSL_DOMAINS) {
    const shell = [
      'printf "" |',
      `openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null |`,
      'openssl x509 -noout -enddate 2>/dev/null'
    ].join(' ');

    const result = spawnSync('/bin/sh', ['-lc', shell], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024
    });

    const output = (result.stdout || '').trim();
    const match = output.match(/notAfter=(.+)$/m);

    if (result.status !== 0 || !match) {
      signals.push(scannerErrorSignal({
        source: 'ssl-monitor',
        target: domain,
        detectedAt,
        evidence: 'SSL check failed — network unreachable'
      }));
      continue;
    }

    const expiryDate = new Date(match[1].trim());
    if (Number.isNaN(expiryDate.getTime())) {
      signals.push(scannerErrorSignal({
        source: 'ssl-monitor',
        target: domain,
        detectedAt,
        evidence: 'SSL check failed — certificate expiry unreadable'
      }));
      continue;
    }

    const daysRemaining = Math.floor((expiryDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysRemaining > 30) {
      continue;
    }

    signals.push(signalTemplate({
      signal_type: 'ssl_expiry',
      severity: sslSignalSeverity(daysRemaining),
      source: 'ssl-monitor',
      target: domain,
      detected_at: detectedAt,
      evidence: `certificate expires in ${daysRemaining} day(s)`,
      remediation_proposal: 'Prepare a governed proposal to renew or validate the certificate path; no auto-deploy or auto-rotation is allowed.'
    }));
  }

  return signals;
}

function parseGovernanceMayExecuteFalse(filePath) {
  const text = safeReadText(filePath) || '';
  const roles = [];
  const lines = text.split(/\r?\n/);
  let currentRole = null;
  let inRoles = false;

  for (const line of lines) {
    if (/^roles:\s*$/.test(line.trim())) {
      inRoles = true;
      currentRole = null;
      continue;
    }

    if (inRoles && /^[a-z]/.test(line)) {
      break;
    }

    const roleMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (inRoles && roleMatch) {
      currentRole = roleMatch[1];
      continue;
    }

    if (inRoles && currentRole && /^\s{4}may_execute:\s*false\s*$/.test(line)) {
      roles.push(currentRole);
    }
  }

  return roles;
}

function boundarySeverity(repoName, filePath, patternSeverity) {
  const relative = relativeTarget(repoName, filePath);
  if (relative.startsWith('lib/') || relative.startsWith('src/')) {
    return patternSeverity;
  }
  return patternSeverity === 'critical' ? 'high' : 'medium';
}

function scanBoundaryViolations(detectedAt) {
  const governancePath = path.join(HOME, 'openclashd-v2', 'config', 'governance.yaml');
  const restrictedRoles = parseGovernanceMayExecuteFalse(governancePath);
  const signals = [];
  const skipTargets = new Set([
    path.join(REPOS.clashd27, 'lib', 'security-signals.js')
  ]);

  for (const roleName of restrictedRoles) {
    const repoRoot = REPOS[roleName];
    if (!repoRoot || !fs.existsSync(repoRoot)) {
      continue;
    }

    walkSourceFiles(repoRoot, (filePath) => {
      if (skipTargets.has(filePath)) {
        return;
      }

      const contents = safeReadText(filePath);
      if (!contents) {
        return;
      }

      const lines = contents.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of BOUNDARY_PATTERNS) {
          pattern.regex.lastIndex = 0;
          if (!pattern.regex.test(line)) {
            continue;
          }

          const severity = boundarySeverity(roleName, filePath, pattern.severity);
          signals.push(signalTemplate({
            signal_type: 'boundary_violation',
            severity,
            source: 'config-drift-detector',
            target: `${roleName}:${relativeTarget(roleName, filePath)}`,
            detected_at: detectedAt,
            evidence: `may_execute false repo ${roleName}; line ${index + 1}; pattern ${pattern.type}`,
            remediation_proposal: 'Prepare a governed review to confirm whether this execution-capable code belongs in openclashd-v2 or should remain read-only discovery or operator logic.'
          }));
        }
      });
    });
  }

  return dedupeSignals(signals);
}

function dedupeSignals(signals) {
  const seen = new Set();
  const deduped = [];
  for (const signal of signals) {
    if (seen.has(signal.signal_id)) {
      continue;
    }
    seen.add(signal.signal_id);
    deduped.push(signal);
  }
  return deduped.sort((left, right) => {
    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.signal_id.localeCompare(right.signal_id);
  });
}

function runSecurityScan() {
  const detectedAt = isoNow();
  const signals = [
    ...scanDependencies(detectedAt),
    ...scanSecrets(detectedAt),
    ...scanSsl(detectedAt),
    ...scanBoundaryViolations(detectedAt)
  ];

  return dedupeSignals(signals);
}

module.exports = {
  REPORT_BASE,
  REPOS,
  runSecurityScan
};

if (require.main === module) {
  const signals = runSecurityScan();
  process.stdout.write(`${JSON.stringify(signals, null, 2)}\n`);
}
