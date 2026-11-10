/**
 * Settings → Observability and `matelot doctor` (docs/observability.md, "Checking a cell"): what this cell exports and
 * whether anything is listening. Every process (api, worker) writes a heartbeat of its own telemetry state into Redis
 * every 15 s — `matelot:observability:<component>` (TTL 2 min): the last /metrics scrape it served, the last span
 * that ended, the exporters it started, the events it emitted — and the api assembles them with the runners' (which
 * report `metricsScrapedAt` / `tracing` in their heartbeat metadata, execution/runner.controller.ts).
 *
 * The OTLP settings come back with the headers masked (`Authorization=••••`): the endpoint tells an operator where the
 * signals go, the header values are the secret the chart keeps out of values. "Test OTLP" ends a span and a log record
 * with `matelot.test: true`, flushes both providers and reports whether the exporters logged a failure meanwhile.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';
import { and, gt, isNotNull } from 'drizzle-orm';
import type IORedis from 'ioredis';
import type { AppConfig } from '../config/env';
import { DATABASE, type Database } from '../database/database.module';
import { runners } from '../database/schema';
import { QueueService } from '../jobs/queue.service';
import { EVENTS_SCOPE, getEvents } from './events';
import { logsHandle } from './logs';
import { Metrics } from './metrics';
import { tracingHandle } from './tracing';

export const STATUS_KEY = 'matelot:observability:';
export const STATUS_TTL_SECONDS = 120;
const RUNNER_RECENT_MS = 2 * 60_000;

/** One process's heartbeat (what it writes to Redis). */
export interface ComponentStatus {
  component: string;
  version: string | null;
  at: string;                       // when this heartbeat was written
  metricsScrapedAt: string | null;  // last GET /metrics this process served
  lastSpanAt: string | null;        // last span that ended here (null: tracing off or nothing yet)
  tracing: string | null;           // exporter name, null when off
  logs: string | null;              // logs exporter name, null when off
  events: { audit: number; security: number };
  exportFailures: number;
}

export interface ObservabilityStatus {
  cell: string | null;
  environment: string;
  metrics: { enabled: boolean; port: number; lastScrapeAt: string | null };
  tracing: { enabled: boolean; exporter: string | null; endpoint: string | null; protocol: string; headers: string[]; sampler: string; getRatio: number; lastSpanAt: string | null; exportFailures: number; lastExportError: string | null };
  logs: { enabled: boolean; exporter: string | null; endpoint: string | null; emitted: { audit: number; security: number } };
  grafana: { url: string } | null;
  components: {
    api: ComponentStatus | null;
    worker: ComponentStatus | null;
    runners: { online: number; reporting: number; metricsScrapedAt: string | null; tracing: number };
  };
  generatedAt: string;
}

export interface TestOtlpResult {
  traceId: string | null;
  traces: { attempted: boolean; ok: boolean; error: string | null };
  logs: { attempted: boolean; ok: boolean; error: string | null };
}

/** `Authorization=Basic abc,x-scope=1` → ['Authorization=••••', 'x-scope=••••']: the keys say which headers are set, never a value. */
export function maskHeaders(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => `${decodeURIComponent(p.split('=')[0].trim())}=••••`);
}

/** The OTLP endpoint a signal goes to: the signal-specific variable, else the shared one (plus the path the SDK adds for http). */
export function otlpEndpoint(env: NodeJS.ProcessEnv, signal: 'traces' | 'logs'): string | null {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]?.trim();
  if (specific) return specific;
  const shared = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!shared) return null;
  const protocol = (env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase();
  return protocol === 'grpc' ? shared : `${shared.replace(/\/+$/, '')}/v1/${signal}`;
}

@Injectable()
export class ObservabilityStatusService {
  private readonly logger = new Logger(ObservabilityStatusService.name);
  private redis: IORedis | null;
  private timer?: NodeJS.Timeout;
  private component: string;
  private env: NodeJS.ProcessEnv = process.env;

  constructor(@Inject(ConfigService) private readonly config: AppConfig, private readonly metrics: Metrics, @Inject(DATABASE) private readonly db: Database, @Optional() queue?: QueueService) {
    this.redis = queue?.redis ?? null;
    this.component = this.env.MATELOT_COMPONENT ?? (process.argv[1]?.includes('worker') ? 'worker' : 'api');
  }

  /** Tests: another environment than the process's. */
  withEnv(env: NodeJS.ProcessEnv): this { this.env = env; this.component = env.MATELOT_COMPONENT ?? this.component; return this; }

  /** The worker has no QueueService: it hands over its own connection (worker.service.ts), like WorkerGauges. */
  attach(redis: IORedis): void { this.redis = redis; }

