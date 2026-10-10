import { CanActivate, Controller, ExecutionContext, Get, Headers, Injectable, Module, Post, UnauthorizedException, UseGuards, ForbiddenException } from '@nestjs/common';
import { APP_INTERCEPTOR, HttpAdapterHost, NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DatabaseExceptionFilter } from '../database-exception.filter';
import { RateLimitInterceptor, RATE_LIMIT_STORE } from './rate-limit.interceptor';
import { MemoryRateLimitStore } from './rate-limit.store';

/** Stands in for the auth guards: "good" authenticates, anything else is a 401 thrown before the interceptor runs. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const auth = req.headers.authorization ?? '';
    if (auth === 'Bearer good') { req.user = { id: 'u-good' }; return true; }
    if (auth === 'Bearer reader') { req.user = { id: 'u-reader' }; throw new ForbiddenException('not allowed'); }
    throw new UnauthorizedException('Invalid token');
  }
}

@Controller()
class TestController {
  @Get('organizations') @UseGuards(FakeAuthGuard) list() { return []; }
  /** like the registry token endpoint: public, the handler checks basic auth */
  @Get('registry/token') token(@Headers('authorization') a?: string) {
    if (a !== `Basic ${Buffer.from('admin:secret').toString('base64')}`) throw new UnauthorizedException('Invalid credentials');
    return { token: 't' };
  }
  @Post('webhooks/github') hook() { throw new UnauthorizedException('Invalid webhook signature'); }
}

const env: Record<string, unknown> = { NODE_ENV: 'test', RATE_LIMIT_AUTH_FAILURES_PER_MINUTE: 30, RATE_LIMIT_READ_PER_MINUTE: 1000 };
@Module({
  controllers: [TestController],
  providers: [
    { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
    { provide: RATE_LIMIT_STORE, useValue: new MemoryRateLimitStore() },
    RateLimitInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: RateLimitInterceptor },
  ],
})
class TestModule {}

describe('failed authentication is rate limited per client IP', () => {
  let base: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const app = await NestFactory.create(TestModule, { logger: false });
    (app as unknown as { set: (k: string, v: unknown) => void }).set('trust proxy', true);
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new DatabaseExceptionFilter(app.get(HttpAdapterHost).httpAdapter, app.get(RateLimitInterceptor)));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`.replace('[::1]', '127.0.0.1');
    close = () => app.close();
  });
  afterAll(() => close());
  const get = (path: string, auth: string, ip: string) => fetch(`${base}${path}`, { headers: { authorization: auth, 'x-forwarded-for': ip } });

  it('30 bad tokens → 401; the 31st → 429 with Retry-After; a good token from the same IP is unaffected; other IPs too', async () => {
    const ip = '203.0.113.7';
    for (let n = 1; n <= 30; n++) expect((await get('/organizations', `Bearer spt_guess_${n}`, ip)).status).toBe(401);
    const limited = await get('/organizations', 'Bearer spt_guess_31', ip);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await limited.json()) as { message: string }).message).toMatch(/Too many failed authentication attempts from this address: 30 per minute/);
    expect((await get('/organizations', 'Bearer good', ip)).status).toBe(200);
    expect((await get('/organizations', 'Bearer spt_guess_1', '198.51.100.9')).status).toBe(401);
  });

  it('registry token: failed basic auth counts (successful token requests never do); webhook signature failures count too', async () => {
    const ip = '203.0.113.8';
    const bad = (n: number) => `Basic ${Buffer.from(`admin:password${n}`).toString('base64')}`;
    const good = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
    for (let n = 0; n < 50; n++) expect((await get('/registry/token', good, ip)).status).toBe(200); // bursty pulls: not limited
    for (let n = 1; n <= 20; n++) expect((await get('/registry/token', bad(n), ip)).status).toBe(401);
    for (let n = 1; n <= 10; n++) expect((await fetch(`${base}/webhooks/github`, { method: 'POST', headers: { 'x-forwarded-for': ip } })).status).toBe(401);
    expect((await get('/registry/token', bad(99), ip)).status).toBe(429); // 31st failure from this address
    expect((await get('/registry/token', good, ip)).status).toBe(200);
  });

  it('403s count against the caller\'s own bucket, not the address', async () => {
    env.RATE_LIMIT_READ_PER_MINUTE = 1000;
    const ip = '203.0.113.9';
    for (let n = 0; n < 40; n++) expect((await get('/organizations', 'Bearer reader', ip)).status).toBe(403);
    expect((await get('/organizations', 'Bearer spt_bad', ip)).status).toBe(401); // the address has no failures recorded
  });
});
