import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { unsampledTraceparent } from './client';

const run = promisify(execFile);
const ID = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';

test('unsampledTraceparent: W3C format with the sampled flag off', () => {
  for (let i = 0; i < 20; i++) assert.match(unsampledTraceparent(), /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  assert.notEqual(unsampledTraceparent(), unsampledTraceparent());
});

test('pipeline --wait: the polls carry an unsampled traceparent (no trace at the cell); the run request carries none', async () => {
  const seen: { url: string; traceparent?: string }[] = [];
  let polls = 0;
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url!, traceparent: req.headers.traceparent as string | undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST') res.end(JSON.stringify({ id: ID, number: 7, status: 'running', jobs: [{ name: 'checkout', status: 'queued' }] }));
      else { polls++; res.end(JSON.stringify({ id: ID, number: 7, status: polls >= 2 ? 'succeeded' : 'running', jobs: [{ name: 'checkout', status: polls >= 2 ? 'succeeded' : 'running' }] })); }
    });
  });
  const port = await new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port)));
  try {
    const { stdout } = await run('node', [join(__dirname, 'index.js'), 'pipeline', '--service', ID, '--wait'], { env: { ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test', MATELOT_CREDENTIALS: '/nonexistent' }, timeout: 30000 });
    assert.match(stdout, /pipeline #7: succeeded/);
    assert.equal(seen[0].url, `/api/v1/services/${ID}/pipelines`);
    assert.equal(seen[0].traceparent, undefined);                 // the run itself may be traced by the cell
    const pollRequests = seen.filter((s) => s.url === `/api/v1/pipelines/${ID}`);
    assert.equal(pollRequests.length, 2);
    for (const p of pollRequests) assert.match(p.traceparent ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  } finally { server.close(); }
});
