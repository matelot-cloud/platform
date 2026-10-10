import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** Encryption at rest for integration credentials, keyed per cell (CELL_ENCRYPTION_KEY). */
@Injectable()
export class CryptoService {
  private readonly key?: Buffer;

  constructor(@Inject(ConfigService) config: AppConfig) {
    const hex = config.get('CELL_ENCRYPTION_KEY', { infer: true });
    this.key = hex ? Buffer.from(hex, 'hex') : undefined;
  }

  get available(): boolean {
    return !!this.key;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new ServiceUnavailableException('CELL_ENCRYPTION_KEY is not configured on this cell');
    return this.key;
  }

  /** Output layout: iv (12) | auth tag (16) | ciphertext. */
  encrypt(plaintext: string): Buffer {
    const key = this.requireKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(payload: Buffer): string {
    const key = this.requireKey();
    const iv = payload.subarray(0, IV_LENGTH);
    const tag = payload.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Signed, expiring, URL-safe token for round trips through third parties (OAuth/App setup state). */
  signState(payload: Record<string, unknown>, ttlSeconds: number): string {
    const key = this.requireKey();
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
    const mac = createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verifyState<T extends Record<string, unknown>>(token: string): T | null {
    const key = this.requireKey();
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', key).update(body).digest('base64url');
    if (expected.length !== mac.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  }
}
