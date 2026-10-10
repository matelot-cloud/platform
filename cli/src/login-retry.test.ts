import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { freshToken, retryingFetch } from './login';

const run = promisify(execFile);
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('OAuth calls wait for Retry-After on 429 (≤ 60 s, at most 3 retries)', async () => {
  const waits: number[] = [];
  let n = 0;
  const f = retryingFetch((async () => (++n <= 2 ? res(429, { message: 'Too Many Requests' }, { 'retry-after': '7' }) : res(200, { access_token: 'a' }))) as typeof fetch, async (ms) => { waits.push(ms); });
  const r = await f('https://cell/api/v1/oauth/token', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [7000, 7000]);

  let m = 0;
  const always = retryingFetch((async () => { m++; return res(429, {}, { 'retry-after': '1' }); }) as typeof fetch, async () => undefined);
  assert.equal((await always('x')).status, 429);
  assert.equal(m, 4); // first try + 3 retries
  let k = 0;
  const tooLong = retryingFetch((async () => { k++; return res(429, {}, { 'retry-after': '120' }); }) as typeof fetch, async () => undefined);
  assert.equal((await tooLong('x')).status, 429);
  assert.equal(k, 1); // > 60 s: give up at once
});

test('token refresh retries a 429 instead of failing the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'matelot-'));
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify({ 'https://cell.example': { url: 'https://cell.example', accessToken: 'old', refreshToken: 'r1', expiresAt: new Date(Date.now() - 1000).toISOString(), scope: 'write' } }));
  const prev = process.env.MATELOT_CREDENTIALS;
  process.env.MATELOT_CREDENTIALS = file;
  let tokenCalls = 0;
  const f = (async (u: string) => {
    if (String(u).endsWith('/.well-known/oauth-authorization-server')) return res(200, { authorization_endpoint: 'https://cell.example/oauth/authorize', token_endpoint: 'https://cell.example/api/v1/oauth/token' });
    tokenCalls++;
    return tokenCalls === 1 ? res(429, { message: 'Too Many Requests' }, { 'retry-after': '2' }) : res(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600, scope: 'write' });
  }) as typeof fetch;
  try {
    assert.equal(await freshToken('https://cell.example', f, async () => undefined), 'new');
    assert.equal(tokenCalls, 2);
  } finally {
    if (prev === undefined) delete process.env.MATELOT_CREDENTIALS; else process.env.MATELOT_CREDENTIALS = prev;
  }
});

test('API unreachable: `matelot usage` reports the connection problem, not "--org is required"', async () => {
  const env = { ...process.env, MATELOT_URL: 'http://127.0.0.1:1', MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
  await assert.rejects(run('node', [join(__dirname, 'index.js'), 'usage'], { env }), (e: { stderr: string }) => {
    assert.match(e.stderr, /cannot reach http:\/\/127\.0\.0\.1:1/);
    assert.doesNotMatch(e.stderr, /--org is required/);
    return true;
  });
});
