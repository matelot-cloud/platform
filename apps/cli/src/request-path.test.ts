/** `matelot request`: a path without /api/v1 gets it; an HTML answer (the web app) is an error, never printed as JSON (kind rc.23). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { apiPath } from './client';

const run = promisify(execFile);
const cli = join(__dirname, 'index.js');

test('apiPath: /api/… kept, anything else under /api/v1, a URL refused', () => {
  assert.equal(apiPath('/api/v1/admin/observability'), '/api/v1/admin/observability');
  assert.equal(apiPath('/admin/observability'), '/api/v1/admin/observability');
  assert.equal(apiPath('admin/observability'), '/api/v1/admin/observability');
  assert.equal(apiPath('/api/docs-json'), '/api/docs-json');
  assert.throws(() => apiPath('https://cell.example.com/api/v1/me'), /takes a path, not a URL/);
});

test('matelot request: prefixes /api/v1; an HTML page fails with a hint instead of printing it', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url!);
    if (req.url === '/api/v1/admin/observability') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"cell":"acme"}'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html><body><div id="root"></div></body></html>');   // the web app's index.html
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, MATELOT_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' };
  try {
    const { stdout } = await run('node', [cli, 'request', 'GET', '/admin/observability'], { env });
    assert.deepEqual(JSON.parse(stdout), { cell: 'acme' });
    assert.equal(seen.pop(), '/api/v1/admin/observability');
    await assert.rejects(run('node', [cli, 'request', 'GET', '/api/v1/nowhere'], { env }), (e: { code: number; stdout: string; stderr: string }) => {
      assert.equal(e.code, 1);
      assert.equal(e.stdout, '');
      assert.match(e.stderr, /answered with an HTML page \(HTTP 200\), not the API: is MATELOT_URL .* the cell's address\?/);
      return true;
    });
  } finally { server.close(); }
});
