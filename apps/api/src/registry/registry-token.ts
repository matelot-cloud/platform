import { createHash, createPrivateKey, createPublicKey, KeyObject, randomBytes, sign, verify } from 'node:crypto';

/**
 * Docker Distribution token auth (https://distribution.github.io/distribution/spec/auth/jwt/).
 * The registry trusts tokens signed by our key; the JWT header carries a `kid` derived from the
 * public key exactly the way libtrust does (base32 of the SHA-256 of the DER public key, first 240
 * bits, in groups of four separated by colons).
 */
export interface RegistryAccess {
  type: 'repository' | 'registry';
  name: string;
  actions: string[];
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function libtrustKeyId(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const hash = createHash('sha256').update(der).digest();
  const encoded = base32(hash.subarray(0, 30)); // 240 bits → 48 chars
  return encoded.match(/.{1,4}/g)!.join(':');
}

export function loadRegistryKey(pem: string): { privateKey: KeyObject; publicKey: KeyObject; kid: string } {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: libtrustKeyId(publicKey) };
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

export function issueRegistryToken(key: { privateKey: KeyObject; kid: string }, options: { issuer: string; service: string; subject: string; access: RegistryAccess[]; ttlSeconds?: number }): { token: string; expiresIn: number; issuedAt: string } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 300;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: key.kid }));
  const payload = b64url(JSON.stringify({ iss: options.issuer, sub: options.subject, aud: options.service, exp: now + ttl, nbf: now - 30, iat: now, jti: randomBytes(16).toString('hex'), access: options.access }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.privateKey).toString('base64url');
  return { token: `${header}.${payload}.${signature}`, expiresIn: ttl, issuedAt: new Date(now * 1000).toISOString() };
}

/** Parses Distribution `scope` query values: repository:acme/app:push,pull */
export function parseScopes(scope: string | string[] | undefined): RegistryAccess[] {
  const list = Array.isArray(scope) ? scope : scope ? [scope] : [];
  return list
    .map((s) => {
      const [type, ...rest] = s.split(':');
      if (rest.length < 2) return null;
      const actions = rest.pop()!.split(',').filter(Boolean);
      return { type: type as RegistryAccess['type'], name: rest.join(':'), actions };
    })
    .filter((x): x is RegistryAccess => !!x);
}

/** Verifies a token this cell issued (used when a client re-presents it as a password). */
export function verifyRegistryToken(publicKey: KeyObject, token: string): { sub: string; access: RegistryAccess[] } | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { sub: string; exp: number; access?: RegistryAccess[] };
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return { sub: claims.sub, access: claims.access ?? [] };
}
