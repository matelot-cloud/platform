import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { CryptoService } from '../common/crypto.service';
import { DATABASE, Database } from '../database/database.module';
import { apiTokens } from '../database/schema';
import { QueueService } from '../jobs/queue.service';
import { parseSignatureHeader, SIGNATURE_SCHEME, SIGNATURE_WINDOW_SECONDS, verify } from './signing';

/**
 * Runs before the JWT guard: if the request carries a SecOps-HMAC signature, it is verified here and
 * the request continues as a token principal. Nonces are single-use (Redis, TTL = window).
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly queue: QueueService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: unknown; rawBody?: Buffer; apiTokenAuthenticated?: boolean }>();
    const header = request.headers.authorization;
    if (!header?.startsWith(`${SIGNATURE_SCHEME} `)) return true; // not ours: JWT guard decides
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const sig = parseSignatureHeader(header);
    if (!sig) throw new UnauthorizedException('Malformed signature header');
    const [token] = await this.db.select().from(apiTokens).where(eq(apiTokens.keyId, sig.keyId)).limit(1);
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt < new Date())) throw new UnauthorizedException('Unknown, expired or revoked token');
    const secret = this.crypto.decrypt(Buffer.from(token.secretEncrypted));
    const body = request.rawBody ?? Buffer.alloc(0);
    const result = verify(secret, sig, request.method, request.originalUrl, body);
    if (!result.ok) throw new UnauthorizedException(`Invalid signature: ${result.reason}`);

    // Replay protection: a nonce may be used once within the window.
    const redis = this.queue.redis;
    const fresh = await redis.set(`sig:${token.id}:${sig.nonce}`, '1', 'EX', SIGNATURE_WINDOW_SECONDS * 2, 'NX');
    if (fresh !== 'OK') throw new UnauthorizedException('Replayed request (nonce already used)');

    await this.db.update(apiTokens).set({ lastUsedAt: new Date(), lastUsedFrom: request.ip ?? null }).where(eq(apiTokens.id, token.id));
    request.user = {
      id: `token:${token.id}`,
      email: `ci-token:${token.keyId}`,
      displayName: token.name,
      externalId: token.keyId,
      platformRole: 'user',
      token: { id: token.id, name: token.name, scopeType: token.scopeType, scopeId: token.scopeId, permissions: token.permissions, environments: token.environments },
    };
    request.apiTokenAuthenticated = true;
    return true;
  }
}
