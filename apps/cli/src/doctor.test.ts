import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const ORG = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';
const cli = join(__dirname, 'index.js');

function serve(runnersOnline: boolean, discovery: 'ok' | 'html' | 'wrong-origin' = 'ok', observability: 'none' | 'ok' | 'failing' | 'forbidden' = 'none') {
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
    if (u === '/api/v1/admin/observability/test-otlp' && req.method === 'POST') return json(200, { traceId: 'a'.repeat(32), traces: { attempted: true, ok: observability !== 'failing', error: observability === 'failing' ? 'connect ECONNREFUSED 10.0.0.9:4318' : null }, logs: { attempted: false, ok: false, error: 'OTLP logs are off (OTEL_LOGS_EXPORTER unset)' } });
    if (u === '/api/v1/admin/observability') {
      if (observability === 'none') return json(404, { message: 'Cannot GET /api/v1/admin/observability' });
      if (observability === 'forbidden') return json(403, { message: 'Observability settings are for cell administrators' });
      const now = new Date().toISOString(); const failing = observability === 'failing';
      return json(200, { cell: 'acme', environment: 'production', metrics: { enabled: true, port: 9464, lastScrapeAt: now }, tracing: { enabled: true, exporter: 'otlp', endpoint: 'http://otel-collector:4318/v1/traces', protocol: 'http/protobuf', headers: ['Authorization=••••'], sampler: 'parentbased_always_on', getRatio: 0.1, lastSpanAt: now, exportFailures: failing ? 3 : 0, lastExportError: failing ? 'connect ECONNREFUSED 10.0.0.9:4318' : null }, logs: { enabled: true, exporter: 'otlp', endpoint: 'http://otel-collector:4318/v1/logs', emitted: { audit: 5, security: 1 } }, grafana: { url: 'https://grafana.example.com' }, components: { api: { metricsScrapedAt: now }, worker: { metricsScrapedAt: now }, runners: { online: 1, reporting: 1, metricsScrapedAt: null, tracing: 1 } }, generatedAt: now });
    }
    json(404, { message: 'not found' });
  });
  return new Promise<{ port: number; close: () => void }>((done) => server.listen(0, () => done({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

/** An HTTPS stub signed by a throw-away CA (openssl), like a kind cell with cert-manager's self-signed issuer. */
async function serveTls() {
  const dir = mkdtempSync(join(tmpdir(), 'matelot-tls-'));
  const sh = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=matelot test CA']);
  sh(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost']);
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  sh(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.crt', '-days', '2', '-extfile', 'ext.cnf']);
  const server = createHttpsServer({ key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.crt')) }, (req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/v1/health/ready') return json(200, { status: 'ok' });
    if (req.url === '/api/v1/version') return json(200, { name: 'matelot', version: '0.1.0' });
    if (req.url === '/.well-known/oauth-authorization-server') { const base = `https://${req.headers.host}`; return json(200, { issuer: base, authorization_endpoint: `${base}/api/v1/oauth/authorize`, token_endpoint: `${base}/api/v1/oauth/token` }); }
    json(404, {});
  });
  return new Promise<{ port: number; caFile: string; close: () => void }>((done) => server.listen(0, '127.0.0.1', () => done({ port: (server.address() as { port: number }).port, caFile: join(dir, 'ca.crt'), close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } })));
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
    assert.match(stdout, /--  observability +skipped: API older than this CLI/);   // the stub has no /admin/observability
    assert.match(stdout, /all checks passed/);
    const j = JSON.parse((await run('node', [cli, 'doctor', '--json'], { env })).stdout);
    assert.equal(j.ok, true); assert.equal(j.checks.length, 8);
    // every line goes to stdout, so `matelot doctor | grep version` finds it (nothing on stderr)
    const piped = await run('sh', ['-c', `node "${cli}" doctor | grep version`], { env });
    assert.match(piped.stdout, /^ {2}OK {2}version +API 0\.1\.0 · CLI \d+\.\d+\.\d+\n$/);
    assert.equal((await run('node', [cli, 'doctor'], { env })).stderr, '');

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

  // unreachable: the version line is still printed, as skipped, so `doctor | grep version` always has a line
  await assert.rejects(run('node', [cli, 'doctor', '--url', 'http://127.0.0.1:1'], { env: { ...process.env, MATELOT_CREDENTIALS: '/nonexistent' } }), (e: { code: number; stdout: string }) => { assert.equal(e.code, 1); assert.match(e.stdout, /FAIL {2}api +http:\/\/127\.0\.0\.1:1 unreachable/); assert.match(e.stdout, /--  version +skipped: api unreachable\n/); return true; });

  // a cell behind a private CA Node does not trust (kind's local CA with NODE_EXTRA_CA_CERTS lost): the api line and the
  // skipped version line both carry the TLS code and the NODE_EXTRA_CA_CERTS hint — with the CA trusted, doctor is green
  const tls = await serveTls();
  try {
    const env = { ...process.env, MATELOT_URL: `https://localhost:${tls.port}`, MATELOT_TOKEN: '', MATELOT_KEY_ID: '', MATELOT_SECRET: '', MATELOT_CREDENTIALS: '/nonexistent', NODE_EXTRA_CA_CERTS: '' };
    await assert.rejects(run('node', [cli, 'doctor'], { env }), (e: { code: number; stdout: string }) => {
      assert.equal(e.code, 1);
      assert.match(e.stdout, /FAIL {2}api +https:\/\/localhost:\d+ unreachable: (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE) \(.*\) — Node does not read the OS trust store: for a private CA set NODE_EXTRA_CA_CERTS=\/path\/to\/ca\.crt/);
      assert.match(e.stdout, /--  version +skipped: api unreachable \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE) .*NODE_EXTRA_CA_CERTS/);
      return true;
    });
    const trusted = await run('node', [cli, 'doctor'], { env: { ...env, NODE_EXTRA_CA_CERTS: tls.caFile } });
    assert.match(trusted.stdout, /OK {2}api +https:\/\/localhost:\d+ ready/);
    assert.match(trusted.stdout, /OK {2}version +API 0\.1\.0 · CLI /);
  } finally { tls.close(); }

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

test('matelot doctor: the observability section — scrapes, OTLP export (headers masked), event records, Grafana; export failures fail', async () => {
  const ok = await serve(true, 'ok', 'ok');
  try {
    const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${ok.port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
    const { stdout } = await run('node', [cli, 'doctor'], { env });
    assert.match(stdout, /OK {2}metrics +scraped — last scrape api \d+ s ago, worker \d+ s ago, runners never/);
    assert.match(stdout, /OK {2}tracing +otlp → http:\/\/otel-collector:4318\/v1\/traces \(headers: Authorization=••••\) · last span \d+ s ago/);
    assert.match(stdout, /OK {2}events +5 audit · 1 security since start — OTLP log records → http:\/\/otel-collector:4318\/v1\/logs/);
    assert.match(stdout, /--  grafana +https:\/\/grafana\.example\.com/);
    assert.doesNotMatch(stdout, /Basic /);
    const j = JSON.parse((await run('node', [cli, 'doctor', '--json'], { env })).stdout);
    assert.equal(j.ok, true); assert.equal(j.checks.length, 11);
    // --test-otlp: a test span + log record through the cell's exporters
    const t = (await run('node', [cli, 'doctor', '--test-otlp'], { env })).stdout;
    assert.match(t, /OK {2}otlp-test +test span sent \(trace a{32}; look for "matelot.test"\)/);
    assert.match(t, /--  otlp-logs +log records: OTLP logs are off/);
  } finally { ok.close(); }
  const failing = await serve(true, 'ok', 'failing');
  try {
    const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${failing.port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
    await assert.rejects(run('node', [cli, 'doctor', '--test-otlp'], { env }), (e: { code: number; stdout: string }) => { assert.equal(e.code, 1); assert.match(e.stdout, /FAIL {2}tracing +otlp → .* · 3 export failure\(s\): connect ECONNREFUSED 10\.0\.0\.9:4318/); assert.match(e.stdout, /FAIL {2}otlp-test +trace export failed: connect ECONNREFUSED/); return true; });
  } finally { failing.close(); }
  const forbidden = await serve(true, 'ok', 'forbidden');
  try {
    const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${forbidden.port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
    const { stdout } = await run('node', [cli, 'doctor'], { env });
    assert.match(stdout, /--  observability +skipped: cell administrators only/);
    assert.match(stdout, /all checks passed/);
  } finally { forbidden.close(); }
});
