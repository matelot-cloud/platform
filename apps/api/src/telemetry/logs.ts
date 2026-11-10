/**
 * OTel logs export for the audit / security events (telemetry/events.ts). Started by the tracing preload, independently
 * of tracing: OTEL_LOGS_EXPORTER = `otlp` (to OTEL_EXPORTER_OTLP_LOGS_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT, same
 * headers and protocol as the traces), `console`, `file` (JSON lines to OTEL_LOGS_FILE; tests) or `none` — the default:
 * without an exporter no SDK module is loaded and `logs.getLogger()` stays the API's no-op, so the events cost one
 * stdout line each and nothing else. Only the events scope goes this way — pino's lines are never duplicated here.
 *
 * Helm: `observability.otlp.logs: true` sets OTEL_LOGS_EXPORTER=otlp; Compose: MATELOT_OTLP_LOGS=1 (compose-init
 * writes it; the collector's logs pipeline forwards to Loki).
 */
import { appendFileSync } from 'node:fs';

export interface LogsHandle {
  shutdown(capMs?: number): Promise<void>;
  readonly exporter: string;
  /** records handed to the processor since start (what Settings → Observability shows) */
  readonly emitted: () => number;
  /** export failures (the diag logger's, shared with tracing) and the last message */
  readonly failures: () => { count: number; last: string | null };
  flush(capMs?: number): Promise<void>;
}

const g = globalThis as unknown as { __matelotLogs?: LogsHandle | null };

export function logsExporterName(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OTEL_LOGS_EXPORTER ?? 'none').trim().toLowerCase();
}

function otlpLogExporter(env: NodeJS.ProcessEnv) {
  const protocol = (env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase();
  if (protocol === 'grpc') return new (require('@opentelemetry/exporter-logs-otlp-grpc').OTLPLogExporter)();
  if (protocol === 'http/json') return new (require('@opentelemetry/exporter-logs-otlp-http').OTLPLogExporter)();
  return new (require('@opentelemetry/exporter-logs-otlp-proto').OTLPLogExporter)();
}

/** Starts the logs exporter (idempotent). Returns null when OTEL_LOGS_EXPORTER is none / unset. */
export function startLogs(env: NodeJS.ProcessEnv = process.env): LogsHandle | null {
  if (g.__matelotLogs !== undefined) return g.__matelotLogs;
  const name = logsExporterName(env);
  if (name === 'none' || name === '') { g.__matelotLogs = null; return null; }

  const sdk = require('@opentelemetry/sdk-logs') as typeof import('@opentelemetry/sdk-logs');
  const { logs } = require('@opentelemetry/api-logs') as typeof import('@opentelemetry/api-logs');
  const { resourceFromAttributes } = require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { resourceAttributes, diagOnce } = require('./tracing') as typeof import('./tracing');
  const once = diagOnce();

  let count = 0;
  const exporter: import('@opentelemetry/sdk-logs').LogRecordExporter = name === 'console' ? new sdk.ConsoleLogRecordExporter()
    : name === 'file' ? fileLogExporter(env.OTEL_LOGS_FILE ?? 'logs.jsonl')
    : otlpLogExporter(env);
  const counting: import('@opentelemetry/sdk-logs').LogRecordProcessor = { onEmit: () => { count++; }, forceFlush: async () => undefined, shutdown: async () => undefined };
  const provider = new sdk.LoggerProvider({
    resource: resourceFromAttributes(resourceAttributes(env)),
    processors: [counting, new sdk.BatchLogRecordProcessor({ exporter, maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 2000, exportTimeoutMillis: 5000 })],
  });
  logs.setGlobalLoggerProvider(provider);

  let done: Promise<void> | null = null;
  const handle: LogsHandle = {
    exporter: name,
    emitted: () => count,
    failures: () => ({ count: once.total, last: once.last }),
    flush(capMs = 5000) {
      return Promise.race([provider.forceFlush(), new Promise<void>((r) => setTimeout(r, capMs).unref())]).catch(() => undefined);
    },
    shutdown(capMs = 5000) {
      if (done) return done;
      done = Promise.race([provider.shutdown(), new Promise<void>((r) => setTimeout(r, capMs).unref())]).catch(() => undefined);
      return done;
    },
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void handle.shutdown());
  g.__matelotLogs = handle;
  return handle;
}

/** OTEL_LOGS_EXPORTER=file: one JSON line per record (resource + attributes + body), for tests. */
function fileLogExporter(path: string): import('@opentelemetry/sdk-logs').LogRecordExporter {
  return {
    export(records, done) {
      try {
        appendFileSync(path, records.map((r) => JSON.stringify({ time: r.hrTime, severity: r.severityText, body: r.body, attributes: r.attributes, resource: r.resource.attributes, scope: r.instrumentationScope.name, traceId: r.spanContext?.traceId, spanId: r.spanContext?.spanId })).join('\n') + '\n');
        done({ code: 0 });
      } catch (e) { done({ code: 1, error: e as Error }); }
    },
    forceFlush: async () => undefined,
    shutdown: async () => undefined,
  };
}

export function logsHandle(): LogsHandle | null {
  return g.__matelotLogs ?? null;
}
