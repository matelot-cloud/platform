import { createHash, createHmac, randomBytes } from 'node:crypto';

/** SecOps-HMAC-SHA256 v1 — identical to apps/api/src/tokens/signing.ts. */
export function signatureHeader(keyId: string, secret: string, method: string, path: string, body: Buffer, now = Math.floor(Date.now() / 1000)): string {
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', secret).update(['v1', String(now), nonce, method.toUpperCase(), path, bodyHash].join('\n')).digest('hex');
  return `SecOps-HMAC-SHA256 keyId=${keyId},ts=${now},nonce=${nonce},sig=${sig}`;
}
