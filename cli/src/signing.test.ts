import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { signatureHeader } from './signing';

test('signature header matches the platform scheme', () => {
  const body = Buffer.from('{"version":"1.0.0"}');
  const header = signatureHeader('sk_1', 'sec', 'POST', '/api/v1/x', body, 1_700_000_000);
  const m = /^SecOps-HMAC-SHA256 keyId=sk_1,ts=1700000000,nonce=([0-9a-f]{32}),sig=([0-9a-f]{64})$/.exec(header);
  assert.ok(m);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const expected = createHmac('sha256', 'sec').update(['v1', '1700000000', m![1], 'POST', '/api/v1/x', bodyHash].join('\n')).digest('hex');
  assert.equal(m![2], expected);
});
