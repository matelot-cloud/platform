import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { MIN_MS, shouldDrop, TrimmingSpanProcessor } from './trim';

function span(scope: string, name: string, ms: number, attributes: Record<string, unknown> = {}): ReadableSpan {
  return { name, instrumentationScope: { name: scope }, duration: [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)], attributes } as unknown as ReadableSpan;
}
const REDIS = '@opentelemetry/instrumentation-ioredis', PG = '@opentelemetry/instrumentation-pg', HTTP = '@opentelemetry/instrumentation-http';

describe('span trimming', () => {
  it('drops Redis housekeeping whatever its duration, and fast commands; keeps a slow real command', () => {
    expect(shouldDrop(span(REDIS, 'incr', 0.4, { 'db.operation.name': 'incr', 'db.query.text': 'incr rl:read:u1:…' }))).toBe(true);
    expect(shouldDrop(span(REDIS, 'incr', 40, { 'db.operation.name': 'incr', 'db.query.text': 'incr rl:read:u1:…' }))).toBe(true);   // rate limiter, even when slow
    expect(shouldDrop(span(REDIS, 'multi', 0.2, { 'db.operation.name': 'multi' }))).toBe(true);
    expect(shouldDrop(span(REDIS, 'evalsha', 12, { 'db.operation.name': 'evalsha', 'db.query.text': 'evalsha … bull:github-sync:…' }))).toBe(true);
    expect(shouldDrop(span(REDIS, 'get', 0.8, { 'db.operation.name': 'get', 'db.query.text': 'get nonce:abc' }))).toBe(true);     // fast
    expect(shouldDrop(span(REDIS, 'get', MIN_MS + 1, { 'db.operation.name': 'get', 'db.query.text': 'get nonce:abc' }))).toBe(false); // slow: kept
  });

  it('drops pool checkouts always and sub-threshold queries; keeps slow queries', () => {
    expect(shouldDrop(span(PG, 'pg-pool.connect', 30))).toBe(true);
    expect(shouldDrop(span(PG, 'pg.connect', 30))).toBe(true);
    expect(shouldDrop(span(PG, 'pg.query:SELECT platform', 1.2))).toBe(true);
    expect(shouldDrop(span(PG, 'pg.query:SELECT platform', 48))).toBe(false);
  });

  it('never touches http, express, undici or our own spans', () => {
    expect(shouldDrop(span(HTTP, 'POST /api/v1/runner/jobs/:jobId/logs', 0.3))).toBe(false);
    expect(shouldDrop(span('@opentelemetry/instrumentation-undici', 'GET', 0.3))).toBe(false);
    expect(shouldDrop(span('matelot', 'gate evaluate', 0.1))).toBe(false);
    expect(shouldDrop(span('matelot-pipeline', 'job sbom', 0.1))).toBe(false);
  });

  it('the processor forwards what it keeps and counts what it drops', () => {
    const ended: string[] = [];
    const p = new TrimmingSpanProcessor({ onStart: () => undefined, onEnd: (s) => ended.push(s.name), forceFlush: async () => undefined, shutdown: async () => undefined });
    p.onEnd(span(PG, 'pg-pool.connect', 1)); p.onEnd(span(PG, 'pg.query:UPDATE platform', 9)); p.onEnd(span(REDIS, 'pexpire', 0.1, { 'db.operation.name': 'pexpire' })); p.onEnd(span(HTTP, 'POST /x', 2));
    expect(ended).toEqual(['pg.query:UPDATE platform', 'POST /x']);
    expect(p.dropped).toBe(2);
  });
});
