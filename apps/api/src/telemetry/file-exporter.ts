/**
 * OTEL_TRACES_EXPORTER=file: one JSON line per span appended to OTEL_TRACES_FILE — for test/span-budget.mjs and for
 * looking at a process's spans without a collector. Not for production.
 */
import { appendFileSync } from 'node:fs';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

export class FileSpanExporter implements SpanExporter {
  constructor(private readonly path: string) {}
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      const lines = spans.map((s) => JSON.stringify({
        traceId: s.spanContext().traceId, spanId: s.spanContext().spanId, parentSpanId: s.parentSpanContext?.spanId ?? null, name: s.name,
        service: s.resource.attributes['service.name'], scope: s.instrumentationScope.name, durationMs: s.duration[0] * 1000 + s.duration[1] / 1e6,
        status: s.status.code, attributes: s.attributes, events: s.events.map((e) => e.name),
      }));
      appendFileSync(this.path, lines.join('\n') + '\n');
      resultCallback({ code: 0 });
    } catch (error) {
      resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  shutdown(): Promise<void> { return Promise.resolve(); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
}
