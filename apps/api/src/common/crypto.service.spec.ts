import type { AppConfig } from '../config/env';
import { CryptoService } from './crypto.service';

const config = (key?: string) => ({ get: () => key }) as unknown as AppConfig;

describe('CryptoService', () => {
  const service = new CryptoService(config('0'.repeat(64)));

  it('round-trips secrets with a fresh IV each time', () => {
    const a = service.encrypt('ghp_secret');
    const b = service.encrypt('ghp_secret');
    expect(a.equals(b)).toBe(false);
    expect(service.decrypt(a)).toBe('ghp_secret');
    expect(service.decrypt(b)).toBe('ghp_secret');
  });

  it('rejects tampered ciphertext', () => {
    const payload = service.encrypt('value');
    payload[payload.length - 1] ^= 0xff;
    expect(() => service.decrypt(payload)).toThrow();
  });

  it('signs and verifies state tokens, rejecting forgeries and expiry', () => {
    const token = service.signState({ organizationId: 'org', userId: 'u1' }, 60);
    expect(service.verifyState<{ organizationId: string }>(token)?.organizationId).toBe('org');
    expect(service.verifyState(token.slice(0, -2) + 'zz')).toBeNull();
    const expired = service.signState({ organizationId: 'org' }, -1);
    expect(service.verifyState(expired)).toBeNull();
  });

  it('reports unavailability without a key', () => {
    const none = new CryptoService(config(undefined));
    expect(none.available).toBe(false);
    expect(() => none.encrypt('x')).toThrow();
  });
});
