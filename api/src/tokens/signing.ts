import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request signature scheme "SecOps-HMAC-SHA256" (v1).
 *
 *   Authorization: SecOps-HMAC-SHA256 keyId=<id>,ts=<unix seconds>,nonce=<random>,sig=<hex>
 *   sig = HMAC-SHA256(secret, "v1\n" + ts + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))
 *
 * `path` is the request path including the query string, as sent (e.g. /api/v1/environments/<id>/deployments).
 * The secret never leaves the client; a captured request cannot be replayed (nonce, ±5 min) or altered (body hash).
 */
export const SIGNATURE_SCHEME = 'SecOps-HMAC-SHA256';
export const SIGNATURE_WINDOW_SECONDS = 300;

export interface SignatureHeader {
  keyId: string;
  ts: number;
  nonce: string;
  sig: string;
}

export function parseSignatureHeader(header: string | undefined): SignatureHeader | null {
  if (!header?.startsWith(`${SIGNATURE_SCHEME} `)) return null;
  const params = Object.fromEntries(
    header
      .slice(SIGNATURE_SCHEME.length + 1)
      .split(',')
      .map((kv) => kv.trim().split('=') as [string, string])
      .filter(([k, v]) => k && v),
  );
  const ts = Number(params.ts);
  if (!params.keyId || !Number.isFinite(ts) || !params.nonce || !params.sig) return null;
  return { keyId: params.keyId, ts, nonce: params.nonce, sig: params.sig };
}

export function stringToSign(ts: number, nonce: string, method: string, path: string, body: Buffer): string {
  return ['v1', String(ts), nonce, method.toUpperCase(), path, createHash('sha256').update(body).digest('hex')].join('\n');
}

export function sign(secret: string, ts: number, nonce: string, method: string, path: string, body: Buffer): string {
  return createHmac('sha256', secret).update(stringToSign(ts, nonce, method, path, body)).digest('hex');
}

export function verify(secret: string, header: SignatureHeader, method: string, path: string, body: Buffer, now = Math.floor(Date.now() / 1000)): { ok: boolean; reason?: string } {
  if (Math.abs(now - header.ts) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: 'timestamp outside the allowed window (check the clock of the CI runner)' };
  const expected = Buffer.from(sign(secret, header.ts, header.nonce, method, path, body));
  const given = Buffer.from(header.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}
