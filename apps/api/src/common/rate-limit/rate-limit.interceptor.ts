import { CallHandler, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, Logger, NestInterceptor, OnApplicationShutdown, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import type { AppConfig } from '../../config/env';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { MemoryRateLimitStore, RateLimitStore, RedisRateLimitStore } from './rate-limit.store';

/** Optional provider to replace the store (tests). */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export type RateLimitClass = 'read' | 'write' | 'anonymous' | 'runner' | 'authFailures';
export interface RateLimits { enabled: boolean; windowMs: number; read: number; write: number; anonymous: number; runner: number; authFailures: number }

/**
 * Successful requests on these paths are never counted: health probes, signed webhooks, docker token / notification
 * traffic (pulls are bursty), discovery documents. Their FAILED authentication still counts (see onAuthFailure).
 */
const EXEMPT = [/^\/api\/v1\/health(\/|$)/, /^\/api\/v1\/webhooks\//, /^\/api\/v1\/registry\/(token|events)(\/|\?|$)/, /^\/\.well-known\//];

interface LimitedRequest {
  method: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  ip?: string;
  user?: AuthenticatedUser;
  /** Set by RunnerAuthGuard (a guard, so before this interceptor): `{ runner, pool }`. */
  runner?: { runner?: { id: string }; id?: string };
}

/** Which bucket a request counts against, and the key of that bucket. */
export function classify(req: LimitedRequest): { cls: RateLimitClass; key: string } {
  // RunnerAuthGuard stores the principal { runner, pool }; reading req.runner.id (always undefined) used to drop every
  // runner into the per-IP anonymous bucket (120/min shared by all runners behind one address)
  const runnerId = req.runner?.runner?.id ?? req.runner?.id;
  if (runnerId) return { cls: 'runner', key: `runner:${runnerId}` };
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  if (req.user?.token?.id) return { cls: write ? 'write' : 'read', key: `ci:${req.user.token.id}:${write ? 'w' : 'r'}` };
  if (req.user?.id) return { cls: write ? 'write' : 'read', key: `user:${req.user.id}:${write ? 'w' : 'r'}` };
  return { cls: 'anonymous', key: `ip:${req.ip ?? 'unknown'}` };
}

export const isExempt = (path: string) => EXEMPT.some((r) => r.test(path));

/**
 * Per-caller request limits (fixed one-minute windows): people and personal tokens by user, CI tokens by token, runners
 * by runner, anonymous calls by client IP; reads and writes counted separately. Runs after the guards, so the caller
 * is known. Every limited response carries RateLimit-Limit / -Remaining / -Reset; over the limit → 429 + Retry-After.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor, OnApplicationShutdown {
  private readonly logger = new Logger(RateLimitInterceptor.name);
  readonly limits: RateLimits;
  readonly store: RateLimitStore;

  constructor(@Inject(ConfigService) config: AppConfig, @Optional() @Inject(RATE_LIMIT_STORE) store?: RateLimitStore) {
    this.limits = {
      enabled: config.get('RATE_LIMIT_ENABLED', { infer: true }) !== false,
      windowMs: 60_000,
      read: config.get('RATE_LIMIT_READ_PER_MINUTE', { infer: true }) ?? 1200,
      write: config.get('RATE_LIMIT_WRITE_PER_MINUTE', { infer: true }) ?? 300,
      anonymous: config.get('RATE_LIMIT_ANONYMOUS_PER_MINUTE', { infer: true }) ?? 120,
      runner: config.get('RATE_LIMIT_RUNNER_PER_MINUTE', { infer: true }) ?? 1200,
      authFailures: config.get('RATE_LIMIT_AUTH_FAILURES_PER_MINUTE', { infer: true }) ?? 30,
    };
    this.store = store ?? (config.get('NODE_ENV', { infer: true }) === 'test'
      ? new MemoryRateLimitStore()
      : new RedisRateLimitStore(config.get('REDIS_URL', { infer: true }), (m) => m ? this.logger.warn(`rate limits: Redis unavailable (${m}); counting per process until it is back`) : this.logger.log('rate limits: Redis is back')));
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (!this.limits.enabled || context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<LimitedRequest>();
    const res = http.getResponse<{ setHeader: (k: string, v: string) => void }>();
    const path = (req.originalUrl ?? req.url ?? req.path ?? '').split('?')[0]!;
    if (isExempt(path)) return next.handle();
    const { cls, key } = classify(req);
    const limit = this.limits[cls];
    if (!limit) return next.handle(); // 0 = unlimited for that class
    const now = Date.now();
    const { count, resetAt } = await this.store.hit(key, this.limits.windowMs, now);
    const resetSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      throw new HttpException({ statusCode: 429, error: 'Too Many Requests', message: `Rate limit exceeded: ${limit} ${cls === 'anonymous' ? 'unauthenticated' : cls} requests per minute for this ${cls === 'runner' ? 'runner' : cls === 'anonymous' ? 'address' : req.user?.token ? 'CI token' : 'user'}. Retry in ${resetSeconds} s.`, limit, class: cls, retryAfterSeconds: resetSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return next.handle();
  }

  /**
   * Called by the global exception filter for 401 / 403 — those are thrown by the guards (or the registry token / webhook
   * handlers) before this interceptor runs, so they would otherwise never be counted. 401 (no valid credential): per client
   * IP in the auth-failure class, every path included (registry token, webhooks, registry events). 403 (authenticated, not
   * allowed): the caller's own read / write bucket. Returns the 429 to send instead once over the limit, else null.
   * Requests that authenticate are never affected by an address's failures.
   */
  async onAuthFailure(req: LimitedRequest, res: { setHeader: (k: string, v: string) => void }, status: number): Promise<HttpException | null> {
    if (!this.limits.enabled) return null;
    const unauthenticated = status === 401 || !req.user?.id;
    const { cls, key } = unauthenticated ? { cls: 'authFailures' as const, key: `authfail:ip:${req.ip ?? 'unknown'}` } : classify(req);
    const limit = this.limits[cls];
    if (!limit) return null;
    const now = Date.now();
    const { count, resetAt } = await this.store.hit(key, this.limits.windowMs, now);
    const resetSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    if (count <= limit) return null;
    res.setHeader('Retry-After', String(resetSeconds));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', '0');
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    const message = unauthenticated
      ? `Too many failed authentication attempts from this address: ${limit} per minute. Retry in ${resetSeconds} s.`
      : `Rate limit exceeded: ${limit} ${cls} requests per minute for this ${req.user?.token ? 'CI token' : 'user'}. Retry in ${resetSeconds} s.`;
    return new HttpException({ statusCode: 429, error: 'Too Many Requests', message, limit, class: cls, retryAfterSeconds: resetSeconds }, HttpStatus.TOO_MANY_REQUESTS);
  }

  async onApplicationShutdown() {
    if (this.store instanceof RedisRateLimitStore) await this.store.close();
  }
}
