/**
 * Export failures per signal (kind rc.23: a logs exporter answering 404 was reported as a *tracing* failure, because
 * both read the one diag logger; and the "last error" was the serialized stack). Every exporter the preload starts is
 * wrapped here: a failed export increments that signal's counter and keeps a one-line description —
 *
 *   OTLPExporterError: Not Found (HTTP 404) — POST http://tempo.monitoring:4318/v1/logs
 *
 * which Administration → Observability and `matelot doctor` show. The stack stays where it was: the pod log (the diag
 * logger prints the first occurrence of each failure in full, telemetry/tracing.ts OnceLogger).
 */
export type Signal = 'traces' | 'logs';

export class SignalFailures {
  count = 0;
  last: string | null = null;
  lastAt: Date | null = null;
  record(line: string, now = new Date()): void { this.count++; this.last = line; this.lastAt = now; }
  snapshot(): { count: number; last: string | null; lastAt: string | null } { return { count: this.count, last: this.last, lastAt: this.lastAt?.toISOString() ?? null }; }
}

const g = globalThis as unknown as { __matelotExportFailures?: Record<Signal, SignalFailures> };
/** The process's counters (one per signal; shared by the api's and the pipeline's trace providers). */
export function exportFailures(): Record<Signal, SignalFailures> {
  if (!g.__matelotExportFailures) g.__matelotExportFailures = { traces: new SignalFailures(), logs: new SignalFailures() };
  return g.__matelotExportFailures;
}

/** The OTLP protocol of a signal: the signal-specific variable, else the shared one, else http/protobuf. */
export function otlpProtocol(env: NodeJS.ProcessEnv, signal: Signal): string {
  return (env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase();
}

/** The OTLP endpoint a signal goes to: the signal-specific variable, else the shared one (plus the path the SDK adds for http). */
export function otlpEndpoint(env: NodeJS.ProcessEnv, signal: Signal): string | null {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]?.trim();
  if (specific) return specific;
  const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!shared) return null;
  return otlpProtocol(env, signal) === 'grpc' ? shared : `${shared.replace(/\/+$/, '')}/v1/${signal}`;
}

const GRPC_STATUS: Record<number, string> = { 1: 'CANCELLED', 2: 'UNKNOWN', 4: 'DEADLINE_EXCEEDED', 5: 'NOT_FOUND', 7: 'PERMISSION_DENIED', 8: 'RESOURCE_EXHAUSTED', 12: 'UNIMPLEMENTED', 13: 'INTERNAL', 14: 'UNAVAILABLE', 16: 'UNAUTHENTICATED' };

/** One line for an export error: name, first line of the message, the HTTP (or gRPC) status, where it was sent. */
export function describeExportError(error: unknown, target: { url: string | null; protocol: string }): string {
  const e = (error ?? {}) as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };
  const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
  let message = typeof e.message === 'string' ? e.message : typeof error === 'string' ? error : '';
  if (!message && typeof e.stack === 'string') message = e.stack.replace(/^[^:\n]*:\s*/, '');
  message = (message.split('\n')[0] ?? '').trim().slice(0, 200) || 'export failed';
  const status = typeof e.code === 'number' ? (target.protocol === 'grpc' ? ` (gRPC ${GRPC_STATUS[e.code] ?? e.code})` : e.code >= 100 && e.code < 600 ? ` (HTTP ${e.code})` : '')
    : typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code) && !message.includes(e.code) ? ` (${e.code})` : '';
  const where = target.url ? ` — ${target.protocol === 'grpc' ? 'gRPC' : 'POST'} ${target.url}` : '';
  return `${name}: ${message}${status}${where}`;
}

interface ResultLike { code: number; error?: Error }
interface ExporterLike<T> { export(items: T[], done: (r: ResultLike) => void): void }

/** Wraps an exporter's export(): a non-success result is counted for `signal` with its one-line description. */
export function watchExporter<E extends ExporterLike<T>, T>(exporter: E, signal: Signal, target: { url: string | null; protocol: string }, failures = exportFailures()[signal]): E {
  const original = exporter.export.bind(exporter);
  exporter.export = (items: T[], done: (r: ResultLike) => void) => original(items, (r) => {
    if (r.code !== 0) failures.record(describeExportError(r.error, target));
    done(r);
  });
  return exporter;
}
