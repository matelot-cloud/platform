import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const ORG = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';
const env = (port: number) => ({ ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' });
const metrics = (active: number, mins: number) => ({ seats: { active, members: 9 }, projects: 3, services: 7, environments: 12, pipelines: 41, jobs: 236, runnerMinutes: mins, runnerMinutesByType: { sbom: 120.5, sast: 33 }, sboms: 58 });

function serve(handler: (url: string, n: number) => { status?: number; headers?: Record<string, string>; body: unknown }) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    const r = handler(req.url!, seen.length);
    res.writeHead(r.status ?? 200, { 'content-type': typeof r.body === 'string' ? 'text/csv' : 'application/json', ...(r.headers ?? {}) });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  return { seen, server, listen: () => new Promise<number>((ok) => server.listen(0, () => ok((server.address() as { port: number }).port))) };
}

test('matelot usage prints the month and its history; --month, --format csv and --json', async () => {
  const s = serve((url) => url.includes('format=csv')
    ? { body: 'month,seats_active\n2026-09,5\n' }
    : { body: { organizationId: ORG, month: url.includes('2026-09') ? '2026-09' : '2026-10', live: !url.includes('2026-09'), computedAt: '2026-10-07T12:00:00Z', metrics: metrics(6, 153.5), history: [{ month: '2026-10', final: false, metrics: metrics(6, 153.5) }, { month: '2026-09', final: true, metrics: metrics(5, 412) }] } });
  const port = await s.listen();
  const cli = join(__dirname, 'index.js');
  try {
    const out = (await run('node', [cli, 'usage', '--org', ORG], { env: env(port) })).stdout;
    assert.match(out, /^usage 2026-10 \(live, UTC calendar month\)/);
    assert.match(out, /active seats\s+6 of 9 members/);
    assert.match(out, /runner minutes\s+153\.5 {2}\(sbom 120\.5, sast 33\)/);
    assert.match(out, /2026-09\s+5\s+412\s+41/);
    assert.equal(s.seen[0], `/api/v1/organizations/${ORG}/usage`);

    await run('node', [cli, 'usage', '--org', ORG, '--month', '2026-09'], { env: env(port) });
    assert.equal(s.seen[1], `/api/v1/organizations/${ORG}/usage?month=2026-09`);

    const csv = (await run('node', [cli, 'usage', 'show', '--org', ORG, '--format', 'csv'], { env: env(port) })).stdout;
    assert.equal(csv, 'month,seats_active\n2026-09,5\n');

    const json = JSON.parse((await run('node', [cli, 'usage', '--org', ORG, '--json'], { env: env(port) })).stdout);
    assert.equal(json.metrics.seats.active, 6);
  } finally { s.server.close(); }
});

test('429: waits for Retry-After and repeats the request (also a write); gives up after 3 retries', async () => {
  const s = serve((url, n) => (url.startsWith('/api/v1/integrations/') && n <= 2
    ? { status: 429, headers: { 'retry-after': '1' }, body: { statusCode: 429, message: 'Rate limit exceeded: 300 write requests per minute for this user. Retry in 1 s.' } }
    : url.startsWith('/api/v1/integrations/') ? { body: { id: 'x', name: 'c', status: 'disconnected' } } : { status: 429, headers: { 'retry-after': '0' }, body: { statusCode: 429, message: 'Rate limit exceeded: 1200 read requests per minute for this user. Retry in 1 s.' } }));
  const port = await s.listen();
  const cli = join(__dirname, 'index.js');
  try {
    const ok = await run('node', [cli, 'connection', 'disconnect', '--id', '9b7e2f8a-1c2d-4e5f-8a9b-0c1d2e3f4a5b'], { env: env(port) });
    assert.equal(ok.stdout.trim(), 'disconnected c');
    assert.equal((ok.stderr.match(/rate limited by the platform; retrying in 1 s/g) ?? []).length, 2);
    const before = s.seen.length;
    await assert.rejects(run('node', [cli, 'usage', '--org', ORG], { env: env(port) }), (e: { stderr: string }) => { assert.match(e.stderr, /429 Rate limit exceeded: 1200 read requests per minute/); return true; });
    assert.equal(s.seen.length - before, 4); // first try + 3 retries
  } finally { s.server.close(); }
});
