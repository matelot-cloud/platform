#!/usr/bin/env node
/**
 * Fake identity provider for local/e2e testing without Keycloak.
 * Serves a JWKS at <issuer>/protocol/openid-connect/certs and mints RS256 access tokens
 * shaped like Keycloak's (iss, aud, sub, email, preferred_username, name).
 *
 *   node test/fake-idp.js serve   # http://localhost:8089/realms/platform
 *   node test/fake-idp.js token admin@acme.local "Cell Admin"
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.FAKE_IDP_PORT || 8089);
const ISSUER = process.env.FAKE_IDP_ISSUER || `http://localhost:${PORT}/realms/platform`;
const AUDIENCE = process.env.FAKE_IDP_AUDIENCE || 'platform-api';
const KEY_FILE = path.join(os.tmpdir(), 'secops-fake-idp.pem');
const KID = 'fake-idp-key-1';

function loadOrCreateKey() {
  if (fs.existsSync(KEY_FILE)) return crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return privateKey;
}

const b64url = (input) => Buffer.from(input).toString('base64url');

function mintToken(privateKey, email, name, ttlSeconds = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const payload = {
    iss: ISSUER,
    aud: [AUDIENCE, 'account'],
    azp: 'platform-web',
    sub: crypto.createHash('sha256').update(email).digest('hex').slice(0, 32),
    typ: 'Bearer',
    iat: now,
    exp: now + ttlSeconds,
    email,
    email_verified: true,
    preferred_username: email.split('@')[0],
    name,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function serve(privateKey) {
  const jwk = { ...crypto.createPublicKey(privateKey).export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
  const realmPath = new URL(ISSUER).pathname;
  http
    .createServer((req, res) => {
      if (req.url === `${realmPath}/protocol/openid-connect/certs`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ keys: [jwk] }));
      }
      res.writeHead(404);
      res.end();
    })
    .listen(PORT, () => console.log(`fake idp: issuer=${ISSUER} jwks=${ISSUER}/protocol/openid-connect/certs`));
}

const [command, email = 'admin@acme.local', name = 'Cell Admin'] = process.argv.slice(2);
const key = loadOrCreateKey();
if (command === 'serve') serve(key);
else if (command === 'token') process.stdout.write(mintToken(key, email, name));
else {
  console.error('usage: fake-idp.js serve | token <email> [name]');
  process.exit(1);
}
