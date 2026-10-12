import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const cli = join(__dirname, 'index.js');

/** A cell: every request answered for the token the server was given, 401 for anything else. */
function cell(token: string) {
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const u = req.url!;
    if (u === '/api/v1/health/ready') return json(200, { status: 'ok' });
    if (u === '/api/v1/version') return json(200, { name: 'matelot', version: '1.0.0' });
    if (u === '/.well-known/oauth-authorization-server') { const b = `http://${req.headers.host}`; return json(200, { authorization_endpoint: `${b}/api/v1/oauth/authorize`, token_endpoint: `${b}/api/v1/oauth/token` }); }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { message: 'Unauthorized' });
    if (u === '/api/v1/api-tokens/whoami') return json(200, { kind: 'user', email: `${token}@localhost` });
    if (u === '/api/v1/organizations') return json(200, [{ id: '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8', slug: 'main' }]);
    if (u.endsWith('/runner-pools')) return json(200, [{ name: 'Managed', managed: true, runners: [{ name: 'r1', status: 'online' }] }]);
    if (u === '/api/v1/registry/info') return json(200, { available: true, host: 'localhost:5000' });
    json(404, {});
  });
  return new Promise<{ url: string; close: () => void }>((done) => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() })));
}

test('cells: whoami/doctor never pick the first (expired) entry; --url, MATELOT_URL, current and single-entry resolution; cells / use / logout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cells-'));
  const file = join(dir, 'credentials.json');
  const stale = await cell('old');
  const fresh = await cell('new');
  const baseEnv = { ...process.env, MATELOT_CREDENTIALS: file, MATELOT_URL: '', MATELOT_TOKEN: '', MATELOT_KEY_ID: '', MATELOT_SECRET: '', SECOPS_URL: '', SECOPS_TOKEN: '' };
  const past = new Date(Date.now() - 3600_000).toISOString(); const future = new Date(Date.now() + 86_400_000).toISOString();
  try {
    // a legacy file (no `current`): first entry expired, second valid — as after logging into a second cell with an older CLI
    writeFileSync(file, JSON.stringify({ [stale.url]: { url: stale.url, accessToken: 'old', expiresAt: past, scope: 'sudo' }, [fresh.url]: { url: fresh.url, accessToken: 'new', expiresAt: future, scope: 'write', user: 'new@localhost' } }));
    // no current and two entries: a clear error, not the first entry
    await assert.rejects(run('node', [cli, 'whoami'], { env: baseEnv }), (e: { stderr: string }) => { assert.match(e.stderr, /no cell selected/); return true; });
    // --url is honoured by whoami and doctor
    assert.match((await run('node', [cli, 'whoami', '--url', fresh.url], { env: baseEnv })).stdout, /user new@localhost/);
    const d = (await run('node', [cli, 'doctor', '--url', fresh.url], { env: baseEnv })).stdout;
    assert.match(d, new RegExp(`OK {2}login +user new@localhost on ${fresh.url.replace(/[.]/g, '\\.')}`));
    assert.match(d, /OK {2}runners +1 online \(r1\) — GET \/organizations\/main\/runner-pools: 1 pool\(s\)/);
    // MATELOT_URL works the same
    assert.match((await run('node', [cli, 'whoami'], { env: { ...baseEnv, MATELOT_URL: fresh.url } })).stdout, /user new@localhost/);
    // `use` sets the current cell: whoami and doctor follow it
    assert.match((await run('node', [cli, 'use', fresh.url], { env: baseEnv })).stdout, /current cell: /);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).current, fresh.url);
    assert.match((await run('node', [cli, 'whoami'], { env: baseEnv })).stdout, /user new@localhost/);
    assert.match((await run('node', [cli, 'doctor'], { env: baseEnv })).stdout, /OK {2}login +user new@localhost on /);
    // cells lists both, marks the current one, shows expiry state
    const list = (await run('node', [cli, 'cells'], { env: baseEnv })).stdout;
    assert.match(list, new RegExp(`\\* ${fresh.url.replace(/[.]/g, '\\.')} +new@localhost +write +valid until`));
    assert.match(list, new RegExp(`  ${stale.url.replace(/[.]/g, '\\.')} +sudo +expired`));
    // --url still wins over current: targeting the expired cell says so, about THAT cell
    const d2 = await run('node', [cli, 'doctor', '--url', stale.url], { env: baseEnv }).catch((e: { stdout: string }) => e);
    assert.match(d2.stdout, new RegExp(`--  login +skipped: stored login for ${stale.url.replace(/[.]/g, '\\.')} expired`));
    // logout removes the entry and clears current when it pointed there; the remaining single entry is then used
    await run('node', [cli, 'logout'], { env: baseEnv });
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after[fresh.url], undefined); assert.equal(after.current, undefined);
    await assert.rejects(run('node', [cli, 'whoami'], { env: baseEnv }), (e: { stderr: string }) => { assert.match(e.stderr, /expired: run matelot login --url/); return true; }); // single stored entry, expired
    assert.match((await run('node', [cli, 'cells'], { env: baseEnv })).stdout, /expired/);
  } finally { stale.close(); fresh.close(); }
});
