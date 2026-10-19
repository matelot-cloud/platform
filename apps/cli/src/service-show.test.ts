import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = `${__dirname}/index.js`;
const SVC = '6e6a3c53-7b9a-4e1e-9b0e-2c1f7c0a0002';
const summary = {
  id: SVC, slug: 'checkout', name: 'Checkout service', kind: 'api', criticality: 'HIGH', projectId: 'p1',
  latestPipeline: { id: 'pl1', number: 12, status: 'failed', ref: 'main', commitSha: 'abcdef1234567', createdAt: '2026-10-16T17:00:00.000Z', finishedAt: '2026-10-16T17:04:30.000Z', jobs: [{ name: 'checkout', status: 'succeeded' }, { name: 'sbom', status: 'succeeded' }, { name: 'secrets', status: 'failed', error: 'trivy failed (1): no output' }, { name: 'evaluate', status: 'skipped' }] },
  findings: { open: { critical: 1, high: 4, medium: 9, low: 2, unknown: 0, total: 16 }, kev: 1 },
  codeFindings: { open: { secret: 1, iac: 3, sast: 3 }, rules: [{ kind: 'sast', ruleId: 'python.lang.security.audit.eval-detected.eval-detected', n: 3 }, { kind: 'iac', ruleId: 'DS002', n: 2 }, { kind: 'iac', ruleId: 'DS026', n: 1 }, { kind: 'secret', ruleId: 'github-pat', n: 1 }] },
  latestSbom: { id: 's1', target: 'source', targetRef: 'main', componentCount: 212, createdAt: '2026-10-16T17:02:00.000Z' },
};

test('matelot service show: one call (GET /services/:id/summary), latest pipeline + open findings as text, the object with --json', async () => {
  const urls: string[] = [];
  const server = createServer((req, res) => { urls.push(req.url!); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(summary)); });
  await new Promise<void>((d) => server.listen(0, '127.0.0.1', () => d()));
  const env = { ...process.env, TZ: 'Europe/Bucharest', MATELOT_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, MATELOT_TOKEN: 'spt_x', MATELOT_KEY_ID: '', MATELOT_SECRET: '', MATELOT_CREDENTIALS: '/nonexistent' };
  try {
    const { stdout } = await run('node', [cli, 'service', 'show', '--service', SVC], { env });
    assert.deepEqual(urls, [`/api/v1/services/${SVC}/summary`]);
    assert.equal(stdout, [
      `Checkout service (checkout, api, HIGH criticality)  id ${SVC}`,
      'pipeline #12: failed on main @ abcdef1 (2026-10-16 20:04+03:00) — checkout succeeded, sbom succeeded, secrets failed, evaluate skipped',   // local time with its offset, never bare UTC
      '  secrets: trivy failed (1): no output',
      'open findings: 16 (1 critical, 4 high, 9 medium, 2 low) · 1 known-exploited',
      'open code findings: 1 secrets (github-pat), 3 infrastructure (DS002 ×2, DS026), 3 code (eval-detected ×3)',   // "×3" of one rule = the same issue re-opened per run
      'latest SBOM: source main — 212 components (2026-10-16 20:02+03:00)',
      '',
    ].join('\n'));
    const j = JSON.parse((await run('node', [cli, 'service', 'show', '--service', SVC, '--json'], { env })).stdout);
    assert.equal(j.findings.open.total, 16); assert.equal(j.latestPipeline.number, 12);
  } finally { server.close(); }
});
