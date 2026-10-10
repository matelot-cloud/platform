import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const ENV = '63ba23b5-03ef-4565-adcc-52c25f6e5342';
function runCli(args: string[], port: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile('node', [join(__dirname, 'index.js'), ...args], { env: { ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test', CI: '' } }, (err, stdout, stderr) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr }));
  });
}
/** Stub gate: the API "waits" waitCorrelation and answers done (real result) or pending (counts withheld). */
function stub(mode: 'done-after-wait' | 'pending' | 'failed' | 'no_sbom' | 'done-on-third') {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}; bodies.push(body);
      const json = (o: unknown) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === `/api/v1/environments/${ENV}/gate`) {
        if ((mode === 'done-after-wait' && body.waitCorrelation > 0) || (mode === 'done-on-third' && bodies.length >= 3)) return json({ result: 'fail', pending: false, correlation: { status: 'done', error: null, waitedMs: 4200 }, policies: [{ name: 'Production baseline' }], violations: [{ policyName: 'Production baseline', action: 'block', message: 'max severity high exceeded: 11 high' }], facts: { sbomId: 's1', findings: { critical: 0, high: 11, medium: 3, low: 0, unknown: 0 }, kevOpen: 0, secretsOpen: 0 } });
        return json({ result: 'fail', pending: true, correlation: { status: mode === 'failed' ? 'failed' : mode === 'no_sbom' ? 'no_sbom' : 'pending', error: mode === 'failed' ? 'OSV 503' : null, waitedMs: body.waitCorrelation * 1000 }, policies: [{ name: 'Production baseline' }], violations: [{ policyName: 'Matelot', action: 'block', message: 'SBOM not correlated yet' }], facts: { sbomId: 's1', findings: null, kevOpen: null, secretsOpen: 0 } });
      }
      res.writeHead(404); res.end();
    });
  });
  return { server, bodies, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port))) };
}

test('gate right after an SBOM upload waits for correlation and returns the real result (exit 2 here: a real violation)', async () => {
  const s = stub('done-after-wait'); const port = await s.listen();
  try {
    const r = await runCli(['gate', '--env', ENV, '--image', 'reg/demo@sha256:' + 'a'.repeat(64), '--wait-correlation', '300'], port);
    assert.equal(s.bodies[0]!.waitCorrelation, 25); // a 300 s budget is asked for in 25 s slices
    assert.match(r.stdout, /gate: FAIL .*critical 0 · high 11/);
    assert.equal(r.code, 2);
  } finally { s.server.close(); }
});

test('still pending at the timeout → exit 3, no partial counts printed', async () => {
  const s = stub('pending'); const port = await s.listen();
  try {
    const r = await runCli(['gate', '--env', ENV, '--image', 'reg/demo@sha256:' + 'a'.repeat(64), '--wait-correlation', '5'], port);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /gate: PENDING .*not finished after 5s/);
    assert.doesNotMatch(r.stdout, /critical \d|high \d/);
  } finally { s.server.close(); }
});

test('correlation failed → exit 3 with the error', async () => {
  const s = stub('failed'); const port = await s.listen();
  try {
    const r = await runCli(['gate', '--env', ENV, '--image', 'reg/demo@sha256:' + 'a'.repeat(64)], port);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /failed \(OSV 503\)/);
    assert.equal(s.bodies[0]!.waitCorrelation, 0); // not CI, no flag → evaluate now
  } finally { s.server.close(); }
});

test('the budget is spent in ≤ 25 s server slices (ingress-safe) and stops once correlated', async () => {
  const s = stub('done-on-third'); const port = await s.listen();
  try {
    const r = await runCli(['gate', '--env', ENV, '--image', 'reg/demo@sha256:' + 'a'.repeat(64), '--wait-correlation', '300'], port);
    assert.equal(r.code, 2);                                           // real result after the 3rd slice (a real violation)
    assert.equal(s.bodies.length, 3);
    assert.ok(s.bodies.every((b) => Number(b.waitCorrelation) <= 25), 'never asks the server to hold a request > 25 s');
    assert.match(r.stderr, /waiting for SBOM correlation/);
  } finally { s.server.close(); }
});

test('no SBOM for the image after the budget → exit 3 "nothing scanned", never a pass', async () => {
  const s = stub('no_sbom'); const port = await s.listen();
  try {
    const r = await runCli(['gate', '--env', ENV, '--image', 'reg/demo@sha256:' + 'a'.repeat(64), '--wait-correlation', '1'], port);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /no SBOM for this image after 1s/);
    assert.match(r.stderr, /waiting for the image SBOM/);
  } finally { s.server.close(); }
});

test('exit 4 for an authentication failure (was 3 before 2.9.0)', async () => {
  const server = createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Unauthorized', statusCode: 401 })); });
  const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port)));
  try { assert.equal((await runCli(['gate', '--env', ENV, '--version', '1.0.0'], port)).code, 4); } finally { server.close(); }
});
