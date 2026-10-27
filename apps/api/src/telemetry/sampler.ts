/**
 * The cell's sampler, around the configured one (OTEL_TRACES_SAMPLER, default parentbased_always_on). It decides
 * only for a request that would START a trace (a SERVER span with no parent); everything with a parent follows the
 * parent through the base sampler (a sampled parent → recorded, an unsampled one → dropped: the CLI sends its polls
 * with the sampled flag off). For the roots:
 *
 *   GET with `x-matelot-poll: 1`, or of a route a client polls (POLLED_ROUTES)   → never recorded. The web app marks
 *       every background refetch (refresh interval, focus), the CLI its `--wait` loops; one open tab was ~150 root
 *       traces in 10 minutes (jobs/active, audit-events, /me, …) before this.
 *   any other GET                                                                  → recorded for a ratio of the trace
 *       ids: MATELOT_TRACES_GET_RATIO (default 0.1). Reads are many and alike; one in ten shows the latency profile.
 *   mutations (POST, PUT, PATCH, DELETE), and anything else                        → the base sampler (always on).
 *
 * A pipeline's spans are not affected: they carry their own ids and parents (pipeline-telemetry.ts).
 */
import { SpanKind, type Attributes, type Context, type Link, trace } from '@opentelemetry/api';
import type { Sampler, SamplingResult } from '@opentelemetry/sdk-trace-base';
import { SamplingDecision, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

const UUID = '[0-9a-f-]{36}';
/** Paths a client polls: never a root trace of their own, header or not (older CLIs, curl loops). */
export const POLLED_ROUTES = [new RegExp(`^/api/v1/pipelines/${UUID}$`), new RegExp(`^/api/v1/pipelines/${UUID}/jobs$`), new RegExp(`^/api/v1/jobs/${UUID}$`), new RegExp(`^/api/v1/jobs/${UUID}/logs$`), new RegExp(`^/api/v1/[a-z]+/${UUID}/correlation/jobs/${UUID}$`)];
/** The attribute the HTTP instrumentation's start hook sets from the `x-matelot-poll` header (tracing.ts). */
export const POLL_ATTRIBUTE = 'matelot.poll';
export const POLL_HEADER = 'x-matelot-poll';
export const DEFAULT_GET_RATIO = 0.1;

export function isPolledPath(path: string | undefined): boolean {
  return !!path && POLLED_ROUTES.some((r) => r.test(path));
}

/** MATELOT_TRACES_GET_RATIO: 0 … 1, default 0.1 (anything unparseable → the default). */
export function getRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MATELOT_TRACES_GET_RATIO;
  if (raw === undefined || raw.trim() === '') return DEFAULT_GET_RATIO;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_GET_RATIO;
}

export class MatelotSampler implements Sampler {
  private readonly gets: Sampler;
  constructor(private readonly base: Sampler, getRatioValue = getRatio()) {
    this.gets = new TraceIdRatioBasedSampler(getRatioValue);
  }
  shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    if (spanKind === SpanKind.SERVER && !trace.getSpanContext(context)) {
      const method = String(attributes['http.request.method'] ?? attributes['http.method'] ?? '').toUpperCase();
      if (method === 'GET') {
        const poll = attributes[POLL_ATTRIBUTE] === true || attributes[POLL_ATTRIBUTE] === 'true' || attributes[POLL_ATTRIBUTE] === '1';
        if (poll || isPolledPath(String(attributes['url.path'] ?? attributes['http.target'] ?? '').split('?')[0])) return { decision: SamplingDecision.NOT_RECORD };
        // the base sampler still has the last word when it is stricter (always_off, a lower ratio)
        const ratio = this.gets.shouldSample(context, traceId, spanName, spanKind, attributes, links);
        if (ratio.decision === SamplingDecision.NOT_RECORD) return ratio;
      }
    }
    return this.base.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }
  toString(): string { return `MatelotSampler{gets=${this.gets.toString()}, ${this.base.toString()}}`; }
}
