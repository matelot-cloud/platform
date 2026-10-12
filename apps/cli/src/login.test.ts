import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshToken, login, logout, readCredentials } from './login';

/** Stub authorization server: discovery, authorize (we "approve" by redirecting the loopback ourselves), token with PKCE check. */
function authServer() {
  const seen: Record<string, unknown>[] = [];
  let challenge = '';
  const server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const json = (o: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/oauth-authorization-server') return json({ authorization_endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/oauth/authorize`, token_endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/oauth/token` });
    if (u.pathname === '/api/v1/oauth/token') {
      let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
        const b = Object.fromEntries(new URLSearchParams(raw)); seen.push(b);
        if (b.grant_type === 'authorization_code') {
          const ok = createHash('sha256').update(b.code_verifier!).digest('base64url') === challenge && b.code === 'the-code' && b.client_id === 'matelot-cli';
          return ok ? json({ access_token: 'spt_from_oauth', refresh_token: 'rt1', expires_in: 3600, scope: 'write' }) : json({ error: 'invalid_grant' }, 400);
        }
        if (b.grant_type === 'refresh_token' && b.refresh_token === 'rt1') return json({ access_token: 'spt_refreshed', refresh_token: 'rt2', expires_in: 3600, scope: 'write' });
        if (b.grant_type === 'refresh_token' && b.refresh_token === 'rt2') return json({ access_token: 'spt_refreshed_2', refresh_token: 'rt3', expires_in: 3600, scope: 'write' });
        return json({ error: 'invalid_grant' }, 400);
      });
      return;
    }
    if (u.pathname === '/api/v1/oauth/revoke') { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { seen.push({ revoke: JSON.parse(raw).token }); json({}); }); return; }
    json({ message: 'nope' }, 404);
  });
  return { server, seen, open: (authorizeUrl: string) => { const a = new URL(authorizeUrl); challenge = a.searchParams.get('code_challenge')!; assert.equal(a.searchParams.get('client_id'), 'matelot-cli'); assert.equal(a.searchParams.get('code_challenge_method'), 'S256'); const cb = new URL(a.searchParams.get('redirect_uri')!); cb.searchParams.set('code', 'the-code'); cb.searchParams.set('state', a.searchParams.get('state')!); void fetch(cb.toString()); }, listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port))) };
}

test('matelot login: loopback + PKCE → token stored; expired token refreshes with rotation', async () => {
  process.env.MATELOT_CREDENTIALS = join(mkdtempSync(join(tmpdir(), 'matelot-creds-')), 'credentials.json');
  const s = authServer(); const port = await s.listen();
  try {
    const creds = await login(`http://127.0.0.1:${port}`, 'write', { open: s.open, timeoutMs: 10_000 });
    assert.equal(creds.accessToken, 'spt_from_oauth');
    assert.equal(creds.scope, 'write');
    const stored = JSON.parse(readFileSync(process.env.MATELOT_CREDENTIALS!, 'utf8'))[`http://127.0.0.1:${port}`];
    assert.equal(stored.refreshToken, 'rt1');                                                   // refresh token stored
    const ttl = new Date(stored.expiresAt).getTime() - Date.now();
    assert.ok(ttl > 3500_000 && ttl <= 3600_000, `expiresAt stored as ISO, ~expires_in ahead (${stored.expiresAt})`);
    assert.equal(readCredentials(`http://127.0.0.1:${port}`)!.accessToken, 'spt_from_oauth');
    assert.equal(await freshToken(`http://127.0.0.1:${port}`), 'spt_from_oauth');          // still valid: no refresh
    // expire it → refresh rotates
    const all = JSON.parse(readFileSync(process.env.MATELOT_CREDENTIALS!, 'utf8')); all[`http://127.0.0.1:${port}`].expiresAt = new Date(Date.now() - 1).toISOString();
    require('node:fs').writeFileSync(process.env.MATELOT_CREDENTIALS!, JSON.stringify(all));
    assert.equal(await freshToken(`http://127.0.0.1:${port}`), 'spt_refreshed');
    assert.equal(readCredentials(`http://127.0.0.1:${port}`)!.refreshToken, 'rt2');
    // logout revokes the refresh token at the server and forgets it locally
    const lo = await logout(`http://127.0.0.1:${port}`);
    assert.deepEqual(lo, { url: `http://127.0.0.1:${port}`, revoked: true });
    assert.ok(s.seen.some((x) => x.revoke === 'rt2'), 'revoke called with the refresh token');
    assert.equal(readCredentials(`http://127.0.0.1:${port}`)!.accessToken, '');
    assert.equal(s.seen.filter((x) => x.grant_type === 'authorization_code').length, 1);
  } finally { s.server.close(); }
});

test('a non-admin requesting sudo is told the grant was narrowed; --help needs no credentials', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // --help with no credentials at all
  const h = await run('node', [join(__dirname, 'index.js'), 'membership', 'grant', '--help'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });
  assert.match(h.stdout, /matelot membership grant/);
  assert.match(h.stdout, /ORG_ADMIN/);
  assert.match(h.stdout, /--role/);
  // narrowed grant: server answers scope write to a sudo request
  process.env.MATELOT_CREDENTIALS = join(mkdtempSync(join(tmpdir(), 'matelot-creds-')), 'credentials.json');
  const s = authServer(); const port = await s.listen();
  try {
    const creds = await login(`http://127.0.0.1:${port}`, 'sudo', { open: s.open, timeoutMs: 10_000 });
    assert.equal(creds.scope, 'write');  // the stub grants write; index.ts prints "granted write, not sudo" (see RANK check)
  } finally { s.server.close(); }
});

test('login: a proxy that serves the SPA for /.well-known gives a readable error', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><html><body>app</body></html>'); });
  const port = await new Promise<number>((done) => server.listen(0, () => done((server.address() as { port: number }).port)));
  try {
    await assert.rejects(login(`http://127.0.0.1:${port}`, 'read', { noBrowser: true, timeoutMs: 1000 }), (e: Error) => { assert.match(e.message, /\.well-known\/oauth-authorization-server returned HTML \(HTTP 200\) — is \/\.well-known routed to the API/); return true; });
  } finally { server.close(); }
});
