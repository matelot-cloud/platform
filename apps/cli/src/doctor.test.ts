import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const ORG = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';
const cli = join(__dirname, 'index.js');

function serve(runnersOnline: boolean, discovery: 'ok' | 'html' | 'wrong-origin' = 'ok') {
  const server = createServer((req, res) => {
    const u = req.url!;
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u === '/.well-known/oauth-authorization-server') {
      if (discovery === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!DOCTYPE html><html></html>'); }
      const base = discovery === 'wrong-origin' ? 'http://localhost:3000' : `http://${req.headers.host}`;
      return json(200, { issuer: base, authorization_endpoint: `${base}/api/v1/oauth/authorize`, token_endpoint: `${base}/api/v1/oauth/token` });
    }
    if (u === '/api/v1/health/ready') return json(200, { status: 'ok' });
    if (u === '/api/v1/version') return json(200, { name: 'matelot', version: '0.1.0' });
    if (u === '/api/v1/meta') return json(401, { message: 'Unauthorized' });
    if (!req.headers.authorization) return json(401, { message: 'Unauthorized' });
    if (u === '/api/v1/api-tokens/whoami') return json(200, { kind: 'user', email: 'admin@localhost' });
    if (u === '/api/v1/organizations') return json(200, [{ id: ORG, slug: 'main', name: 'My organization' }]);
    if (u === `/api/v1/organizations/${ORG}/runner-pools`) return json(200, [{ name: 'Managed', managed: true, runners: [{ name: 'compose-runner-1', status: runnersOnline ? 'online' : 'offline' }] }]);
    if (u === '/api/v1/registry/info') return json(200, { available: true, host: 'localhost:5000' });
    json(404, { message: 'not found' });
  });
  return new Promise<{ port: number; close: () => void }>((done) => server.listen(0, () => done({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

test('matelot doctor: all checks pass, runner offline fails, no credentials skips the authenticated checks', async () => {
  const s = await serve(true);
  try {
    const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${s.port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
    const { stdout } = await run('node', [cli, 'doctor'], { env });
    assert.match(stdout, /OK {2}api +http:\/\/127\.0\.0\.1:\d+ ready/);
    assert.match(stdout, /OK {2}version +API 0\.1\.0 · CLI /);
    assert.match(stdout, /OK {2}discovery +endpoints on http:\/\/127\.0\.0\.1:\d+ \(matelot login will work\)/);
    assert.match(stdout, /OK {2}login +user admin@localhost/);
    assert.match(stdout, /OK {2}organization +main/);
    assert.match(stdout, /OK {2}runners +1 online \(compose-runner-1\)/);
    assert.match(stdout, /OK {2}registry +localhost:5000 \(matelot registry login\)/);
    assert.match(stdout, /all checks passed/);
    const j = JSON.parse((await run('node', [cli, 'doctor', '--json'], { env })).stdout);
    assert.equal(j.ok, true); assert.equal(j.checks.length, 7);

    // without credentials: the three unauthenticated checks run, the rest is skipped (exit 0)
    const noCreds = { ...process.env, MATELOT_URL: `http://127.0.0.1:${s.port}`, MATELOT_TOKEN: '', MATELOT_KEY_ID: '', MATELOT_SECRET: '', SECOPS_TOKEN: '', MATELOT_CREDENTIALS: '/nonexistent' };
    const r = await run('node', [cli, 'doctor'], { env: noCreds });
    assert.match(r.stdout, /--  login +skipped:/);
    assert.doesNotMatch(r.stdout, /registry/);
  } finally { s.close(); }

  for (const [mode, re] of [['html', /FAIL {2}discovery +\/\.well-known\/oauth-authorization-server returned HTML \(the web app\)/], ['wrong-origin', /FAIL {2}discovery +the cell advertises http:\/\/localhost:3000 but you connected to http:\/\/127\.0\.0\.1:\d+ — check API_PUBLIC_URL/]] as const) {
    const d = await serve(true, mode);
    try {
      const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${d.port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
      await assert.rejects(run('node', [cli, 'doctor'], { env }), (e: { code: number; stdout: string }) => { assert.equal(e.code, 1); assert.match(e.stdout, re); return true; });
    } finally { d.close(); }
  }
  const off = await serve(false);
  try {
    const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${off.port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
    await assert.rejects(run('node', [cli, 'doctor'], { env }), (e: { code: number; stdout: string }) => { assert.equal(e.code, 1); assert.match(e.stdout, /FAIL {2}runners +no runner online/); assert.match(e.stdout, /1 check\(s\) failed/); return true; });
  } finally { off.close(); }

  // unreachable
  await assert.rejects(run('node', [cli, 'doctor', '--url', 'http://127.0.0.1:1'], { env: { ...process.env, MATELOT_CREDENTIALS: '/nonexistent' } }), (e: { code: number; stdout: string }) => { assert.equal(e.code, 1); assert.match(e.stdout, /FAIL {2}api +http:\/\/127\.0\.0\.1:1 unreachable/); return true; });

  // unreachable in a Docker Compose folder: the failing container is named, with its exit code and the logs command
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'doctor-compose-'));
  writeFileSync(join(dir, 'compose.yaml'), 'services: {}\n');
  writeFileSync(join(dir, 'docker'), '#!/bin/sh\ncat <<EOF\n{"Service":"api","State":"restarting","Health":"","ExitCode":127}\n{"Service":"postgres","State":"running","Health":"healthy","ExitCode":0}\n{"Service":"init","State":"exited","Health":"","ExitCode":0}\n{"Service":"worker","State":"created","Health":"","ExitCode":0}\nEOF\n');
  chmodSync(join(dir, 'docker'), 0o755);
  await assert.rejects(run('node', [cli, 'doctor', '--url', 'http://127.0.0.1:1'], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MATELOT_CREDENTIALS: '/nonexistent' } }), (e: { code: number; stdout: string }) => {
    assert.match(e.stdout, /FAIL {2}compose\/api +restarting \(exit 127\) — see docker compose logs api/);
    assert.match(e.stdout, /FAIL {2}compose\/worker +created — see docker compose logs worker/);
    assert.doesNotMatch(e.stdout, /compose\/postgres|compose\/init/);
    return true;
  });
});
