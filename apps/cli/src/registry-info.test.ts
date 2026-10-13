import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registryInfoText } from './registry-info';

const run = promisify(execFile);
const cli = `${__dirname}/index.js`;

test('registry info: human-readable host, login, path pattern and the refusal rule; --json stays raw', async () => {
  const text = registryInfoText({ available: true, host: 'localhost:5000', pathCommand: 'matelot registry path --service <serviceId> [--env <environmentId>]' });
  assert.match(text, /^built-in registry: localhost:5000$/m);
  assert.match(text, /localhost:5000\/<workspace>\/<team>\/<project>\/<service>:<tag>/);
  assert.match(text, /matelot registry path --service <serviceId>/);
  assert.match(text, /insufficient_scope: authorization failed/);
  assert.equal(registryInfoText({ available: false, host: null }), 'built-in registry: not configured on this cell (REGISTRY_HOST)');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/v1/registry/info' ? { available: true, host: 'localhost:5000', pathCommand: 'x' } : {}));
  });
  await new Promise<void>((d) => server.listen(0, '127.0.0.1', () => d()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const env = { ...process.env, MATELOT_URL: url, MATELOT_TOKEN: 'spt_x', MATELOT_KEY_ID: '', MATELOT_SECRET: '', MATELOT_CREDENTIALS: '/nonexistent' };
    assert.match((await run('node', [cli, 'registry', 'info'], { env })).stdout, /built-in registry: localhost:5000\nlogin:/);
    assert.equal(JSON.parse((await run('node', [cli, 'registry', 'info', '--json'], { env })).stdout).host, 'localhost:5000');
  } finally { server.close(); }
});
