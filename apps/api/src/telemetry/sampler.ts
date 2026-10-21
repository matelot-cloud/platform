/**
 * The cell's sampler: the configured one (OTEL_TRACES_SAMPLER, default parentbased_always_on) plus the routes that
 * are polled — a `matelot pipeline --wait` asks GET /pipelines/:id every 5 s, the web app's activity indicator asks
 * the pipeline's jobs — which are not recorded when the request starts a trace of its own. A poll inside a traced
 * request (a sampled parent) is still recorded. The CLI also sends its polls with the sampled flag off, so an older
 * cell drops them as well; this rule covers clients that send nothing.
 */
import { SpanKind, type Attributes, type Context, type Link, trace } from '@opentelemetry/api';
import type { Sampler, SamplingResult } from '@opentelemetry/sdk-trace-base';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';

const UUID = '[0-9a-f-]{36}';
/** Paths a client polls: never a root trace of their own. */
export const POLLED_ROUTES = [new RegExp(`^/api/v1/pipelines/${UUID}$`), new RegExp(`^/api/v1/pipelines/${UUID}/jobs$`), new RegExp(`^/api/v1/jobs/${UUID}$`), new RegExp(`^/api/v1/jobs/${UUID}/logs$`), new RegExp(`^/api/v1/[a-z]+/${UUID}/correlation/jobs/${UUID}$`)];

export function isPolledPath(path: string | undefined): boolean {
  return !!path && POLLED_ROUTES.some((r) => r.test(path));
}

export class MatelotSampler implements Sampler {
  constructor(private readonly base: Sampler) {}
  shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    if (spanKind === SpanKind.SERVER && !trace.getSpanContext(context)) {
      const method = String(attributes['http.request.method'] ?? attributes['http.method'] ?? '').toUpperCase();
      if (method === 'GET' && isPolledPath(String(attributes['url.path'] ?? attributes['http.target'] ?? '').split('?')[0])) return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.base.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }
  toString(): string { return `MatelotSampler{${this.base.toString()}}`; }
}
