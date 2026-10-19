/**
 * Tracing preload: `node -r ./dist/telemetry/tracing.js dist/main.js` (and dist/worker.js). Runs before Nest loads
 * anything, because the instrumentations must patch `http`, `express`, `pg`, `ioredis` and `undici` on first require.
 *
 * Off (the default without an OTLP endpoint, or MATELOT_TRACING_ENABLED=false): returns at once — no OpenTelemetry
 * module is loaded, nothing is patched, startup cost is one env read (tracing.spec.ts asserts require.cache).
 * On: a NodeTracerProvider with a BatchSpanProcessor — export is asynchronous, the queue is bounded (2048 spans,
 * 512 per batch, 5 s export timeout) and an unreachable collector costs dropped spans and ONE warning, never a
 * blocked request or a failed /health/live. SIGTERM / SIGINT flush what is queued with a 5 s cap (TelemetryModule
 * does the same inside Nest's shutdown, so the last spans of a pipeline job survive a pod rollout).
 *
 * Configuration: the standard OTEL_* variables (docs/observability.md) — OTEL_EXPORTER_OTLP_ENDPOINT / _HEADERS /
 * _PROTOCOL (grpc | http/protobuf | http/json), OTEL_TRACES_SAMPLER (+_ARG), OTEL_TRACES_EXPORTER (otlp | console |
 * none), OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES; ours: MATELOT_TRACING_ENABLED, MATELOT_COMPONENT (api | worker),
 * APP_VERSION / APP_COMMIT, DEPLOYMENT_ENVIRONMENT, BOOTSTRAP_ORG_SLUG (= matelot.cell).
 */
import type { Attributes } from '@opentelemetry/api';

export interface TracingHandle {
  /** Flush queued spans and stop exporting; resolves within `capMs` whatever the collector does. */
  shutdown(capMs?: number): Promise<void>;
  readonly exporter: string;
  /** spans the trimming rules kept out (telemetry/trim.ts) */
  readonly dropped: () => number;
}

const g = globalThis as unknown as { __matelotTracing?: TracingHandle | null; __matelotPipelineTracer?: import('@opentelemetry/api').Tracer };

/** service.name of the pipeline-level spans, whichever process emits them (docs: search this service in Jaeger / Tempo). */
export const PIPELINE_SERVICE = 'matelot-pipeline';

/** Whether the preload should start tracing: MATELOT_TRACING_ENABLED wins; else an OTLP endpoint (or a non-OTLP exporter) turns it on. */
export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.MATELOT_TRACING_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  const exporter = (env.OTEL_TRACES_EXPORTER ?? 'otlp').trim().toLowerCase();
  if (exporter === 'none') return false;
  if (exporter !== 'otlp') return true;
  return Boolean((env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim());
}

