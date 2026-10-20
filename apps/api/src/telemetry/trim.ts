/**
 * What never reaches the collector (docs/observability.md, "Span budget"): a security pipeline on kind produced 1 824
 * spans, most of them Redis commands of the rate limiter and BullMQ housekeeping (incr / multi / exec / pexpire,
 * sub-millisecond), pool checkouts and sub-millisecond queries. The rules, applied when a span ENDS (a sampler cannot
 * see the duration):
 *   - ioredis: dropped when it is housekeeping (rate-limiter `rl:` keys, BullMQ `bull:` keys, multi / exec /
 *     pexpire / evalsha) or shorter than MIN_MS — a slow command stays;
 *   - pg: `pg-pool.connect` and `pg.connect` always dropped; `pg.query:*` kept only when ≥ MIN_MS — the slow query is
 *     the one the trace is for;
 *   - everything else (http, express route spans, undici, our own spans) is kept.
 * Dropped spans are leaves, so no child is orphaned. span-budget.mjs counts the result end to end.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export const MIN_MS = 5;
const HOUSEKEEPING_COMMANDS = new Set(['multi', 'exec', 'pexpire', 'expire', 'evalsha', 'eval', 'ttl', 'pttl', 'brpoplpush', 'bzpopmin', 'xadd', 'xtrim', 'zadd', 'zrem', 'lrem', 'hset', 'hmset', 'hincrby', 'rpush', 'lpush', 'client']);
const HOUSEKEEPING_KEYS = /(^|\s)(rl:|bull:|ratelimit:)/;

export function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

/** True when the ended span is noise by the rules above. Pure, for trim.spec.ts. */
export function shouldDrop(span: ReadableSpan): boolean {
  const scope = span.instrumentationScope.name;
  if (scope === '@opentelemetry/instrumentation-ioredis') {
    const statement = String(span.attributes['db.query.text'] ?? span.attributes['db.statement'] ?? '');
    const command = String(span.attributes['db.operation.name'] ?? span.name).toLowerCase();
    if (HOUSEKEEPING_COMMANDS.has(command) || HOUSEKEEPING_KEYS.test(statement)) return true;
    return durationMs(span) < MIN_MS;
  }
  // the runners' claim long-poll: one request every 20 s per runner, with or without a job — never a trace of its own
  // (a successful claim leaves a `claim` span in the pipeline's trace instead; runner.controller.ts)
  if (scope === '@opentelemetry/instrumentation-http' && /\/runner\/jobs\/claim$/.test(String(span.attributes['http.route'] ?? span.attributes['url.path'] ?? span.name))) return true;
  if (scope === '@opentelemetry/instrumentation-pg') {
    if (span.name === 'pg-pool.connect' || span.name === 'pg.connect') return true;
    return durationMs(span) < MIN_MS;
  }
  return false;
}

/** Wraps the real processor: ended spans that `shouldDrop` are not forwarded. */
export class TrimmingSpanProcessor implements SpanProcessor {
  dropped = 0;
  constructor(private readonly inner: SpanProcessor) {}
  onStart(span: Span, parentContext: Context): void { this.inner.onStart(span, parentContext); }
  onEnd(span: ReadableSpan): void {
    if (shouldDrop(span)) { this.dropped++; return; }
    this.inner.onEnd(span);
  }
  forceFlush(): Promise<void> { return this.inner.forceFlush(); }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
}
