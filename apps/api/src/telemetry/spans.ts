/**
 * Small helpers over @opentelemetry/api — the API package is always loaded (cheap, no SDK); without the tracing
 * preload every call is a no-op on the no-op tracer, so services can trace unconditionally.
 */
import { context, propagation, trace, ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { parseTraceparent, withPinnedIds } from './ids';
import { pipelineTracer } from './tracing';

export const tracer = () => trace.getTracer('matelot');

/** Runs `fn` in a new span; records the error and the status, ends the span. */
export async function inSpan<T>(name: string, fn: (span: Span) => Promise<T>, options: { attributes?: Attributes; kind?: SpanKind; parent?: Context } = {}): Promise<T> {
  const parent = options.parent ?? context.active();
  const span = tracer().startSpan(name, { attributes: options.attributes, kind: options.kind }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span.end();
  }
}

/** The W3C `traceparent` of the active span (undefined without one) — for job data, claim responses. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (carrier.traceparent) return carrier.traceparent;
  const sc = trace.getSpanContext(context.active());   // no propagator registered (tests): build it by hand
  return sc && sc.traceId !== '00000000000000000000000000000000' ? `00-${sc.traceId}-${sc.spanId}-${(sc.traceFlags & 1) ? '01' : '00'}` : undefined;
}

/** A context carrying a remote parent from a `traceparent` string (BullMQ job data, the pipeline row) — built
 *  directly, not through the global propagator, so it works before `provider.register()` and in tests. */
export function contextFromTraceparent(traceparent: string | null | undefined): Context {
  const p = parseTraceparent(traceparent);
  if (!p) return ROOT_CONTEXT;   // no parent: a new trace, never a child of whatever request happens to be active
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: p.traceId, spanId: p.spanId, traceFlags: p.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE, isRemote: true });
}

export interface CompletedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentTraceparent?: string | null;
  startTime: Date;
  endTime: Date;
  attributes?: Attributes;
  events?: { name: string; time: Date; attributes?: Attributes }[];
  error?: string | null;
  kind?: SpanKind;
}

/**
 * Emits a span for something that already happened, with ids fixed in advance (telemetry/ids.ts): the pipeline's
 * root span at its terminal status, a job's span at completion. Nothing is held in memory between the start and
 * the end of the work, so API restarts and several replicas cannot lose or duplicate it.
 */
export function emitCompletedSpan(s: CompletedSpan): void {
  const parent = contextFromTraceparent(s.parentTraceparent);
  const t = pipelineTracer() ?? tracer();   // service "matelot-pipeline" whichever process emits (tracing.ts)
  const span = withPinnedIds(s.traceId, s.spanId, () => t.startSpan(s.name, { startTime: s.startTime, attributes: s.attributes, kind: s.kind ?? SpanKind.INTERNAL }, parent));
  for (const e of s.events ?? []) span.addEvent(e.name, e.attributes, e.time);
  span.setStatus(s.error ? { code: SpanStatusCode.ERROR, message: s.error } : { code: SpanStatusCode.OK });
  span.end(s.endTime);
}
