import { Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../../database/schema';
import { DATABASE } from '../../database/database.module';
import { hashToken, RunnerAuth, RunnerAuthGuard } from '../../execution/runner-auth';
import { DatabaseExceptionFilter } from '../database-exception.filter';
import { RateLimitInterceptor, RATE_LIMIT_STORE } from './rate-limit.interceptor';
import { MemoryRateLimitStore } from './rate-limit.store';

/** The real RunnerAuthGuard (global guard, DB lookup) in front of the real limiter and exception filter. */
@Controller()
class TestController {
  @Post('runner/jobs/claim') @HttpCode(204) @RunnerAuth() claim() { return; }
  @Get('meta') meta() { return { ok: true }; }
}

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('runners are limited per runner, not per address', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const env: Record<string, unknown> = { NODE_ENV: 'test', RATE_LIMIT_RUNNER_PER_MINUTE: 1200, RATE_LIMIT_ANONYMOUS_PER_MINUTE: 5, RATE_LIMIT_AUTH_FAILURES_PER_MINUTE: 3 };
  let base: string;
  let close: () => Promise<void>;
  let orgId: string;
  const tokens = [`rt_${randomUUID()}`, `rt_${randomUUID()}`];

  beforeAll(async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `rl-${s}`, name: s }).returning();
    orgId = org!.id;
    const [rp] = await db.insert(schema.runnerPools).values({ organizationId: orgId, scopeId: orgId, slug: 'p', name: 'p' } as typeof schema.runnerPools.$inferInsert).returning();
    for (const [i, t] of tokens.entries()) await db.insert(schema.runners).values({ poolId: rp!.id, name: `r${i}`, tokenHash: hashToken(t) } as typeof schema.runners.$inferInsert);

    @Module({
      controllers: [TestController],
      providers: [
        { provide: DATABASE, useValue: db },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
        { provide: RATE_LIMIT_STORE, useValue: new MemoryRateLimitStore() },
        { provide: APP_GUARD, useClass: RunnerAuthGuard },
        RateLimitInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: RateLimitInterceptor },
      ],
    })
    class TestModule {}
    const app = await NestFactory.create(TestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DatabaseExceptionFilter(app.get(HttpAdapterHost).httpAdapter, app.get(RateLimitInterceptor)));
    await app.listen(0, '127.0.0.1');
    base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
    close = () => app.close();
  });
  afterAll(async () => {
    await close?.();
    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId)).catch(() => undefined);
    await pool.end();
  });
  const claim = (token: string) => fetch(`${base}/runner/jobs/claim`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'user-agent': 'secops-runner/0.1' } });

  it('two runners on one IP: each its own 1200/min window; anonymous callers on that IP are unaffected', async () => {
    for (let n = 0; n < 20; n++) {
      for (const [i, t] of tokens.entries()) {
        const r = await claim(t);
        expect(r.status).toBe(204);
        expect(r.headers.get('ratelimit-limit')).toBe('1200');
        if (n === 19) expect(r.headers.get('ratelimit-remaining')).toBe(String(1200 - 20)); // per runner, not 40 shared
        void i;
      }
    }
    // 40 runner requests did not touch the address's anonymous window (5/min)
    const anon = await fetch(`${base}/meta`);
    expect(anon.status).toBe(200);
    expect(anon.headers.get('ratelimit-limit')).toBe('5');
    expect(anon.headers.get('ratelimit-remaining')).toBe('4');
  });

  it('a wrong runner token is a 401 counted as an authentication failure of the address', async () => {
    for (let n = 1; n <= 3; n++) expect((await claim(`rt_wrong_${n}`)).status).toBe(401);
    const limited = await claim('rt_wrong_4');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await claim(tokens[0]!)).status).toBe(204); // the real runner keeps working
  });
});
