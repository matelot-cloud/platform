import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemgrep } from './code-scan';

test('parseSemgrep: severity from security-severity/impact/level, repo-relative path, stable fingerprint, CWE references', () => {
  const report = {
    results: [
      { check_id: 'python.lang.security.audit.dangerous-subprocess-use', path: '/ws/repo/app/run.py', start: { line: 12 }, end: { line: 12 }, extra: { message: 'Detected subprocess with shell=True.\nThis can lead to injection.', severity: 'ERROR', lines: '    subprocess.call(cmd, shell=True)', metadata: { cwe: ['CWE-78: OS Command Injection'], references: ['https://semgrep.dev/r/python.lang.security.audit.dangerous-subprocess-use'], impact: 'HIGH' } } },
      { check_id: 'generic.secrets.security.detected-private-key', path: '/ws/repo/k.pem', start: { line: 1 }, extra: { message: 'Private key', severity: 'WARNING', lines: '-----BEGIN RSA PRIVATE KEY-----', metadata: { 'security-severity': '9.1' } } },
      { check_id: 'style.something', path: '/ws/repo/x.js', extra: { message: 'info only', severity: 'INFO' } },
    ],
  };
  const f = parseSemgrep(report, '/ws/repo');
  assert.equal(f.length, 3);
  assert.deepEqual([f[0]!.kind, f[0]!.file, f[0]!.severity, f[0]!.startLine, f[0]!.title], ['sast', 'app/run.py', 'high', 12, 'Detected subprocess with shell=True.']);
  assert.ok(f[0]!.references.some((r) => r.includes('cwe.mitre.org/data/definitions/78')));
  assert.equal(f[0]!.category, 'CWE-78: OS Command Injection');
  assert.equal(f[1]!.severity, 'critical');          // security-severity 9.1 wins over WARNING
  assert.equal(f[2]!.severity, 'low');
  assert.equal(f[0]!.fingerprint, parseSemgrep(report, '/ws/repo')[0]!.fingerprint);   // stable
  assert.notEqual(f[0]!.fingerprint, f[1]!.fingerprint);
});

test('title truncates at a word boundary; a bare autofix token is rendered in context or omitted', async () => {
  const { truncate, suggestedFix } = await import('./code-scan');
  const long = 'Detected subprocess with shell=True which can lead to command injection when the input is not sanitized properly before use'.repeat(3);
  const t = truncate(long, 200);
  assert.ok(t.length <= 200 && t.endsWith('…'), t);
  assert.ok(long.startsWith(t.slice(0, -1)) && long[t.length - 1] === ' ', 'cut exactly at a word boundary');
  assert.equal(suggestedFix('False', '    subprocess.call(cmd, shell=True)'), 'Suggested fix: shell=False (instead of shell=True)');
  assert.equal(suggestedFix('False', ''), null);
  assert.match(suggestedFix('subprocess.run(cmd, shell=False, check=True)', 'subprocess.call(cmd, shell=True)')!, /Suggested fix: subprocess.run/);
});
