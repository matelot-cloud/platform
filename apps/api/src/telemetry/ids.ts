/**
 * Span ids chosen by the caller. A pipeline's spans are emitted when things END (the pipeline's root span at its
 * terminal status, a job's span at completion) with ids fixed when they STARTED, so every process that touches the
 * pipeline — API, worker, the runner — agrees on the trace and on the parent ids without holding span objects in
 * memory across requests or replicas. The SDK generates ids through its IdGenerator; this one hands out the pinned
 * pair for the next span started inside `withPinnedIds` and random ids otherwise.
 */
import { RandomIdGenerator } from '@opentelemetry/sdk-trace-base';
import { randomBytes } from 'node:crypto';

let pinned: { traceId: string; spanId: string } | null = null;

export class PinnedIdGenerator extends RandomIdGenerator {
  // the SDK asks for the span id BEFORE the trace id: both read the pinned pair, `withPinnedIds` clears it afterwards
  override generateTraceId = (): string => pinned?.traceId ?? randomBytes(16).toString('hex');
  override generateSpanId = (): string => pinned?.spanId ?? randomBytes(8).toString('hex');
}

/** Runs `fn` with the next started span taking these ids (synchronous: the span must be started inside `fn`). */
export function withPinnedIds<T>(traceId: string, spanId: string, fn: () => T): T {
  pinned = { traceId, spanId };
  try { return fn(); } finally { pinned = null; }
}

/** `00-<trace>-<span>-01`: a sampled W3C traceparent for ids we chose. */
export function traceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

export function parseTraceparent(value: string | null | undefined): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec((value ?? '').trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase(), sampled: (parseInt(m[3], 16) & 1) === 1 };
}

export function newTraceId(): string { return randomBytes(16).toString('hex'); }
export function newSpanId(): string { return randomBytes(8).toString('hex'); }
