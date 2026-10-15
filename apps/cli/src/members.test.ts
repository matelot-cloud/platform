import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = `${__dirname}/index.js`;
const ORG = '0c3cbf3d-31cf-41bd-884a-7e085e66f4d8';
const PROJECT = '6e6a3c53-7b9a-4e1e-9b0e-2c1f7c0a0001';

/** members / users / service-accounts / access-token / invite against a fake cell that records every request. */
test('members, users, service accounts, access tokens and setup links from the CLI', async () => {
  const seen: { method: string; url: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const json = (b: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      const u = req.url!;
      if (u === '/api/v1/organizations') return json([{ id: ORG, slug: 'globex' }]);
      if (u.startsWith('/api/v1/members?')) return json({ scope: {}, canManage: true, members: [{ membershipId: 'm1', user: { email: 'jane@globex.test', kind: 'human' }, roleLabel: 'Developer', source: 'inherited', inheritedFrom: { name: 'Backend' }, expiresAt: null, canEdit: false }] });
      if (u === '/api/v1/members' && req.method === 'POST') return json({ added: [{ email: 'a@globex.test', role: 'DEVELOPER', updated: false }, { email: 'b@globex.test', role: 'DEVELOPER', updated: true }], skipped: [], invited: [{ email: 'a@globex.test', setupLink: 'https://cell.test/invite/TOK', emailed: false, viaIdentityProvider: false }] });
      if (u === '/api/v1/admin/users' && req.method === 'POST') return json({ user: { email: 'new@globex.test' }, temporaryPassword: false, setupLink: null, emailed: true });
      if (u.endsWith('/tokens') && req.method === 'POST') return json({ id: 't1', name: 'ci', scope: 'read', expiresAt: '2027-01-01T00:00:00Z', token: 'spt_ONCE' });
      if (u === '/api/v1/scope-access-tokens') return json({ serviceAccount: { id: 'sa1', name: 'Renovate' }, token: { name: 'Renovate', scope: 'write', expiresAt: '2026-12-01T00:00:00Z', token: 'spt_SAT' } });
      if (u === '/api/v1/invites/TOK' && req.method === 'POST') return json({ email: 'a@globex.test', signInUrl: 'https://cell.test/' });
      json({});
    });
  });
  await new Promise<void>((d) => server.listen(0, '127.0.0.1', () => d()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...process.env, MATELOT_URL: url, MATELOT_TOKEN: 'spt_admin', MATELOT_KEY_ID: '', MATELOT_SECRET: '', MATELOT_CREDENTIALS: '/nonexistent' };
  const m = (...args: string[]) => run('node', [cli, ...args], { env }).then((r) => r.stdout);
  try {
    // --scope projects/ID → scopeType + scopeId; e-mails split; date expiry → end of day
    const added = await m('members', 'add', '--scope', `projects/${PROJECT}`, '--role', 'DEVELOPER', '--email', 'a@globex.test,b@globex.test', '--expires', '2027-03-31');
    const post = seen.find((s) => s.method === 'POST' && s.url === '/api/v1/members')!;
    assert.deepEqual(post.body, { scopeType: 'PROJECT', scopeId: PROJECT, role: 'DEVELOPER', emails: ['a@globex.test', 'b@globex.test'], expiresAt: '2027-03-31T23:59:59Z' });
    assert.match(added, /added a@globex\.test as DEVELOPER\nupdated b@globex\.test as DEVELOPER\na@globex\.test: no e-mail on this cell — send this one-time link yourself \(shown once\):\n {2}https:\/\/cell\.test\/invite\/TOK/);
    // list as a table; `--scope org` = the caller's organization
    const list = await m('members', 'list', '--scope', 'org');
    assert.ok(seen.some((s) => s.url === `/api/v1/members?scopeType=ORGANIZATION&scopeId=${ORG}`), 'org scope resolved');
    assert.match(list, /jane@globex\.test/); assert.match(list, /inherited/); assert.match(list, /Backend/);
    // --expires none clears the expiry
    await m('members', 'update', '--id', 'mem-1', '--role', 'TEAM_LEAD', '--expires', 'none');
    assert.deepEqual(seen.find((s) => s.method === 'PATCH' && s.url === '/api/v1/members/mem-1')!.body, { role: 'TEAM_LEAD', expiresAt: null });
    await m('members', 'remove', '--id', 'mem-1', '--reason', 'left the team');
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.url === '/api/v1/members/mem-1?reason=left+the+team'));
    await assert.rejects(m('members', 'list', '--scope', 'projects/not-an-id'), /--scope must be organizations\/ID, workspaces\/ID, teams\/ID, projects\/ID/);
    // users
    assert.match(await m('users', 'create', '--email', 'new@globex.test', '--first-name', 'New'), /created new@globex\.test\nnew@globex\.test: one-time setup link e-mailed/);
    assert.deepEqual(seen.find((s) => s.method === 'POST' && s.url === '/api/v1/admin/users')!.body, { email: 'new@globex.test', firstName: 'New' });
    await m('users', 'disable', '--id', 'u7');
    assert.deepEqual(seen.find((s) => s.method === 'PATCH' && s.url === '/api/v1/admin/users/u7')!.body, { enabled: false });
    await m('users', 'reset-password', '--id', 'u7', '--temporary-password', 'temp-password-123');
    assert.deepEqual(seen.find((s) => s.url === '/api/v1/admin/users/u7/reset-password')!.body, { temporaryPassword: 'temp-password-123' });
    // service accounts + access tokens: the token is printed once, scope via --token-scope
    assert.match(await m('service-accounts', 'token-create', '--id', 'sa1', '--name', 'ci', '--token-scope', 'read', '--days', '30'), /token ci \(read, until 2027-01-01\) — shown once, store it now:\n {2}spt_ONCE/);
    assert.deepEqual(seen.find((s) => s.url === '/api/v1/service-accounts/sa1/tokens' && s.method === 'POST')!.body, { name: 'ci', scope: 'read', expiresInDays: 30 });
    await m('service-accounts', 'token-revoke', '--id', 'sa1', '--token-id', 't1');
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.url === '/api/v1/service-accounts/sa1/tokens/t1'));
    assert.match(await m('access-token', 'create', '--scope', `projects/${PROJECT}`, '--name', 'Renovate', '--role', 'DEVELOPER', '--token-scope', 'write', '--days', '45'), /bot member Renovate \(sa1\)\ntoken Renovate \(write, until 2026-12-01\)[^\n]*\n {2}spt_SAT/);
    assert.deepEqual(seen.find((s) => s.url === '/api/v1/scope-access-tokens')!.body, { scopeType: 'PROJECT', scopeId: PROJECT, name: 'Renovate', role: 'DEVELOPER', scope: 'write', expiresInDays: 45 });
    // a setup link works without any login: the cell comes from the link, no Authorization header is sent
    const anon = { ...process.env, MATELOT_URL: '', MATELOT_TOKEN: '', MATELOT_KEY_ID: '', MATELOT_SECRET: '', MATELOT_CREDENTIALS: '/nonexistent' };
    const out = (await run('node', [cli, 'invite', 'accept', '--link', `${url}/invite/TOK`, '--password', 'correct horse battery'], { env: anon })).stdout;
    assert.match(out, /password set for a@globex\.test — sign in at https:\/\/cell\.test\//);
    const accept = seen.find((s) => s.url === '/api/v1/invites/TOK')!;
    assert.equal(accept.auth, undefined); assert.deepEqual(accept.body, { password: 'correct horse battery' });
  } finally { server.close(); }
});