/** The resource every signal of this process carries (shared with the meter). */
export function resourceAttributes(env: NodeJS.ProcessEnv = process.env): Attributes {
  const component = env.MATELOT_COMPONENT ?? (process.argv[1]?.includes('worker') ? 'worker' : 'api');
  const attrs: Attributes = {
    'service.name': env.OTEL_SERVICE_NAME ?? `matelot-${component}`,
    'service.version': env.APP_VERSION ?? '0.0.0',
    'deployment.environment': env.DEPLOYMENT_ENVIRONMENT ?? 'production',
    'matelot.component': component,
  };
  if (env.APP_COMMIT) attrs['matelot.commit'] = env.APP_COMMIT;
  if (env.BOOTSTRAP_ORG_SLUG) attrs['matelot.cell'] = env.BOOTSTRAP_ORG_SLUG;
  for (const pair of (env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) attrs[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return attrs;
}

/** Paths that never become server spans: probes, scrapes, the runners' heartbeats (one per runner every few seconds). */
export function ignoredIncomingPath(path: string): boolean {
  return path.includes('/health/') || path === '/metrics' || path.endsWith('/runner/heartbeat') || path.endsWith('/jobs/heartbeat') || /\/runner\/jobs\/[^/]+\/heartbeat$/.test(path);
}

/** One warning per distinct exporter failure message; the rest is counted and reported on shutdown. */
export class OnceLogger {
  private readonly seen = new Set<string>();
  dropped = 0;
  constructor(private readonly out: (msg: string) => void = (m) => process.stderr.write(`${m}\n`)) {}
  warn(message: string): void {
    const key = message.replace(/\d+/g, 'N');
    if (this.seen.has(key)) { this.dropped++; return; }
    this.seen.add(key);
    this.out(`{"level":"warn","component":"telemetry","msg":${JSON.stringify(`trace export: ${message} (further occurrences are not logged)`)}}`);
  }
}

function sampler(env: NodeJS.ProcessEnv, api: typeof import('@opentelemetry/sdk-trace-base')) {
  const name = (env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? '1');
  const arg = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1;
  const { AlwaysOnSampler, AlwaysOffSampler, TraceIdRatioBasedSampler, ParentBasedSampler } = api;
  switch (name) {
    case 'always_on': return new AlwaysOnSampler();
    case 'always_off': return new AlwaysOffSampler();
    case 'traceidratio': return new TraceIdRatioBasedSampler(arg);
    case 'parentbased_always_off': return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio': return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(arg) });
    default: return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

function otlpExporter(env: NodeJS.ProcessEnv) {
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase();
  // the exporters read OTEL_EXPORTER_OTLP_* themselves (endpoint, headers, timeout); only the protocol picks the module
  if (protocol === 'grpc') return new (require('@opentelemetry/exporter-trace-otlp-grpc').OTLPTraceExporter)();
  if (protocol === 'http/json') return new (require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter)();
  return new (require('@opentelemetry/exporter-trace-otlp-proto').OTLPTraceExporter)();
}

/** Starts tracing (idempotent). Returns null when tracing is off. */
export function startTracing(env: NodeJS.ProcessEnv = process.env): TracingHandle | null {
  if (g.__matelotTracing !== undefined) return g.__matelotTracing;
  if (!tracingEnabled(env)) { g.__matelotTracing = null; return null; }

  const { diag, DiagLogLevel } = require('@opentelemetry/api') as typeof import('@opentelemetry/api');
  const once = new OnceLogger();
  diag.setLogger({ error: (m: string, ...rest: unknown[]) => once.warn([m, ...rest.map(String)].join(' ')), warn: (m: string, ...rest: unknown[]) => once.warn([m, ...rest.map(String)].join(' ')), info: () => undefined, debug: () => undefined, verbose: () => undefined }, DiagLogLevel.WARN);

  const traceBase = require('@opentelemetry/sdk-trace-base') as typeof import('@opentelemetry/sdk-trace-base');
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node') as typeof import('@opentelemetry/sdk-trace-node');
  const { resourceFromAttributes } = require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation') as typeof import('@opentelemetry/instrumentation');
  const { PinnedIdGenerator } = require('./ids') as typeof import('./ids');

  const { TrimmingSpanProcessor } = require('./trim') as typeof import('./trim');
  const exporterName = (env.OTEL_TRACES_EXPORTER ?? 'otlp').trim().toLowerCase();
  const makeExporter = () => exporterName === 'console' ? new traceBase.ConsoleSpanExporter() : exporterName === 'file' ? new (require('./file-exporter').FileSpanExporter)(env.OTEL_TRACES_FILE ?? 'traces.jsonl') : exporterName === 'none' ? null : otlpExporter(env);
  const batch = (exporter: import('@opentelemetry/sdk-trace-base').SpanExporter) => new traceBase.BatchSpanProcessor(exporter, { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 2000, exportTimeoutMillis: 5000 });
  const exporter = makeExporter();
  // the process's own provider: its spans are trimmed (telemetry/trim.ts) before they are queued
  const trimmed = exporter ? new TrimmingSpanProcessor(batch(exporter)) : null;
  const provider = new NodeTracerProvider({ resource: resourceFromAttributes(resourceAttributes(env)), sampler: sampler(env, traceBase), spanProcessors: trimmed ? [trimmed] : [], idGenerator: new PinnedIdGenerator() });
  provider.register();
  // the pipeline-level spans (pipeline root, job spans) are emitted by whichever process finishes the work — the api
  // on a runner's /complete, the worker after a gate — so they carry a resource of their own, service.name
  // "matelot-pipeline", and a search for "pipeline <name>" always finds them under that one service
  const pipelineExporter = makeExporter();
  const pipelineProvider = new NodeTracerProvider({ resource: resourceFromAttributes({ ...resourceAttributes(env), 'service.name': PIPELINE_SERVICE, 'matelot.emitted_by': String(resourceAttributes(env)['matelot.component']) }), sampler: sampler(env, traceBase), spanProcessors: pipelineExporter ? [batch(pipelineExporter)] : [], idGenerator: new PinnedIdGenerator() });
  g.__matelotPipelineTracer = pipelineProvider.getTracer('matelot-pipeline');

  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation, ExpressLayerType } = require('@opentelemetry/instrumentation-express');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
  const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici');
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: { url?: string }) => ignoredIncomingPath((req.url ?? '').split('?')[0]),
        // no query strings in span attributes: tokens travel in them (registry token, OAuth); the redaction rule applies to spans too
        startIncomingSpanHook: (req: { url?: string }) => ({ 'url.path': (req.url ?? '').split('?')[0] }),
      }),
      // express: only the route template on the http span (one span per request, not one per middleware layer)
      new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.REQUEST_HANDLER, ExpressLayerType.ROUTER] }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
      new UndiciInstrumentation(),
    ],
  });

  let done: Promise<void> | null = null;
  const handle: TracingHandle = {
    exporter: exporterName,
    dropped: () => trimmed?.dropped ?? 0,
    shutdown(capMs = 5000) {
      if (done) return done;
      done = Promise.race([Promise.all([provider.shutdown(), pipelineProvider.shutdown()]), new Promise<void>((r) => setTimeout(r, capMs).unref())]).catch(() => undefined).then(() => {
        if (once.dropped) process.stderr.write(`{"level":"warn","component":"telemetry","msg":"trace export: ${once.dropped} further export failure(s) during this process"}\n`);
      });
      return done;
    },
  };
  // backstop outside Nest (TelemetryModule flushes inside Nest's shutdown too); never exits the process itself
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void handle.shutdown());
  g.__matelotTracing = handle;
  return handle;
}

/** The handle the preload created, for TelemetryModule's shutdown flush. */
export function tracingHandle(): TracingHandle | null {
  return g.__matelotTracing ?? null;
}

/** The tracer for pipeline-level spans (service "matelot-pipeline"); the process tracer when the preload is off. */
export function pipelineTracer(): import('@opentelemetry/api').Tracer | null {
  return g.__matelotPipelineTracer ?? null;
}

// preloaded with `node -r`: start now. Imported later (TelemetryModule, tests): idempotent, and a no-op without an endpoint.
if (!process.env.MATELOT_TRACING_NO_AUTOSTART) startTracing();
