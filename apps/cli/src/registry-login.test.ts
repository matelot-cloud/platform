import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
/** A fake `docker` on PATH that records its arguments and stdin. */
function fakeDocker() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\nread -r pw\necho "$@ pw=$pw" >> "${log}"\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  return { dir, log };
}
function stub() {
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ available: true, host: 'localhost:5000' })); });
  return { server, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port))) };
}

test('registry login with a CI token: docker login -u <keyId> with the secret', async () => {
  const s = stub(); const port = await s.listen(); const d = fakeDocker();
  try {
    await run('node', [join(__dirname, 'index.js'), 'registry', 'login'], { env: { ...process.env, PATH: `${d.dir}:${process.env.PATH}`, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_KEY_ID: 'sk_abc', MATELOT_SECRET: 'sec_xyz', MATELOT_TOKEN: '' } });
    assert.match(require('node:fs').readFileSync(d.log, 'utf8'), /login localhost:5000 -u sk_abc --password-stdin pw=sec_xyz/);
  } finally { s.server.close(); }
});

test('registry login with a personal token: docker login -u token with the spt_ secret (was "username is empty")', async () => {
  const s = stub(); const port = await s.listen(); const d = fakeDocker();
  try {
    await run('node', [join(__dirname, 'index.js'), 'registry', 'login'], { env: { ...process.env, PATH: `${d.dir}:${process.env.PATH}`, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_personal123', MATELOT_KEY_ID: '', MATELOT_SECRET: '' } });
    assert.match(require('node:fs').readFileSync(d.log, 'utf8'), /login localhost:5000 -u token --password-stdin pw=spt_personal123/);
  } finally { s.server.close(); }
});
