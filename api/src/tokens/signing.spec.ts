import { parseSignatureHeader, sign, SIGNATURE_SCHEME, verify } from './signing';

describe('request signing', () => {
  const secret = 'sk_test_secret';
  const body = Buffer.from('{"version":"1.2.0"}');
  const path = '/api/v1/environments/abc/deployments';

  it('round-trips a signature and parses the header', () => {
    const ts = 1_700_000_000;
    const sig = sign(secret, ts, 'n1', 'POST', path, body);
    const header = parseSignatureHeader(`${SIGNATURE_SCHEME} keyId=k1,ts=${ts},nonce=n1,sig=${sig}`)!;
    expect(header.keyId).toBe('k1');
    expect(verify(secret, header, 'POST', path, body, ts + 10).ok).toBe(true);
  });

  it('rejects altered bodies, wrong secrets, old timestamps and malformed headers', () => {
    const ts = 1_700_000_000;
    const sig = sign(secret, ts, 'n1', 'POST', path, body);
    const header = { keyId: 'k1', ts, nonce: 'n1', sig };
    expect(verify(secret, header, 'POST', path, Buffer.from('{"version":"9.9.9"}'), ts).ok).toBe(false);
    expect(verify('other', header, 'POST', path, body, ts).ok).toBe(false);
    expect(verify(secret, header, 'POST', path, body, ts + 600).reason).toMatch(/window/);
    expect(verify(secret, header, 'GET', path, body, ts).ok).toBe(false);
    expect(parseSignatureHeader('Bearer abc')).toBeNull();
    expect(parseSignatureHeader(`${SIGNATURE_SCHEME} keyId=k1,ts=abc,nonce=n,sig=s`)).toBeNull();
  });
});
