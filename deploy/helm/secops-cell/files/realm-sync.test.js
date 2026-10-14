// Fake Keycloak admin API: a realm imported with http redirect URIs, then the rendered realm says https (the
// tls=false → true upgrade). After the sync the client has the https URIs and sslRequired=external; users, roles and
// the client's other fields are untouched; a second run changes nothing. Run: node realm-sync.test.js
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sync, clientPatch } = require('./realm-sync.js');

const state = {
  realm: { realm: 'platform', sslRequired: 'none', enabled: true, displayName: 'Keep me' },
  clients: [
    { id: 'c1', clientId: 'platform-web', publicClient: true, redirectUris: ['http://acme.platform.local/*'], webOrigins: ['+'], attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': '+', 'made.by.hand': 'yes' }, protocolMappers: [{ name: 'platform-api-audience' }] },
    { id: 'c2', clientId: 'platform-api', bearerOnly: true },
  ],
};
const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${u.pathname}`);
    const json = (code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (u.pathname === '/auth/realms/master/.well-known/openid-configuration') return json(200, { issuer: 'x' });
    if (u.pathname === '/auth/realms/master/protocol/openid-connect/token') return json(200, body.includes('password=s3cret') ? { access_token: 'tok' } : {});
    if (req.headers.authorization !== 'Bearer tok') return json(401, { error: 'unauthorized' });
    if (u.pathname === '/auth/admin/realms/platform' && req.method === 'GET') return json(200, state.realm);
    if (u.pathname === '/auth/admin/realms/platform' && req.method === 'PUT') { Object.assign(state.realm, JSON.parse(body)); return json(204, {}); }
    if (u.pathname === '/auth/admin/realms/platform/clients' && req.method === 'GET') return json(200, state.clients.filter((c) => c.clientId === u.searchParams.get('clientId')));
    const m = /^\/auth\/admin\/realms\/platform\/clients\/(.+)$/.exec(u.pathname);
    if (m && req.method === 'PUT') { const i = state.clients.findIndex((c) => c.id === m[1]); state.clients[i] = JSON.parse(body); return json(204, {}); }
    json(404, { path: u.pathname });
  });
});

(async () => {
  await new Promise((d) => server.listen(0, '127.0.0.1', d));
  const base = `http://127.0.0.1:${server.address().port}/auth`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'realm-')), 'realm.json');
  fs.writeFileSync(file, JSON.stringify({
    realm: 'platform', sslRequired: 'external', displayName: 'Rendered name (must not be applied)',
    clients: [
      { clientId: 'platform-api', bearerOnly: true },
      { clientId: 'platform-web', publicClient: true, redirectUris: ['https://acme.platform.local/*'], webOrigins: ['+'], attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': '+' } },
      { clientId: 'not-imported', redirectUris: ['https://x/*'] },
    ],
    users: [{ username: 'admin', credentials: [{ type: 'password', value: 'seed' }] }],
  }));
  const logs = [];
  // wrong password: a clear error, nothing changed
  await assert.rejects(sync(base, file, { username: 'admin', password: 'nope', timeoutSeconds: 5, log: () => {} }), /admin login failed/);
  assert.equal(state.clients[0].redirectUris[0], 'http://acme.platform.local/*');
  const changes = await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: (l) => logs.push(l) });
  assert.deepEqual(changes, ['realm sslRequired none → external', 'client platform-web: redirectUris → https://acme.platform.local/*']);
  assert.equal(state.realm.sslRequired, 'external');
  assert.equal(state.realm.displayName, 'Keep me', 'only URL-shaped settings are applied');
  const web = state.clients.find((c) => c.clientId === 'platform-web');
  assert.deepEqual(web.redirectUris, ['https://acme.platform.local/*']);
  assert.equal(web.attributes['made.by.hand'], 'yes', 'hand-made attributes survive');
  assert.deepEqual(web.protocolMappers, [{ name: 'platform-api-audience' }], 'mappers untouched');
  assert.ok(!calls.some((c) => /users|roles|groups/.test(c)), 'users, roles and groups are never touched');
  assert.ok(logs.some((l) => l.includes('client not-imported: not in the realm')), 'missing clients are reported, not created');
  // idempotent
  assert.deepEqual(await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: () => {} }), []);
  // the pure diff
  assert.equal(clientPatch({ redirectUris: ['b', 'a'] }, { redirectUris: ['a', 'b'] }), null, 'order does not matter');
  assert.deepEqual(clientPatch({ redirectUris: ['a'], attributes: { x: '1' } }, { redirectUris: ['a'], attributes: { 'post.logout.redirect.uris': '+' } }), { attributes: { x: '1', 'post.logout.redirect.uris': '+' } });
  server.close();
  console.log('realm-sync ok (http → https upgrade applied; users, roles, mappers and hand-made attributes untouched; idempotent)');
})().catch((e) => { console.error(e); process.exit(1); });