  start(): void {
    if (this.timer) return;
    void this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat(), 15_000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** This process's state (what goes to Redis). */
  own(now = new Date()): ComponentStatus {
    const t = tracingHandle();
    return {
      component: this.component,
      version: this.env.APP_VERSION ?? null,
      at: now.toISOString(),
      metricsScrapedAt: this.metrics.lastScrapeAt?.toISOString() ?? null,
      lastSpanAt: t?.lastSpanAt()?.toISOString() ?? null,
      tracing: t?.exporter ?? null,
      logs: logsHandle()?.exporter ?? null,
      events: getEvents().emitted(),
      exportFailures: t?.failures().count ?? 0,
    };
  }

  async heartbeat(): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.set(`${STATUS_KEY}${this.component}`, JSON.stringify(this.own()), 'EX', STATUS_TTL_SECONDS); } catch (e) { this.logger.debug(`status heartbeat not written: ${e instanceof Error ? e.message : String(e)}`); }
  }

  private async read(component: string): Promise<ComponentStatus | null> {
    if (!this.redis) return component === this.component ? this.own() : null;
    try {
      const raw = await this.redis.get(`${STATUS_KEY}${component}`);
      if (raw) return JSON.parse(raw) as ComponentStatus;
    } catch (e) { this.logger.debug(`status of ${component} not read: ${e instanceof Error ? e.message : String(e)}`); }
    return component === this.component ? this.own() : null;
  }

  async status(now = new Date()): Promise<ObservabilityStatus> {
    const env = this.env;
    const [api, worker, rows] = await Promise.all([
      this.read('api'), this.read('worker'),
      this.db.select({ status: runners.status, metadata: runners.metadata, lastHeartbeatAt: runners.lastHeartbeatAt }).from(runners).where(and(isNotNull(runners.lastHeartbeatAt), gt(runners.lastHeartbeatAt, new Date(now.getTime() - RUNNER_RECENT_MS)))),
    ]);
    const scraped = rows.map((r) => (typeof r.metadata?.metricsScrapedAt === 'string' ? r.metadata.metricsScrapedAt : null)).filter((x): x is string => !!x).sort();
    const t = tracingHandle();
    const own = this.own(now);
    const grafana = this.config.get('MATELOT_GRAFANA_URL', { infer: true });
    return {
      cell: env.BOOTSTRAP_ORG_SLUG ?? null,
      environment: env.DEPLOYMENT_ENVIRONMENT ?? 'production',
      metrics: { enabled: this.config.get('MATELOT_METRICS_ENABLED', { infer: true }) !== false, port: this.config.get('MATELOT_METRICS_PORT', { infer: true }), lastScrapeAt: own.metricsScrapedAt },
      tracing: {
        enabled: !!t, exporter: t?.exporter ?? null, endpoint: t ? otlpEndpoint(env, 'traces') : null,
        protocol: (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim().toLowerCase(),
        headers: maskHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
        sampler: env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on', getRatio: Number(env.MATELOT_TRACES_GET_RATIO ?? 0.1) || 0.1,
        lastSpanAt: [api?.lastSpanAt, worker?.lastSpanAt].filter((x): x is string => !!x).sort().pop() ?? null,
        exportFailures: (api?.exportFailures ?? 0) + (worker?.exportFailures ?? 0), lastExportError: t?.failures().last ?? null,
      },
      logs: {
        enabled: !!logsHandle(), exporter: logsHandle()?.exporter ?? null, endpoint: logsHandle() ? otlpEndpoint(env, 'logs') : null,
        emitted: { audit: (api?.events.audit ?? 0) + (worker?.events.audit ?? 0), security: (api?.events.security ?? 0) + (worker?.events.security ?? 0) },
      },
      grafana: grafana ? { url: grafana } : null,
      components: {
        api, worker,
        runners: { online: rows.length, reporting: scraped.length, metricsScrapedAt: scraped.pop() ?? null, tracing: rows.filter((r) => r.metadata?.tracing === true).length },
      },
      generatedAt: now.toISOString(),
    };
  }

  /** Ends a test span and a test log record, flushes, and says whether the exporters complained. */
  async testOtlp(): Promise<TestOtlpResult> {
    const t = tracingHandle();
    const l = logsHandle();
    const result: TestOtlpResult = { traceId: null, traces: { attempted: false, ok: false, error: null }, logs: { attempted: false, ok: false, error: null } };
    if (t && t.exporter === 'otlp') {
      const before = t.failures().count;
      const span = trace.getTracer('matelot').startSpan('matelot.test', { attributes: { 'matelot.test': true } });
      result.traceId = span.spanContext().traceId;
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      await t.flush(5000);
      const after = t.failures();
      result.traces = { attempted: true, ok: after.count === before, error: after.count === before ? null : after.last };
    } else if (t) {
      result.traces = { attempted: false, ok: false, error: `traces go to the ${t.exporter} exporter, not OTLP` };
    } else {
      result.traces = { attempted: false, ok: false, error: 'tracing is off (no OTLP endpoint configured)' };
    }
    if (l && l.exporter === 'otlp') {
      const before = l.failures().count;
      logs.getLogger(EVENTS_SCOPE).emit({ severityNumber: SeverityNumber.INFO, severityText: 'INFO', body: 'matelot.test', attributes: { 'event.name': 'matelot.test', 'matelot.test': true } });
      await l.flush(5000);
      const after = l.failures();
      result.logs = { attempted: true, ok: after.count === before, error: after.count === before ? null : after.last };
    } else if (l) {
      result.logs = { attempted: false, ok: false, error: `log records go to the ${l.exporter} exporter, not OTLP` };
    } else {
      result.logs = { attempted: false, ok: false, error: 'OTLP logs are off (OTEL_LOGS_EXPORTER unset)' };
    }
    return result;
  }
}
