import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { of } from 'rxjs';
import { classify, isExempt, RateLimitInterceptor } from './rate-limit.interceptor';
import { MemoryRateLimitStore, RedisRateLimitStore } from './rate-limit.store';

const config = (env: Record<string, unknown>) => ({ get: (k: string) => env[k] }) as never;
function ctx(req: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  const context = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: (k: string, v: string) => { headers[k] = v; } }) }) } as unknown as ExecutionContext;
  return { context, headers };
}
const next: CallHandler = { handle: () => of('ok') };

describe('rate limits', () => {
  it('classifies callers: runner, CI token, user (read / write separately), anonymous by IP', () => {
    expect(classify({ method: 'POST', runner: { runner: { id: 'r1' } } })).toEqual({ cls: 'runner', key: 'runner:r1' }); // the guard's principal shape
    expect(classify({ method: 'GET', user: { id: 'u1', token: { id: 't1' } } as never })).toEqual({ cls: 'read', key: 'ci:t1:r' });
    expect(classify({ method: 'POST', user: { id: 'u1' } as never })).toEqual({ cls: 'write', key: 'user:u1:w' });
    expect(classify({ method: 'HEAD', user: { id: 'u1' } as never })).toEqual({ cls: 'read', key: 'user:u1:r' });
    expect(classify({ method: 'POST', ip: '10.0.0.7' })).toEqual({ cls: 'anonymous', key: 'ip:10.0.0.7' });
  });

  it('exempts health, webhooks, registry token/events and discovery documents', () => {
    for (const p of ['/api/v1/health', '/api/v1/health/ready', '/api/v1/webhooks/github/abc', '/api/v1/registry/token', '/api/v1/registry/events', '/.well-known/jwks.json']) expect(isExempt(p)).toBe(true);
    for (const p of ['/api/v1/organizations', '/api/v1/registry/info', '/api/v1/oauth/token', '/api/v1/healthy']) expect(isExempt(p)).toBe(false);
  });

  it('counts per caller, sets RateLimit headers, answers 429 with Retry-After over the limit, and other callers are unaffected', async () => {
    const i = new RateLimitInterceptor(config({ NODE_ENV: 'test', RATE_LIMIT_WRITE_PER_MINUTE: 3 }), new MemoryRateLimitStore());
    const req = { method: 'POST', originalUrl: '/api/v1/organizations/o/projects', user: { id: 'u1' } };
    for (let n = 1; n <= 3; n++) {
      const { context, headers } = ctx(req);
      await i.intercept(context, next);
      expect(headers['RateLimit-Limit']).toBe('3');
      expect(headers['RateLimit-Remaining']).toBe(String(3 - n));
    }
    const { context, headers } = ctx(req);
    const err = await i.intercept(context, next).then(() => null, (e: HttpException) => e);
    expect(err?.getStatus()).toBe(429);
    expect(String((err?.getResponse() as { message: string }).message)).toMatch(/3 write requests per minute for this user/);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
    // reads have their own window, and another user is not affected
    await expect(i.intercept(ctx({ ...req, method: 'GET' }).context, next)).resolves.toBeDefined();
    await expect(i.intercept(ctx({ ...req, user: { id: 'u2' } }).context, next)).resolves.toBeDefined();
  });

  it('exempt paths, a 0 limit and RATE_LIMIT_ENABLED=false never count', async () => {
    const store = new MemoryRateLimitStore();
    const i = new RateLimitInterceptor(config({ NODE_ENV: 'test', RATE_LIMIT_ANONYMOUS_PER_MINUTE: 0 }), store);
    await i.intercept(ctx({ method: 'POST', originalUrl: '/api/v1/webhooks/github', ip: '1.1.1.1' }).context, next);
    await i.intercept(ctx({ method: 'POST', originalUrl: '/api/v1/oauth/token', ip: '1.1.1.1' }).context, next);
    expect(store.size).toBe(0);
    const off = new RateLimitInterceptor(config({ NODE_ENV: 'test', RATE_LIMIT_ENABLED: false, RATE_LIMIT_READ_PER_MINUTE: 1 }), store);
    for (let n = 0; n < 5; n++) await off.intercept(ctx({ method: 'GET', originalUrl: '/api/v1/x', user: { id: 'u' } }).context, next);
    expect(store.size).toBe(0);
  });

  it('windows reset after a minute', async () => {
    const s = new MemoryRateLimitStore();
    const t0 = 1_800_000_000_000;
    expect((await s.hit('k', 60_000, t0)).count).toBe(1);
    expect((await s.hit('k', 60_000, t0 + 1000)).count).toBe(2);
    expect((await s.hit('k', 60_000, t0 + 61_000)).count).toBe(1);
  });

  it('Redis unreachable: counts per process instead of failing or hanging the request', async () => {
    const messages: (string | null)[] = [];
    const s = new RedisRateLimitStore('redis://127.0.0.1:1', (m) => messages.push(m));
    const started = Date.now();
    const a = await s.hit('k', 60_000);
    const b = await s.hit('k', 60_000);
    expect([a.count, b.count]).toEqual([1, 2]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(messages).toHaveLength(1); // logged once per outage
    await s.close();
  });
});
