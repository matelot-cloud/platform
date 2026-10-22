/**
 * The cell's metrics (docs/observability.md, "Metrics"): one OpenTelemetry meter, explicit histogram buckets through
 * Views, a Prometheus / OpenMetrics page on its own port (MATELOT_METRICS_PORT, 9464) with trace exemplars, and an
 * optional OTLP push (OTEL_METRICS_EXPORTER includes `otlp`).
 *
 * Rules the instruments below follow, checked by exposition.spec.ts: labels are bounded enumerations (kinds,
 * statuses, pools, severities, HTTP route templates) and never ids, names, paths or user input; gauges that need a
 * query are refreshed by the worker on a timer (GaugeSet.replace), never computed on scrape; `matelot_build_info` is
 * 1 with the version labels.
 */
import { metrics as otelMetrics, trace, type Attributes, type Histogram, type Counter, type Meter, type ObservableGauge } from '@opentelemetry/api';
import { AggregationType, MeterProvider, MetricReader, createAllowListAttributesProcessor, type IMetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { createServer, type Server } from 'node:http';
import { serialize, wantsOpenMetrics, OPENMETRICS_CONTENT_TYPE, TEXT_CONTENT_TYPE, type Exemplar, type GaugeFamily } from './exposition';
import { resourceAttributes } from './tracing';

/** Histogram boundaries, in seconds — the three shapes of latency a cell has. */
export const BUCKETS = {
  http: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  pipelineJob: [1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1200, 1800],
  correlation: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
} as const;

/** OTel instrument name → bucket set (the View and the exemplar store agree through this table). */
export const HISTOGRAMS: Record<string, readonly number[]> = {
  'http.server.request.duration': BUCKETS.http,
  'matelot.pipeline.job.duration': BUCKETS.pipelineJob,
  'matelot.pipeline.job.queue_wait': BUCKETS.pipelineJob,
  'matelot.pipeline.duration': BUCKETS.pipelineJob,
  'matelot.sbom.correlation.duration': BUCKETS.correlation,
  'matelot.sbom.ingest.duration': BUCKETS.correlation,
  'matelot.webhook.lag': BUCKETS.correlation,
};

/** Label keys every instrument may use — the cardinality rule, enforced by the spec and by `check()` below. */
export const ALLOWED_LABELS = new Set(['db_namespace', 'error_type', 'http_request_method', 'http_route', 'http_response_status_code', 'state', 'kind', 'status', 'pool', 'managed', 'queue', 'result', 'severity', 'source', 'trigger', 'provider', 'phase', 'version', 'commit', 'node_version', 'component']);

/** The instrumentations' own metrics are dropped (ours carry the route template / pool labels and the buckets) — except
 *  pg's query-duration histogram, kept with our buckets and only its bounded attributes; it exists while tracing is on
 *  (the instrumentations load with the tracing preload). */
const DROPPED_METERS = ['@opentelemetry/instrumentation-http', '@opentelemetry/instrumentation-ioredis', '@opentelemetry/instrumentation-undici', '@opentelemetry/instrumentation-express'];

/** A gauge whose series are replaced wholesale by whoever computes them (the worker's timers): absent series vanish. */
export class GaugeSet {
  private series = new Map<string, { attributes: Attributes; value: number }>();
  constructor(readonly name: string, meter: Meter, readonly options: { description: string; unit?: string }) {
    const gauge: ObservableGauge = meter.createObservableGauge(name, options);
    gauge.addCallback((observer) => { for (const s of this.series.values()) observer.observe(s.value, s.attributes); });
  }
  set(value: number, attributes: Attributes = {}): void {
    check(attributes);
    this.series.set(JSON.stringify(Object.entries(attributes).sort()), { attributes, value });
  }
  /** The complete new set of series (an empty list clears the gauge). */
  replace(entries: { value: number; attributes?: Attributes }[]): void {
    this.series = new Map();
    for (const e of entries) this.set(e.value, e.attributes);
  }
  get(attributes: Attributes = {}): number | undefined {
    return this.series.get(JSON.stringify(Object.entries(attributes).sort()))?.value;
  }
  family(): GaugeFamily { return { name: this.name, unit: this.options.unit, description: this.options.description, series: [...this.series.values()] }; }
}

function check(attributes: Attributes): void {
  for (const key of Object.keys(attributes)) if (!ALLOWED_LABELS.has(key)) throw new Error(`metric label "${key}" is not in the allowed set (telemetry/metrics.ts ALLOWED_LABELS): labels are bounded enumerations, never ids or names`);
}

/** One exemplar per (metric, series, bucket): the last sampled measurement that fell into the bucket. */
export class ExemplarStore {
  private readonly store = new Map<string, Map<number, Exemplar>>();
  record(metric: string, attributes: Attributes, value: number, traceId: string, spanId: string): void {
    const bounds = HISTOGRAMS[metric];
    if (!bounds) return;
    let bucket = bounds.findIndex((b) => value <= b);
    if (bucket < 0) bucket = bounds.length;
    const key = `${metric}|${JSON.stringify(Object.entries(attributes).sort())}`;
    let per = this.store.get(key);
    if (!per) { per = new Map(); this.store.set(key, per); }
    per.set(bucket, { traceId, spanId, value, timestampMs: Date.now() });
  }
  lookup = (metric: string, attributes: Attributes): ReadonlyMap<number, Exemplar> | undefined => this.store.get(`${metric}|${JSON.stringify(Object.entries(attributes).sort())}`);
}

/** A histogram that also records an exemplar when a sampled span is active. */
export class TracedHistogram {
  constructor(readonly name: string, private readonly histogram: Histogram, private readonly exemplars: ExemplarStore) {}
  /** `exemplar` names the trace the sample belongs to when it is not the active span's (a pipeline job finished by
   *  an HTTP call from the runner belongs to the pipeline's trace, not to that request's). */
  record(valueSeconds: number, attributes: Attributes = {}, exemplar?: { traceId: string; spanId: string } | null): void {
    check(attributes);
    this.histogram.record(valueSeconds, attributes);
    if (exemplar === null) return;
    if (exemplar) { this.exemplars.record(this.name, attributes, valueSeconds, exemplar.traceId, exemplar.spanId); return; }
    const ctx = trace.getActiveSpan()?.spanContext();
    if (ctx && (ctx.traceFlags & 1) === 1) this.exemplars.record(this.name, attributes, valueSeconds, ctx.traceId, ctx.spanId);
  }
}

class ScrapeReader extends MetricReader {
  protected async onForceFlush(): Promise<void> { /* pull-based: nothing queued */ }
  protected async onShutdown(): Promise<void> { /* nothing to close */ }
}

export interface MetricsOptions {
  env?: NodeJS.ProcessEnv;
  /** extra readers (tests pass an in-memory one); the OTLP push reader is added from the env */
  readers?: IMetricReader[];
}

/** The cell's instruments. One per process (`getMetrics()`); tests build their own with `new Metrics({ env })`. */
export class Metrics {
  readonly provider: MeterProvider;
  readonly meter: Meter;
  readonly exemplars = new ExemplarStore();
  readonly scrape = new ScrapeReader();
  readonly env: NodeJS.ProcessEnv;
  /** when the page was last served (Settings → Observability shows it) */
  lastScrapeAt: Date | null = null;
  private server: Server | null = null;

  // --- instruments (names are the OTel ones; exposition.ts renders the Prometheus names) ---
  readonly httpRequestDuration: TracedHistogram;
  readonly dbConnections: GaugeSet;
  readonly queueJobs: GaugeSet;
  readonly queueOldestJobAge: GaugeSet;
  readonly queueJobsProcessed: Counter;
  readonly pipelineJobs: Counter;
  readonly pipelineJobDuration: TracedHistogram;
  readonly pipelineJobQueueWait: TracedHistogram;
  readonly pipelineJobsQueued: GaugeSet;
  readonly pipelineOldestQueuedJobAge: GaugeSet;
  readonly pipelines: Counter;
  readonly pipelineDuration: TracedHistogram;
  readonly runnersOnline: GaugeSet;
  readonly runnersBusy: GaugeSet;
  readonly runnerLastSeen: GaugeSet;
  readonly runnerClaims: Counter;
  readonly sbomCorrelationDuration: TracedHistogram;
  readonly sbomIngestDuration: TracedHistogram;
  readonly findingsOpen: GaugeSet;
  readonly gateEvaluations: Counter;
  readonly slaBreaches: GaugeSet;
  readonly integrationSyncFailures: Counter;
  readonly webhookLag: TracedHistogram;
  readonly backupLastSuccess: GaugeSet;
  readonly backupLastDuration: GaugeSet;
  readonly backupLastFailure: GaugeSet;
  readonly buildInfo: GaugeSet;
  private readonly gaugeSets: GaugeSet[] = [];

  constructor(options: MetricsOptions = {}) {
    this.env = options.env ?? process.env;
    const views = [
      ...Object.entries(HISTOGRAMS).map(([instrumentName, boundaries]) => ({ instrumentName, aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const, options: { boundaries: [...boundaries] } } })),
      ...DROPPED_METERS.map((meterName) => ({ meterName, instrumentName: '*', aggregation: { type: AggregationType.DROP as const } })),
      { meterName: '@opentelemetry/instrumentation-pg', instrumentName: 'db.client.connection.*', aggregation: { type: AggregationType.DROP as const } },
      { meterName: '@opentelemetry/instrumentation-pg', instrumentName: 'db.client.operation.duration', aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM as const, options: { boundaries: [...BUCKETS.http] } }, attributesProcessors: [createAllowListAttributesProcessor(['db.namespace', 'error.type'])] },
    ];
    const readers: IMetricReader[] = [this.scrape, ...(options.readers ?? []), ...otlpReaders(this.env)];
    this.provider = new MeterProvider({ resource: resourceFromAttributes(resourceAttributes(this.env)), views, readers });
    this.meter = this.provider.getMeter('matelot');
    const m = this.meter;
    const hist = (name: string, description: string) => new TracedHistogram(name, m.createHistogram(name, { description, unit: 's' }), this.exemplars);
    const gauge = (name: string, description: string, unit?: string) => { const g = new GaugeSet(name, m, { description, unit }); this.gaugeSets.push(g); return g; };

    this.httpRequestDuration = hist('http.server.request.duration', 'API request duration by method, route template and status');
    this.dbConnections = gauge('db.client.connection.count', 'Postgres pool connections by state (used, idle, pending)');
    this.queueJobs = gauge('matelot.queue.jobs', 'BullMQ jobs by queue and state');
    this.queueOldestJobAge = gauge('matelot.queue.oldest_job.age', 'Age of the oldest waiting BullMQ job', 's');
    this.queueJobsProcessed = m.createCounter('matelot.queue.jobs.processed', { description: 'BullMQ jobs processed by queue and result' });
    this.pipelineJobs = m.createCounter('matelot.pipeline.jobs', { description: 'Pipeline jobs finished by kind and status' });
    this.pipelineJobDuration = hist('matelot.pipeline.job.duration', 'Pipeline job run time (started → finished) by kind');
    this.pipelineJobQueueWait = hist('matelot.pipeline.job.queue_wait', 'Pipeline job queue wait (queued → started) by kind');
    this.pipelineJobsQueued = gauge('matelot.pipeline.jobs.queued', 'Pipeline jobs waiting for a runner by kind and pool');
    this.pipelineOldestQueuedJobAge = gauge('matelot.pipeline.oldest_queued_job.age', 'Age of the oldest queued pipeline job by pool', 's');
    this.pipelines = m.createCounter('matelot.pipelines', { description: 'Pipelines finished by status and trigger' });
    this.pipelineDuration = hist('matelot.pipeline.duration', 'Pipeline duration (created → finished) by status');
    this.runnersOnline = gauge('matelot.runners.online', 'Runners with a live heartbeat by pool');
    this.runnersBusy = gauge('matelot.runners.busy', 'Runners running a job by pool');
    this.runnerLastSeen = gauge('matelot.runner.last_seen.timestamp', 'Unix time of the newest runner heartbeat by pool (NoRunnerOnline: time() - this)', 's');
    this.runnerClaims = m.createCounter('matelot.runner.claims', { description: 'Runner claim requests by result (job, empty, disconnected)' });
    this.sbomCorrelationDuration = hist('matelot.sbom.correlation.duration', 'SBOM ↔ advisory correlation run time');
    this.sbomIngestDuration = hist('matelot.sbom.ingest.duration', 'SBOM ingestion time by source');
    this.findingsOpen = gauge('matelot.findings.open', 'Open findings in the cell by severity and kind');
    this.gateEvaluations = m.createCounter('matelot.gate.evaluations', { description: 'Gate evaluations by result' });
    this.slaBreaches = gauge('matelot.sla.breaches', 'Findings past their SLA by severity');
    this.integrationSyncFailures = m.createCounter('matelot.integration.sync.failures', { description: 'Integration sync failures by kind' });
    this.webhookLag = hist('matelot.webhook.lag', 'Delivery → processed lag of inbound webhooks by provider');
    this.backupLastSuccess = gauge('matelot.backup.last_success.timestamp', 'Unix time of the last successful backup', 's');
    this.backupLastDuration = gauge('matelot.backup.last.duration', 'Duration of the last successful backup', 's');
    this.backupLastFailure = gauge('matelot.backup.last_failure.timestamp', 'Unix time of the last failed backup', 's');
    this.buildInfo = gauge('matelot.build.info', 'Always 1; the version labels identify the build');
    this.buildInfo.set(1, { version: this.env.APP_VERSION ?? '0.0.0', commit: this.env.APP_COMMIT ?? 'unknown', node_version: process.version, component: String(resourceAttributes(this.env)['matelot.component']) });
  }

  counterAdd(counter: Counter, value: number, attributes: Attributes): void {
    check(attributes);
    counter.add(value, attributes);
  }

  /** The page as a scraper gets it. */
  async render(accept?: string): Promise<{ body: string; contentType: string }> {
    const { resourceMetrics } = await this.scrape.collect();
    const open = wantsOpenMetrics(accept);
    this.lastScrapeAt = new Date();
    return { body: serialize(resourceMetrics, this.exemplars.lookup, open, this.gaugeSets.map((g) => g.family())), contentType: open ? OPENMETRICS_CONTENT_TYPE : TEXT_CONTENT_TYPE };
  }

  async collect(): Promise<ResourceMetrics> {
    return (await this.scrape.collect()).resourceMetrics;
  }

  /** The /metrics listener (never on the ingress; the NetworkPolicy admits the monitoring namespace only). */
  listen(port = Number(this.env.MATELOT_METRICS_PORT ?? 9464), host = '0.0.0.0'): Promise<number> {
    if (this.server) return Promise.resolve((this.server.address() as { port: number }).port);
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/metrics') { res.writeHead(path === '/' ? 200 : 404, { 'content-type': 'text/plain' }).end(path === '/' ? 'matelot metrics: GET /metrics\n' : 'not found\n'); return; }
      this.render(req.headers.accept).then(({ body, contentType }) => res.writeHead(200, { 'content-type': contentType }).end(body)).catch((e: Error) => res.writeHead(500, { 'content-type': 'text/plain' }).end(`metrics collection failed: ${e.message}\n`));
    });
    this.server = server;
    return new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve((server.address() as { port: number }).port)));
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await this.provider.shutdown().catch(() => undefined);
  }
}

/** OTLP push of the same instruments when OTEL_METRICS_EXPORTER names `otlp` (exemplars travel only on the scrape page). */
function otlpReaders(env: NodeJS.ProcessEnv): IMetricReader[] {
  const exporters = (env.OTEL_METRICS_EXPORTER ?? 'prometheus').split(',').map((s) => s.trim().toLowerCase());
  if (!exporters.includes('otlp') || !(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT)) return [];
  const protocol = (env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase();
  const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics') as typeof import('@opentelemetry/sdk-metrics');
  const mod = protocol === 'http/json' ? '@opentelemetry/exporter-metrics-otlp-http' : '@opentelemetry/exporter-metrics-otlp-proto';
  const { OTLPMetricExporter } = require(mod);
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 60000);
  return [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: Number.isFinite(interval) ? interval : 60000 })];
}

let instance: Metrics | null = null;
/** The process-wide instruments (created on first use; registered as the global meter provider). */
export function getMetrics(): Metrics {
  if (!instance) {
    instance = new Metrics();
    otelMetrics.setGlobalMeterProvider(instance.provider);
  }
  return instance;
}

/** Tests: replace the process-wide instance. */
export function setMetricsForTests(m: Metrics | null): void {
  instance = m;
}
