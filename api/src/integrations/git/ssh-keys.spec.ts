import { generateDeployKey } from './ssh-keys';

describe('generateDeployKey', () => {
  it('produces an OpenSSH public key and a PEM private key that match', () => {
    const key = generateDeployKey('test');
    expect(key.publicKeyOpenSsh.startsWith('ssh-rsa AAAAB3NzaC1yc2E')).toBe(true);
    expect(key.publicKeyOpenSsh.endsWith(' test')).toBe(true);
    expect(key.privateKeyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // The wire-format public key decodes to the same modulus as the private key
    const { createPrivateKey, createPublicKey } = require('node:crypto') as typeof import('node:crypto');
    const derived = createPublicKey(createPrivateKey(key.privateKeyPem)).export({ format: 'jwk' }) as { n: string };
    const wire = Buffer.from(key.publicKeyOpenSsh.split(' ')[1], 'base64');
    expect(wire.toString('hex')).toContain(Buffer.from(derived.n, 'base64url').toString('hex'));
  });
});
