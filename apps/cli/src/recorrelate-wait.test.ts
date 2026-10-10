import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const ORG = '7f59de14-baf6-42c1-b8c5-fd5f28e86e62';

/** Stub API: POST recorrelate → queued job; GET …/correlation/jobs/:id → running, running, done. Scoped routes only. */
function stub() {
  let polls = 0; const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === `/api/v1/organizations/${ORG}/findings/recorrelate`) return json(201, { jobId: 'job-1', status: 'queued', position: 1, result: null, error: null });
    if (req.method === 'GET' && req.url === `/api/v1/organizations/${ORG}/correlation/jobs/job-1`) {
      polls++;
      return json(200, polls < 3 ? { jobId: 'job-1', status: 'running', position: 0, result: null, error: null } : { jobId: 'job-1', status: 'done', position: 0, result: { checked: 12, newAdvisories: 3, findingsOpened: 2, findingsFixed: 1 }, error: null });
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/v1/correlation/jobs/')) return json(400, { message: 'Request does not identify a scope', statusCode: 400 }); // the old unscoped route
    json(404, { message: `unexpected ${req.method} ${req.url}` });
  });
  return { server, seen, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port))) };
}

test('matelot vulnerabilities recorrelate --org ID --wait polls the scoped job route until done', async () => {
  const s = stub(); const port = await s.listen();
  try {
    const { stdout } = await run('node', [join(__dirname, 'index.js'), 'vulnerabilities', 'recorrelate', '--org', ORG, '--wait'], { env: { ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test' } });
    assert.match(stdout, /correlation done: checked 12 components, 3 new advisories, 2 opened, 1 fixed/);
    assert.ok(s.seen.filter((x) => x.startsWith('GET /api/v1/organizations/')).length >= 3, 'polled the scoped route');
    assert.ok(!s.seen.some((x) => x.startsWith('GET /api/v1/correlation/jobs/')), 'never used the unscoped route');
  } finally { s.server.close(); }
});

test('without --wait it returns the job id immediately', async () => {
  const s = stub(); const port = await s.listen();
  try {
    const { stdout } = await run('node', [join(__dirname, 'index.js'), 'vulnerabilities', 'recorrelate', '--org', ORG], { env: { ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test' } });
    assert.match(stdout, /correlation queued \(position 1\): job job-1/);
    assert.equal(s.seen.length, 1);
  } finally { s.server.close(); }
});
