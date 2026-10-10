import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createAppJwt, verifyWebhookSignature } from './github-app.client';

describe('GitHub App client helpers', () => {
  it('creates an RS256 JWT for the app that verifies with the public key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = createAppJwt('12345', privateKey, 1_700_000_000);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_420, iss: '12345' });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('verifies webhook signatures in constant time and rejects bad ones', () => {
    const body = Buffer.from('{"action":"created"}');
    const good = 'sha256=' + require('node:crypto').createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifyWebhookSignature('s3cret', body, good)).toBe(true);
    expect(verifyWebhookSignature('s3cret', body, good.replace(/.$/, '0'))).toBe(false);
    expect(verifyWebhookSignature('other', body, good)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, undefined)).toBe(false);
    expect(verifyWebhookSignature('s3cret', body, 'sha1=abc')).toBe(false);
  });
});
