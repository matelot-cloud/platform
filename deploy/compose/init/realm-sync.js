// Keycloak realm sync — what `start --import-realm` does not do. The import strategy is IGNORE_EXISTING: after the
// first start the realm in the database never changes, so a domain or scheme change (http → https, a new hostname)
// leaves the clients' redirect URIs behind ("Invalid parameter: redirect_uri"). This applies the rendered realm.json's
// URL-shaped settings through the admin API and nothing else: realm sslRequired and the login/account/email themes
// (ours), the display names only while they still carry the old templated suffix, and per client (matched by clientId)
// redirectUris, webOrigins, rootUrl, baseUrl, adminUrl, the post-logout redirect attribute. Users, groups, roles,
// credentials and anything created by hand stay untouched; clients missing in the realm are reported, not created.
// It also seeds the first administrators: every e-mail in SEED_USERS that has no user in the realm gets one (username =
// e-mail, enabled, verified) with SEED_PASSWORD as a TEMPORARY password — the first login forces a change. Users that
// exist are never modified (not their password, not their flags), so the operator's or the IdP's users are safe.
// Runs as the chart's post-install/post-upgrade hook Job and as `compose-init.sh realm-update`.
//   node realm-sync.js <keycloak base URL, e.g. http://acme-keycloak:8080 or http://keycloak:8080/auth> <realm.json>
//   env: KC_BOOTSTRAP_ADMIN_USERNAME, KC_BOOTSTRAP_ADMIN_PASSWORD (the bootstrap admin of the master realm)
//        SEED_USERS (comma-separated e-mails, optional), SEED_PASSWORD (their initial temporary password)
//        REALM_SYNC_TIMEOUT (seconds to wait for Keycloak, default 300)
'use strict';
const fs = require('node:fs');

const CLIENT_FIELDS = ['redirectUris', 'webOrigins', 'rootUrl', 'baseUrl', 'adminUrl'];

/** First / last name from an e-mail's local part when it has two parts ("jane.doe", "jane_doe"), else none — never a
 *  placeholder: with no name, the platform shows the e-mail and derives initials from it. */
function namesFromEmail(email) {
  const parts = email.split('@')[0].split(/[._-]+/).filter(Boolean);
  if (parts.length < 2) return {};
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return { firstName: cap(parts[0]), lastName: parts.slice(1).map(cap).join(' ') };
}

/** Keycloak 24+ ships a user profile in which firstName and lastName are REQUIRED: a user created without them (seeded
 *  admins, invited users, service-account owners) is stopped at first login by an "update your profile" form and
 *  types whatever gets them through ("test test"). Names are optional here; e-mail stays required. */
async function relaxUserProfile(admin, h) {
  const r = await fetch(`${admin}/users/profile`, { headers: h });
  if (!r.ok) return null;   // older Keycloak without the declarative user profile: nothing to relax
  const profile = await r.json();
  let changed = false;
  for (const a of profile.attributes ?? []) {
    if ((a.name === 'firstName' || a.name === 'lastName') && a.required) { delete a.required; changed = true; }
  }
  if (!changed) return null;
  const u = await fetch(`${admin}/users/profile`, { method: 'PUT', headers: h, body: JSON.stringify(profile) });
  if (!u.ok) throw new Error(`user profile update: HTTP ${u.status}`);
  return 'user profile: first and last name optional';
}
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

/** The realm display names the templates used to render before the product had a name: migrated once to the plain
 * tenant name; a display name an administrator typed by hand is kept. */
const STALE_DISPLAY_NAME = /( Security Platform| · Matelot)$/;

/**
 * Pure: the realm-level settings to PUT. Applied on every run like the URLs: sslRequired (scheme), and the themes
 * (loginTheme / accountTheme / emailTheme — ours, so an upgrade that ships a new theme reaches existing cells).
 * displayName / displayNameHtml are applied only while the realm still carries the old templated form (or none).
 */
function realmSettingsPatch(current, rendered) {
  const patch = {};
  if ('sslRequired' in rendered && current.sslRequired !== rendered.sslRequired) patch.sslRequired = rendered.sslRequired;
  for (const k of ['loginTheme', 'accountTheme', 'emailTheme']) if (k in rendered && (current[k] ?? '') !== (rendered[k] ?? '')) patch[k] = rendered[k];
  for (const k of ['displayName', 'displayNameHtml']) {
    if (!(k in rendered) || current[k] === rendered[k]) continue;
    if (!current[k] || STALE_DISPLAY_NAME.test(current[k])) patch[k] = rendered[k];
  }
  return Object.keys(patch).length ? patch : null;
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
  // a rendered secret is the one the consumer (Grafana's env) was given: keep Keycloak's copy equal to it
  if (typeof rendered.secret === 'string' && rendered.secret && current.secret !== rendered.secret) patch.secret = rendered.secret;
  return Object.keys(patch).length ? patch : null;
}

