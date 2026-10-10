import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const ORG = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';
const env = (port: number) => ({ ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' });

test('matelot onboarding prints the checklist and the next command; dismiss / restore', async () => {
  let dismissedAt: string | null = null;
  const seen: string[] = [];
  const steps = [
    { id: 'connect_source', title: 'Connect your source code', done: true, cli: 'matelot connection create', detail: '1 connection' },
    { id: 'attach_repository', title: 'Attach a repository to a service', done: false, cli: 'matelot repository attach --service <id> --repository-id <id>', detail: '0 of 1 service' },
    { id: 'notifications', title: 'Send alerts somewhere', done: false, cli: null, detail: null, optional: true },
  ];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith('/dismiss')) dismissedAt = '2026-10-08T15:00:00Z';
    if (req.url?.endsWith('/restore')) dismissedAt = null;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ steps, completed: 1, total: 3, complete: false, dismissedAt, next: steps[1] })); });
  });
  const port = await new Promise<number>((ok) => server.listen(0, () => ok((server.address() as { port: number }).port)));
  const cli = join(__dirname, 'index.js');
  try {
    const out = (await run('node', [cli, 'onboarding', '--org', ORG], { env: env(port) })).stdout;
    assert.match(out, /^setup 1\/3\n/);
    assert.match(out, /\[x\] Connect your source code {2}— 1 connection/);
    assert.match(out, /\[ \] Attach a repository to a service {2}— 0 of 1 service/);
    assert.match(out, /\[ \] Send alerts somewhere \(optional\)/);
    assert.match(out, /next: Attach a repository to a service\n {2}matelot repository attach --service <id> --repository-id <id>/);
    const hidden = (await run('node', [cli, 'onboarding', 'dismiss', '--org', ORG], { env: env(port) })).stdout;
    assert.equal(hidden.split('\n')[0], 'setup 1/3 — checklist hidden on the Overview'); // said once, not twice
    assert.equal((await run('node', [cli, 'onboarding', '--org', ORG], { env: env(port) })).stdout.split('\n')[0], 'setup 1/3 — checklist hidden on the Overview');
    const shown = (await run('node', [cli, 'onboarding', 'restore', '--org', ORG], { env: env(port) })).stdout;
    assert.equal(shown.split('\n')[0], 'setup 1/3 — checklist shown on the Overview');
    assert.deepEqual(seen, [`GET /api/v1/organizations/${ORG}/onboarding`, `POST /api/v1/organizations/${ORG}/onboarding/dismiss`, `GET /api/v1/organizations/${ORG}/onboarding`, `POST /api/v1/organizations/${ORG}/onboarding/restore`]);
    const json = JSON.parse((await run('node', [cli, 'onboarding', '--org', ORG, '--json'], { env: env(port) })).stdout);
    assert.equal(json.total, 3);
  } finally { server.close(); }
});

test('matelot onboarding: a completed organization prints the completion date', async () => {
  const steps = [{ id: 'policy', title: 'Put a policy in force', done: true, cli: null, detail: '1 policy' }];
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ steps, completed: 10, total: 10, complete: true, completedAt: '2026-10-08T15:42:18Z', dismissedAt: '2026-10-08T15:00:00Z', next: null })); }); });
  const port = await new Promise<number>((ok) => server.listen(0, () => ok((server.address() as { port: number }).port)));
  try {
    const out = (await run('node', [join(__dirname, 'index.js'), 'onboarding', '--org', ORG], { env: env(port) })).stdout;
    assert.equal(out.split('\n')[0], 'setup 10/10 — setup completed 2026-10-08'); // a dismissal before completion no longer matters
  } finally { server.close(); }
});
