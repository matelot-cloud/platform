// Keycloak realm sync — what `start --import-realm` does not do. The import strategy is IGNORE_EXISTING: after the
// first start the realm in the database never changes, so a domain or scheme change (http → https, a new hostname)
// leaves the clients' redirect URIs behind ("Invalid parameter: redirect_uri"). This applies the rendered realm.json's
// URL-shaped settings through the admin API and nothing else: realm sslRequired, and per client (matched by clientId)
// redirectUris, webOrigins, rootUrl, baseUrl, adminUrl, the post-logout redirect attribute. Users, groups, roles,
// credentials and anything created by hand stay untouched; clients missing in the realm are reported, not created.
// Runs as the chart's post-install/post-upgrade hook Job and as `compose-init.sh realm-update`.
//   node realm-sync.js <keycloak base URL, e.g. http://acme-keycloak:8080 or http://keycloak:8080/auth> <realm.json>
//   env: KC_BOOTSTRAP_ADMIN_USERNAME, KC_BOOTSTRAP_ADMIN_PASSWORD (the bootstrap admin of the master realm)
//        REALM_SYNC_TIMEOUT (seconds to wait for Keycloak, default 300)
'use strict';
const fs = require('node:fs');

const CLIENT_FIELDS = ['redirectUris', 'webOrigins', 'rootUrl', 'baseUrl', 'adminUrl'];
const ATTRIBUTES = ['post.logout.redirect.uris'];

async function waitForKeycloak(base, timeoutSeconds, log) {
  const until = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    try {
      const r = await fetch(`${base}/realms/master/.well-known/openid-configuration`);
      if (r.ok) return;
      log(`keycloak answered ${r.status}, waiting`);
    } catch (e) { log(`keycloak not reachable yet (${e.cause?.code ?? e.message}), waiting`); }
    if (Date.now() > until) throw new Error(`keycloak at ${base} not ready after ${timeoutSeconds}s`);
    await new Promise((d) => setTimeout(d, 5000));
  }
}

async function login(base, username, password) {
  const r = await fetch(`${base}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }) });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) throw new Error(`keycloak admin login failed (${r.status}): ${JSON.stringify(t).slice(0, 200)}`);
  return t.access_token;
}

/** Pure: what to PUT for one client given its current state and the rendered one; null when nothing differs. */
function clientPatch(current, rendered) {
  const patch = {};
  for (const f of CLIENT_FIELDS) {
    if (!(f in rendered)) continue;
    const want = Array.isArray(rendered[f]) ? [...rendered[f]].sort() : rendered[f];
    const have = Array.isArray(current[f]) ? [...current[f]].sort() : current[f];
    if (JSON.stringify(want) !== JSON.stringify(have)) patch[f] = rendered[f];
  }
  const attrs = {};
  for (const a of ATTRIBUTES) {
    if (rendered.attributes && a in rendered.attributes && (current.attributes ?? {})[a] !== rendered.attributes[a]) attrs[a] = rendered.attributes[a];
  }
  if (Object.keys(attrs).length) patch.attributes = { ...(current.attributes ?? {}), ...attrs };
  return Object.keys(patch).length ? patch : null;
}

async function sync(base, realmFile, { username, password, timeoutSeconds = 300, log = console.log } = {}) {
  const rendered = JSON.parse(fs.readFileSync(realmFile, 'utf8'));
  const realm = rendered.realm;
  await waitForKeycloak(base, timeoutSeconds, log);
  const token = await login(base, username, password);
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const admin = `${base}/admin/realms/${encodeURIComponent(realm)}`;
  const changes = [];
  let current = null;
  for (const until = Date.now() + timeoutSeconds * 1000; ; ) {   // the first start imports the realm during startup
    const r = await fetch(admin, { headers: h });
    if (r.ok) { current = await r.json(); if (current?.realm === realm) break; }
    if (Date.now() > until) throw new Error(`realm ${realm} not found after ${timeoutSeconds}s (import failed? docker compose logs keycloak / kubectl logs deploy/<release>-keycloak)`);
    log(`realm ${realm} not imported yet (${r.status}), waiting`);
    await new Promise((d) => setTimeout(d, 5000));
  }
  if ('sslRequired' in rendered && current.sslRequired !== rendered.sslRequired) {
    const r = await fetch(admin, { method: 'PUT', headers: h, body: JSON.stringify({ sslRequired: rendered.sslRequired }) });
    if (!r.ok) throw new Error(`realm update: HTTP ${r.status}`);
    changes.push(`realm sslRequired ${current.sslRequired} → ${rendered.sslRequired}`);
  }
  for (const want of rendered.clients ?? []) {
    const [have] = await (await fetch(`${admin}/clients?clientId=${encodeURIComponent(want.clientId)}`, { headers: h })).json();
    if (!have) { log(`client ${want.clientId}: not in the realm (created by hand? import skipped?) — not created`); continue; }
    const patch = clientPatch(have, want);
    if (!patch) continue;
    const r = await fetch(`${admin}/clients/${have.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ ...have, ...patch }) });
    if (!r.ok) throw new Error(`client ${want.clientId} update: HTTP ${r.status}`);
    changes.push(`client ${want.clientId}: ${Object.keys(patch).join(', ')}${patch.redirectUris ? ` → ${patch.redirectUris.join(' ')}` : ''}`);
  }
  log(changes.length ? `realm ${realm} synced: ${changes.join('; ')}` : `realm ${realm}: already in sync`);
  return changes;
}

module.exports = { sync, clientPatch };
if (require.main === module) {
  const [base, file] = process.argv.slice(2);
  if (!base || !file) { console.error('usage: node realm-sync.js <keycloak base URL> <realm.json>'); process.exit(2); }
  const { KC_BOOTSTRAP_ADMIN_USERNAME: username, KC_BOOTSTRAP_ADMIN_PASSWORD: password, REALM_SYNC_TIMEOUT } = process.env;
  if (!username || !password) { console.error('KC_BOOTSTRAP_ADMIN_USERNAME / KC_BOOTSTRAP_ADMIN_PASSWORD are required'); process.exit(2); }
  sync(base.replace(/\/+$/, ''), file, { username, password, timeoutSeconds: Number(REALM_SYNC_TIMEOUT ?? 300) }).catch((e) => { console.error(e.message); process.exit(1); });
}