async function sync(base, realmFile, { username, password, timeoutSeconds = 300, log = console.log, seedUsers = [], seedPassword = '' } = {}) {
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
  const realmPatch = realmSettingsPatch(current, rendered);
  if (realmPatch) {
    const r = await fetch(admin, { method: 'PUT', headers: h, body: JSON.stringify(realmPatch) });
    if (!r.ok) throw new Error(`realm update: HTTP ${r.status}`);
    changes.push(...Object.keys(realmPatch).map((k) => `realm ${k} ${JSON.stringify(current[k] ?? null)} → ${JSON.stringify(realmPatch[k])}`));
  }
  const profileChange = await relaxUserProfile(admin, h);
  if (profileChange) changes.push(profileChange);
  for (const want of rendered.clients ?? []) {
    const [have] = await (await fetch(`${admin}/clients?clientId=${encodeURIComponent(want.clientId)}`, { headers: h })).json();
    if (!have) {
      // clients added after the first import (an optional component turned on later, e.g. Grafana with the
      // observability profile) say so; the product's own clients are never re-created behind an administrator's back
      if ((want.attributes ?? {})['matelot.createIfMissing'] !== 'true') { log(`client ${want.clientId}: not in the realm (created by hand? import skipped?) — not created`); continue; }
      const r = await fetch(`${admin}/clients`, { method: 'POST', headers: h, body: JSON.stringify(want) });
      if (!r.ok && r.status !== 409) throw new Error(`client ${want.clientId} create: HTTP ${r.status} ${await r.text().catch(() => '')}`.trim());
      if (r.ok) changes.push(`client ${want.clientId} created`);
      continue;
    }
    const patch = clientPatch(have, want);
    if (!patch) continue;
    const r = await fetch(`${admin}/clients/${have.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ ...have, ...patch }) });
    if (!r.ok) throw new Error(`client ${want.clientId} update: HTTP ${r.status}`);
    changes.push(`client ${want.clientId}: ${Object.keys(patch).map((k) => (k === 'secret' ? 'secret (rotated to the rendered one)' : k)).join(', ')}${patch.redirectUris ? ` → ${patch.redirectUris.join(' ')}` : ''}`);
  }
  for (const email of seedUsers.map((e) => e.trim().toLowerCase()).filter(Boolean)) {
    const found = await (await fetch(`${admin}/users?email=${encodeURIComponent(email)}&exact=true`, { headers: h })).json();
    if (Array.isArray(found) && found.length) continue;   // exists: never touched
    if (!seedPassword) { log(`user ${email}: missing and no SEED_PASSWORD — not created`); continue; }
    const r = await fetch(`${admin}/users`, { method: 'POST', headers: h, body: JSON.stringify({ username: email, email, enabled: true, emailVerified: true, ...namesFromEmail(email), credentials: [{ type: 'password', value: seedPassword, temporary: true }] }) });
    if (!r.ok && r.status !== 409) throw new Error(`user ${email} create: HTTP ${r.status} ${await r.text().catch(() => '')}`.trim());
    if (r.ok) changes.push(`user ${email} created (temporary password: the first login asks for a new one)`);
  }
  log(changes.length ? `realm ${realm} synced: ${changes.join('; ')}` : `realm ${realm}: already in sync`);
  return changes;
}

module.exports = { sync, clientPatch, namesFromEmail, realmSettingsPatch };
if (require.main === module) {
  const [base, file] = process.argv.slice(2);
  if (!base || !file) { console.error('usage: node realm-sync.js <keycloak base URL> <realm.json>'); process.exit(2); }
  const { KC_BOOTSTRAP_ADMIN_USERNAME: username, KC_BOOTSTRAP_ADMIN_PASSWORD: password, REALM_SYNC_TIMEOUT, SEED_USERS, SEED_PASSWORD } = process.env;
  if (!username || !password) { console.error('KC_BOOTSTRAP_ADMIN_USERNAME / KC_BOOTSTRAP_ADMIN_PASSWORD are required'); process.exit(2); }
  sync(base.replace(/\/+$/, ''), file, { username, password, timeoutSeconds: Number(REALM_SYNC_TIMEOUT ?? 300), seedUsers: (SEED_USERS ?? '').split(','), seedPassword: SEED_PASSWORD ?? '' }).catch((e) => { console.error(e.message); process.exit(1); });
}
