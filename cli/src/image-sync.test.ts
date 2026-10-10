import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const run = promisify(execFile);
const SVC = '790ef01f-de6e-4a55-ae80-4b901416a609';
const IMG = '11111111-1111-4111-8111-111111111111';

test('matelot image sync --service --id calls the service-scoped route (was /images/:id/sync → 404)', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tags: 2 })); });
  const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port)));
  try {
    const { stdout } = await run('node', [join(__dirname, 'index.js'), 'image', 'sync', '--service', SVC, '--id', IMG], { env: { ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test' } });
    assert.deepEqual(seen, [`POST /api/v1/services/${SVC}/images/${IMG}/sync`]);
    assert.match(stdout, /tags/);
  } finally { server.close(); }
});
