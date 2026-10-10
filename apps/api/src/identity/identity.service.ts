import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, randomUUID, sign } from 'node:crypto';
import { CryptoService } from '../common/crypto.service';
import type { Env } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { signingKeys } from '../database/schema';
import { setIdentityTokenIssuer } from '../integrations/registry-auth';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * The cell as an OpenID issuer for workload identity federation. GCP workload identity pools, AWS IAM OIDC providers
 * and Azure federated credentials trust tokens signed with this key, so registry connections store no cloud secret.
 * Subject `integration:<connection id>`; tokens live 10 minutes and carry one audience.
 */
@Injectable()
export class IdentityService implements OnModuleInit {
  private readonly logger = new Logger(IdentityService.name);
  readonly issuer: string;
  private key: { kid: string; privateKey: KeyObject } | null = null;

  constructor(@Inject(DATABASE) private readonly db: Database, private readonly config: ConfigService<Env, true>, private readonly crypto: CryptoService) {
    this.issuer = (config.get('API_PUBLIC_URL', { infer: true }) ?? `http://localhost:${config.get('PORT', { infer: true })}`).replace(/\/$/, '');
  }

  async onModuleInit() {
    if (!this.config.get('API_PUBLIC_URL', { infer: true })) {
      this.logger.warn(`API_PUBLIC_URL is not set: keyless registry connections use issuer ${this.issuer}, which cloud providers cannot reach (and which differs between the API and the worker)`);
    }
    await this.ensureKey().catch((e: Error) => this.logger.error(`identity key unavailable: ${e.message}`));
    setIdentityTokenIssuer((integrationId, audience) => this.issue({ subject: this.subjectFor(integrationId), audience, claims: { integration: integrationId } }));
  }

  subjectFor(integrationId: string) { return `integration:${integrationId}`; }

  /** The active key; created on first boot (RSA 2048, private part encrypted with the cell key). */
  async ensureKey(): Promise<{ kid: string; privateKey: KeyObject }> {
    if (this.key) return this.key;
    // The API and the worker(s) boot together: serialise read-or-create / rotate so only one active key is ever minted.
    const key = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('matelot.identity-key'))`);
      const [row] = await tx.select().from(signingKeys)
        .where(and(eq(signingKeys.purpose, 'identity'), isNull(signingKeys.retiredAt)))
        .orderBy(desc(signingKeys.createdAt)).limit(1);
      if (row) {
        try {
          return { kid: row.kid, privateKey: createPrivateKey(this.crypto.decrypt(Buffer.from(row.privatePemEncrypted))) };
        } catch (e) {
          // CELL_ENCRYPTION_KEY changed: retire the unreadable key (its public part stays in the JWKS) and mint a new one.
          this.logger.warn(`identity key ${row.kid} cannot be decrypted with the current cell key (${e instanceof Error ? e.message : String(e)}); rotating`);
          await tx.update(signingKeys).set({ retiredAt: new Date() }).where(and(eq(signingKeys.purpose, 'identity'), isNull(signingKeys.retiredAt)));
        }
      }
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      const kid = createHash('sha256').update(publicPem).digest('base64url').slice(0, 16);
      await tx.insert(signingKeys).values({ kid, purpose: 'identity', publicPem, privatePemEncrypted: this.crypto.encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string) });
      this.logger.log(`identity key created (kid ${kid}); issuer ${this.issuer}`);
      return { kid, privateKey };
    });
    this.key = key;
    return key;
  }

  openidConfiguration() {
    return {
      issuer: this.issuer,
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
      response_types_supported: ['id_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'nbf', 'jti', 'integration'],
      scopes_supported: ['openid'],
    };
  }

  /** Every identity key, including retired ones (clouds may still hold tokens or cache the old kid). */
  async jwks() {
    const rows = await this.db.select().from(signingKeys).where(eq(signingKeys.purpose, 'identity'));
    return { keys: rows.map((r) => ({ ...(createPublicKey(r.publicPem).export({ format: 'jwk' }) as Record<string, string>), kid: r.kid, use: 'sig', alg: 'RS256' })) };
  }

  /** A short-lived RS256 JWT for one audience (default 10 minutes; clouds reject long-lived assertions). */
  async issue(input: { subject: string; audience: string; claims?: Record<string, unknown>; ttlSeconds?: number }): Promise<string> {
    const key = await this.ensureKey();
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }));
    const payload = b64url(JSON.stringify({ iss: this.issuer, sub: input.subject, aud: input.audience, iat: now, nbf: now - 30, exp: now + (input.ttlSeconds ?? 600), jti: randomUUID(), ...(input.claims ?? {}) }));
    return `${header}.${payload}.${b64url(sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.privateKey))}`;
  }
}
