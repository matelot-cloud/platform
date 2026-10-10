import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { CUSTOM_COMMANDS, RESOURCES } from './resources';

const run = promisify(execFile);
const WS = '22222222-2222-4222-8222-222222222222';
const PROJ = '33333333-3333-4333-8333-333333333333';

function stub() {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const server = createServer((req, res) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => { seen.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }); });
  return { seen, server, listen: () => new Promise<number>((r) => server.listen(0, () => r((server.address() as { port: number }).port))) };
}
const env = (port: number) => ({ ...process.env, MATELOT_URL: `http://127.0.0.1:${port}`, MATELOT_TOKEN: 'spt_test' });

test('generated parity commands: path params from --workspace/--team/--project, fields from flags, --body merged', async () => {
  const s = stub(); const port = await s.listen();
  try {
    await run('node', [join(__dirname, 'index.js'), 'team', 'create', '--workspace', WS, '--slug', 'payments', '--name', 'Payments', '--json'], { env: env(port) });
    await run('node', [join(__dirname, 'index.js'), 'env', 'settings', '--env', PROJ, '--protected', 'true', '--kubernetes-namespace', 'payments-prod', '--json'], { env: env(port) });
    await run('node', [join(__dirname, 'index.js'), 'connection', 'create', '--org', WS, '--body', '{"provider":"jira","scopeType":"PROJECT","scopeId":"' + PROJ + '","name":"Jira","baseUrl":"https://acme.atlassian.net","auth":{"type":"basic","username":"u","password":"p"}}', '--json'], { env: env(port) });
    assert.deepEqual(s.seen.map((x) => `${x.method} ${x.url}`), [`POST /api/v1/workspaces/${WS}/teams`, `PATCH /api/v1/environments/${PROJ}/settings`, `POST /api/v1/organizations/${WS}/integrations`]);
    assert.deepEqual(s.seen[0]!.body, { slug: 'payments', name: 'Payments' });
    assert.deepEqual(s.seen[1]!.body, { protected: true, kubernetesNamespace: 'payments-prod' });   // booleans parsed, flags mapped
    assert.equal((s.seen[2]!.body as { auth: { type: string } }).auth.type, 'basic');              // nested body intact
  } finally { s.server.close(); }
});

test('every command is listed in --help (resources + custom)', async () => {
  const { stdout } = await run('node', [join(__dirname, 'index.js')], { env: env(1) }).catch((e: { stdout: string }) => e);
  for (const r of RESOURCES) assert.ok(stdout.includes(`matelot ${r.resource}`) || stdout.includes(` ${r.resource} `) || stdout.includes(`${r.resource} <`), `help lists ${r.resource}`);
  for (const c of CUSTOM_COMMANDS) assert.ok(stdout.includes(c.cmd.split(' ')[1]!), `help lists ${c.cmd}`);
});
