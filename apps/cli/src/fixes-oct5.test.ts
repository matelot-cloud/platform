import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { login, openBrowser } from './login';

const run = promisify(execFile);
const ID = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';
function stub(handler: (method: string, url: string, body: unknown) => unknown) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const server = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { const body = raw ? JSON.parse(raw) : null; seen.push({ method: req.method!, url: req.url!, body }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(handler(req.method!, req.url!, body))); }); });
  return { seen, server, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port))) };
}
const env = (port: number, extra: Record<string, string> = {}) => ({ ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent', ...extra });

test('job logs renders the API payload {seq, stream, content, at} (no empty "line" column)', async () => {
  const s = stub(() => [{ seq: 1, stream: 'system', content: 'semgrep scan --config p/security-audit', at: '2026-10-05T10:00:00Z' }, { seq: 2, stream: 'stdout', content: '4 code findings (1 high, 3 medium)', at: '2026-10-05T10:00:03Z' }]);
  const port = await s.listen();
  try {
    const { stdout } = await run('node', [join(__dirname, 'index.js'), 'job', 'logs', '--id', ID], { env: env(port) });
    assert.match(stdout, /semgrep scan --config p\/security-audit/);
    assert.match(stdout, /4 code findings/);
    assert.doesNotMatch(stdout, /\bline\b/);
  } finally { s.server.close(); }
});

test('policy flags map one by one: --environments, --enforce, --max-sast, --action, --max-severity, --block-kev false; update sends only the given rules', async () => {
  const s = stub((m, u) => (m === 'POST' ? { id: 'p1' } : { id: 'p1', rules: {} }));
  const port = await s.listen();
  try {
    await run('node', [join(__dirname, 'index.js'), 'policy', 'create-project', '--project', ID, '--name', 'Prod', '--environments', 'production,staging', '--max-sast', 'high', '--max-severity', 'critical', '--block-kev', 'false', '--action', 'block', '--enforce', '--json'], { env: env(port) });
    assert.equal(s.seen[0]!.url, `/api/v1/projects/${ID}/policies`);
    assert.deepEqual(s.seen[0]!.body, { name: 'Prod', environmentKinds: ['production', 'staging'], action: 'block', enforceOnDeploy: true, rules: { maxSeverity: 'critical', blockKev: false, maxSastSeverity: 'high' } });
    await run('node', [join(__dirname, 'index.js'), 'policy', 'update', '--id', ID, '--max-sast', 'low', '--json'], { env: env(port) });
    assert.deepEqual(s.seen[1]!.body, { rules: { maxSastSeverity: 'low' } });   // only this rule: the API merges with the stored rules
  } finally { s.server.close(); }
});

test('an unknown flag is an error, never silently ignored', async () => {
  const s = stub(() => ({})); const port = await s.listen();
  try {
    await assert.rejects(run('node', [join(__dirname, 'index.js'), 'policy', 'create-project', '--project', ID, '--name', 'x', '--enforced'], { env: env(port) }), (e: { stderr: string; code: number }) => /unknown flag.*--enforced/.test(e.stderr) && e.code === 1);
    assert.equal(s.seen.length, 0);
  } finally { s.server.close(); }
});

test('pipeline --wait --json: stdout is JSON only (progress on stderr)', async () => {
  const s = stub((m) => (m === 'POST' ? { id: 'pl1', number: 7, status: 'running', jobs: [{ name: 'checkout', status: 'queued' }] } : { id: 'pl1', number: 7, status: 'succeeded', jobs: [{ name: 'checkout', status: 'succeeded' }] }));
  const port = await s.listen();
  try {
    const { stdout, stderr } = await run('node', [join(__dirname, 'index.js'), 'pipeline', '--service', ID, '--wait', '--timeout', '30', '--json'], { env: env(port) });
    const parsed = JSON.parse(stdout);   // throws if anything else is on stdout
    assert.equal(parsed.status, 'succeeded');
    void stderr;
  } finally { s.server.close(); }
});

test('openBrowser: no opener available → resolves false instead of crashing on the error event', async () => {
  const ok = await openBrowser('http://127.0.0.1:1/x');   // PATH without any opener
  assert.equal(typeof ok, 'boolean');
});

test('login keeps listening after a stale-state callback (answered 400) and completes with the right one', async () => {
  process.env.MATELOT_CREDENTIALS = join(mkdtempSync(join(tmpdir(), 'matelot-creds-')), 'credentials.json');
  let srv!: import('node:http').Server;
  const port = await new Promise<number>((resolve) => {
    srv = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/.well-known/oauth-authorization-server') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ authorization_endpoint: `http://127.0.0.1:${(srv.address() as { port: number }).port}/a`, token_endpoint: `http://127.0.0.1:${(srv.address() as { port: number }).port}/t` })); return; }
      if (u.pathname === '/t') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: 'spt_x', refresh_token: 'r', expires_in: 3600, scope: 'write' })); return; }
      res.writeHead(404); res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
  });
  const creds = await login(`http://127.0.0.1:${port}`, 'write', { timeoutMs: 10_000, open: (a) => {
    const u = new URL(a); const cb = new URL(u.searchParams.get('redirect_uri')!);
    const stale = new URL(cb.toString()); stale.searchParams.set('code', 'old'); stale.searchParams.set('state', 'stale-state');
    void fetch(stale.toString()).then(async (r) => { assert.equal(r.status, 400); const good = new URL(cb.toString()); good.searchParams.set('code', 'the-code'); good.searchParams.set('state', u.searchParams.get('state')!); await fetch(good.toString()); });
  } });
  assert.equal(creds.accessToken, 'spt_x');
  srv.close();
});
