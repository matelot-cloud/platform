// Fake Keycloak admin API: a realm imported with http redirect URIs, then the rendered realm says https (the
// tls=false → true upgrade). After the sync the client has the https URIs and sslRequired=external; users, roles and
// the client's other fields are untouched; a second run changes nothing. Run: node realm-sync.test.js
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sync, clientPatch, namesFromEmail, realmSettingsPatch } = require('./realm-sync.js');

const state = {
  realm: { realm: 'platform', sslRequired: 'none', enabled: true, displayName: 'Keep me', displayNameHtml: 'ACME Corp Security Platform', loginTheme: 'keycloak.v2' },
  profile: { attributes: [{ name: 'username' }, { name: 'email', required: { roles: ['user'] } }, { name: 'firstName', required: { roles: ['user'] }, permissions: { view: ['admin', 'user'] } }, { name: 'lastName', required: { roles: ['user'] } }], groups: [] },
  users: [{ id: 'u1', username: 'old@acme.local', email: 'old@acme.local', enabled: false, credentials: 'keep' }],
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
    if (u.pathname === '/auth/admin/realms/platform/clients' && req.method === 'POST') { const nc = JSON.parse(body); if (state.clients.some((c) => c.clientId === nc.clientId)) return json(409, {}); state.clients.push({ id: `c${state.clients.length + 1}`, ...nc }); res.writeHead(201); return res.end(); }
    if (u.pathname === '/auth/admin/realms/platform/clients' && req.method === 'GET') return json(200, state.clients.filter((c) => c.clientId === u.searchParams.get('clientId')));
    if (u.pathname === '/auth/admin/realms/platform/users/profile' && req.method === 'GET') return json(200, state.profile);
    if (u.pathname === '/auth/admin/realms/platform/users/profile' && req.method === 'PUT') { state.profile = JSON.parse(body); return json(200, state.profile); }
    if (u.pathname === '/auth/admin/realms/platform/users' && req.method === 'GET') return json(200, state.users.filter((x) => x.email === u.searchParams.get('email')));
    if (u.pathname === '/auth/admin/realms/platform/users' && req.method === 'POST') { const nu = JSON.parse(body); state.users.push({ id: `u${state.users.length + 1}`, ...nu }); res.writeHead(201, { location: `/x/${state.users.length}` }); return res.end(); }
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
    realm: 'platform', sslRequired: 'external', displayName: 'Rendered name (must not be applied)', displayNameHtml: 'ACME Corp', loginTheme: 'matelot',
    clients: [
      { clientId: 'platform-api', bearerOnly: true },
      { clientId: 'platform-web', publicClient: true, redirectUris: ['https://acme.platform.local/*'], webOrigins: ['+'], attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': '+' } },
      { clientId: 'not-imported', redirectUris: ['https://x/*'] },
      { clientId: 'grafana', publicClient: false, secret: 'grafana-secret-1', redirectUris: ['https://acme.platform.local/grafana/login/generic_oauth'], attributes: { 'matelot.createIfMissing': 'true' } },
    ],
    users: [{ username: 'admin', credentials: [{ type: 'password', value: 'seed' }] }],
  }));
  const logs = [];
  // wrong password: a clear error, nothing changed
  await assert.rejects(sync(base, file, { username: 'admin', password: 'nope', timeoutSeconds: 5, log: () => {} }), /admin login failed/);
  assert.equal(state.clients[0].redirectUris[0], 'http://acme.platform.local/*');
  const changes = await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: (l) => logs.push(l) });
  assert.deepEqual(changes, ['realm sslRequired "none" → "external"', 'realm loginTheme "keycloak.v2" → "matelot"', 'realm displayNameHtml "ACME Corp Security Platform" → "ACME Corp"', 'user profile: first and last name optional', 'client platform-web: redirectUris → https://acme.platform.local/*', 'client grafana created']);
  const grafana = state.clients.find((c) => c.clientId === 'grafana');
  assert.equal(grafana.secret, 'grafana-secret-1', 'an optional client added later is created with its rendered secret');
  const attr = (n) => state.profile.attributes.find((a) => a.name === n);
  assert.equal(attr('firstName').required, undefined); assert.equal(attr('lastName').required, undefined);
  assert.deepEqual(attr('email').required, { roles: ['user'] }, 'e-mail stays required');
  assert.deepEqual(attr('firstName').permissions, { view: ['admin', 'user'] }, 'other attribute settings kept');
  assert.equal(state.realm.sslRequired, 'external');
  assert.equal(state.realm.displayName, 'Keep me', 'a display name typed by hand is kept');
  assert.equal(state.realm.displayNameHtml, 'ACME Corp', 'the old templated "… Security Platform" is migrated to the tenant name');
  assert.equal(state.realm.loginTheme, 'matelot', 'the login theme is applied on every run');
  assert.equal(state.realm.enabled, true, 'the PUT carries only the changed settings');
  const web = state.clients.find((c) => c.clientId === 'platform-web');
  assert.deepEqual(web.redirectUris, ['https://acme.platform.local/*']);
  assert.equal(web.attributes['made.by.hand'], 'yes', 'hand-made attributes survive');
  assert.deepEqual(web.protocolMappers, [{ name: 'platform-api-audience' }], 'mappers untouched');
  assert.ok(!calls.some((c) => /\/users(?!\/profile)|roles|groups/.test(c)), 'without SEED_USERS, users, roles and groups are never touched');
  // seeding: a missing administrator is created with a temporary password; an existing user is left exactly as it was
  const seeded = await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: () => {}, seedUsers: ['New@acme.local', ' old@acme.local ', ''], seedPassword: 'first-login' });
  assert.deepEqual(seeded, ['user new@acme.local created (temporary password: the first login asks for a new one)']);
  const created = state.users.find((x) => x.email === 'new@acme.local');
  assert.deepEqual(created.credentials, [{ type: 'password', value: 'first-login', temporary: true }]);
  assert.equal(created.enabled, true); assert.equal(created.emailVerified, true); assert.equal(created.username, 'new@acme.local');
  assert.equal(created.firstName, undefined, 'no placeholder name for a one-part local part');
  assert.deepEqual(namesFromEmail('jane.doe@acme.local'), { firstName: 'Jane', lastName: 'Doe' });
  assert.deepEqual(namesFromEmail('ciso@globex.test'), {});
  // realm settings: themes always follow the rendered realm; display names only while still the old templated form
  assert.equal(realmSettingsPatch({ sslRequired: 'external', loginTheme: 'matelot', displayName: 'Globex', displayNameHtml: 'Globex' }, { sslRequired: 'external', loginTheme: 'matelot', displayName: 'Globex Corporation', displayNameHtml: 'Globex Corporation' }), null, 'a renamed display name is kept');
  assert.deepEqual(realmSettingsPatch({ displayName: 'Globex · Matelot', displayNameHtml: '' }, { loginTheme: 'matelot', displayName: 'Globex', displayNameHtml: 'Globex' }), { loginTheme: 'matelot', displayName: 'Globex', displayNameHtml: 'Globex' }, 'the Compose form "· Matelot" and an empty displayNameHtml are migrated');
  assert.deepEqual(realmSettingsPatch({ loginTheme: 'matelot' }, { loginTheme: 'matelot', accountTheme: 'matelot' }), { accountTheme: 'matelot' });
  assert.equal(realmSettingsPatch({ loginTheme: 'custom-by-hand' }, {}), null, 'a realm.json without a theme never touches the theme');
  assert.deepEqual(state.users[0], { id: 'u1', username: 'old@acme.local', email: 'old@acme.local', enabled: false, credentials: 'keep' }, 'existing user untouched');
  assert.ok(!calls.some((c) => /PUT .*\/users\/(?!profile)/.test(c)), 'no user is ever updated');
  // a second seeding run creates nothing
  assert.deepEqual(await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: () => {}, seedUsers: ['new@acme.local'], seedPassword: 'x' }), []);
  assert.ok(logs.some((l) => l.includes('client not-imported: not in the realm')), 'missing clients are reported, not created');
  // a secret changed in Keycloak (or regenerated by init) is brought back to the one Grafana was given
  state.clients.find((c) => c.clientId === 'grafana').secret = 'rotated-by-hand';
  assert.deepEqual(await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: () => {} }), ['client grafana: secret (rotated to the rendered one)']);
  assert.equal(state.clients.find((c) => c.clientId === 'grafana').secret, 'grafana-secret-1');
  // idempotent
  assert.deepEqual(await sync(base, file, { username: 'admin', password: 's3cret', timeoutSeconds: 5, log: () => {} }), []);
  // the pure diff
  assert.equal(clientPatch({ redirectUris: ['b', 'a'] }, { redirectUris: ['a', 'b'] }), null, 'order does not matter');
  assert.deepEqual(clientPatch({ redirectUris: ['a'], attributes: { x: '1' } }, { redirectUris: ['a'], attributes: { 'post.logout.redirect.uris': '+' } }), { attributes: { x: '1', 'post.logout.redirect.uris': '+' } });
  assert.equal(clientPatch({ secret: 's' }, { secret: 's' }), null);
  assert.equal(clientPatch({ secret: 's' }, {}), null, 'a rendered client without a secret never touches it');
  server.close();
  console.log('realm-sync ok (http → https upgrade applied; users, roles, mappers and hand-made attributes untouched; optional clients created when marked, secrets kept in sync; missing admins seeded with a temporary password, existing users never modified; idempotent)');
})().catch((e) => { console.error(e); process.exit(1); });
