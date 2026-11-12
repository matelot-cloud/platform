/**
 * Settings → Observability and `matelot doctor` (docs/observability.md, "Checking a cell"): what this cell exports and
 * whether anything is listening. Every process (each api and worker pod) writes a heartbeat of its own telemetry state
 * into Redis every 15 s — `matelot:observability:<component>:<instance>` (TTL 2 min, deleted on shutdown): the last
 * /metrics scrape it served, the last span that ended, the exporters it started and their failures per signal, the
 * events it emitted — and the api assembles them with the runners' (which report `metricsScrapedAt` / `tracing` in
 * their heartbeat metadata, execution/runner.controller.ts). Counts are summed over the *current* instances only: a
 * heartbeat older than 45 s is stale, and one of an older pod whose exporter settings a newer pod of the same
 * component replaced is superseded (kind rc.23: a rollout's terminated pods looked like export failures) — both are
 * listed with their age, never counted.
 *
 * The OTLP settings come back with the headers masked (`Authorization=••••`): the endpoint tells an operator where the
 * signals go, the header values are the secret the chart keeps out of values. "Test OTLP" ends a span and a log record
 * with `matelot.test: true`, flushes both providers and reports whether the exporters logged a failure meanwhile.
 */
import { hostname } from 'node:os';
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
import { otlpEndpoint, otlpProtocol } from './export-failures';
import { logsHandle } from './logs';
import { Metrics } from './metrics';
import { tracingHandle } from './tracing';

export { otlpEndpoint } from './export-failures';

export const STATUS_KEY = 'matelot:observability:';
export const STATUS_TTL_SECONDS = 120;
/** a heartbeat older than this is a process that stopped without deleting its key (killed, OOM) */
export const STALE_AFTER_MS = 45_000;
const RUNNER_RECENT_MS = 2 * 60_000;

export interface SignalFailureStatus { count: number; last: string | null; lastAt: string | null }

/** One process's heartbeat (what it writes to Redis, one key per instance: `matelot:observability:<component>:<instance>`). */
export interface ComponentStatus {
  component: string;
  instance: string;                 // the pod name (HOSTNAME) — or host-pid outside Kubernetes
  startedAt: string;                // process start: the newest instance of a component is the current configuration
  version: string | null;
  at: string;                       // when this heartbeat was written
  metricsScrapedAt: string | null;  // last GET /metrics this process served
  lastSpanAt: string | null;        // last span that ended here (null: tracing off or nothing yet)
  tracing: string | null;           // exporter name, null when off
  logs: string | null;              // logs exporter name, null when off
  config: string;                   // what the exporters are set to (tracing / logs exporter + endpoints): a rollout changes it
  events: { audit: number; security: number };
  exportFailures: { traces: SignalFailureStatus; logs: SignalFailureStatus };
}

/** A heartbeat as the status reports it: with its age and whether it counts. */
export interface InstanceStatus extends ComponentStatus {
  ageSeconds: number;
  /** current: counted · superseded: an older pod whose exporter settings a newer pod of the component replaced (a rollout) · stale: no heartbeat for 45 s */
  state: 'current' | 'superseded' | 'stale';
}

type EventCounts = { audit: number; security: number };

export interface ObservabilityStatus {
  cell: string | null;
  environment: string;
  metrics: { enabled: boolean; port: number; lastScrapeAt: string | null };
  tracing: { enabled: boolean; exporter: string | null; endpoint: string | null; protocol: string; headers: string[]; sampler: string; getRatio: number; lastSpanAt: string | null; exportFailures: number; lastExportError: string | null; lastExportErrorAt: string | null };
  logs: { enabled: boolean; exporter: string | null; endpoint: string | null; protocol: string; emitted: EventCounts; exportFailures: number; lastExportError: string | null; lastExportErrorAt: string | null };
  /** the audit / security events since each current process started: the api's (requests, refusals) and the worker's (gate, job and pipeline transitions) */
  events: { total: EventCounts; byComponent: Record<string, EventCounts> };
  grafana: { url: string } | null;
  components: {
    /** the newest current instance of each (null: none reported in the last 45 s) */
    api: InstanceStatus | null;
    worker: InstanceStatus | null;
    /** every heartbeat in Redis, newest first — superseded and stale ones are listed, never counted */
    instances: InstanceStatus[];
    runners: { online: number; reporting: number; metricsScrapedAt: string | null; tracing: number };
  };
  generatedAt: string;
}

export interface TestOtlpResult {
  traceId: string | null;
  traces: { attempted: boolean; ok: boolean; error: string | null };
  logs: { attempted: boolean; ok: boolean; error: string | null };
}

/** Pure: the heartbeats' states — stale after 45 s, superseded by a newer instance of the component with other exporter settings. */
export function classifyInstances(beats: ComponentStatus[], now: Date): InstanceStatus[] {
  const fresh = beats.filter((b) => now.getTime() - new Date(b.at).getTime() <= STALE_AFTER_MS);
  const newest = new Map<string, ComponentStatus>();
  for (const b of fresh) { const n = newest.get(b.component); if (!n || b.startedAt > n.startedAt) newest.set(b.component, b); }
  return beats.map((b): InstanceStatus => {
    const ageSeconds = Math.max(0, Math.round((now.getTime() - new Date(b.at).getTime()) / 1000));
    const n = newest.get(b.component);
    const state = !fresh.includes(b) ? 'stale' : n && n !== b && n.config !== b.config && n.startedAt > b.startedAt ? 'superseded' : 'current';
    return { ...b, ageSeconds, state };
  }).sort((x, y) => x.component.localeCompare(y.component) || y.startedAt.localeCompare(x.startedAt));
}

/** A heartbeat of the drop-4 format (one key per component, a number for exportFailures) read as the current one. */
function upgrade(raw: Record<string, unknown>, key: string): ComponentStatus {
  const r = raw as Partial<ComponentStatus> & { exportFailures?: unknown };
  const none = { count: 0, last: null, lastAt: null };
  const ef = typeof r.exportFailures === 'number' ? { traces: { ...none, count: r.exportFailures }, logs: none } : (r.exportFailures as ComponentStatus['exportFailures'] | undefined) ?? { traces: none, logs: none };
  return {
    component: r.component ?? key.slice(STATUS_KEY.length).split(':')[0], instance: r.instance ?? 'unknown', startedAt: r.startedAt ?? r.at ?? new Date(0).toISOString(),
    version: r.version ?? null, at: r.at ?? new Date(0).toISOString(), metricsScrapedAt: r.metricsScrapedAt ?? null, lastSpanAt: r.lastSpanAt ?? null,
    tracing: r.tracing ?? null, logs: r.logs ?? null, config: r.config ?? `${r.tracing ?? '-'}|${r.logs ?? '-'}`, events: r.events ?? { audit: 0, security: 0 }, exportFailures: ef,
  };
}

/** Test OTLP waits this long for the export to finish: a refused connection is retried with backoff (~15 s) before it
 *  fails, and a flush that hit its cap is *not* a success (it said "sent" for an endpoint nobody listened on). */
const TEST_FLUSH_MS = 12_000;
const noAnswer = (url: string | null) => `no answer within ${TEST_FLUSH_MS / 1000} s from ${url ?? 'the endpoint'} — the exporter is still retrying (connection refused or timing out?)`;

const newestOf = <T extends { at: string | null }>(xs: T[]) => xs.filter((x) => x.at).sort((a, b) => String(a.at).localeCompare(String(b.at))).pop();

/** `Authorization=Basic abc,x-scope=1` → ['Authorization=••••', 'x-scope=••••']: the keys say which headers are set, never a value. */
export function maskHeaders(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => `${decodeURIComponent(p.split('=')[0].trim())}=••••`);
}

@Injectable()
export class ObservabilityStatusService {
  private readonly logger = new Logger(ObservabilityStatusService.name);
  private redis: IORedis | null;
  private timer?: NodeJS.Timeout;
  private component: string;
  private env: NodeJS.ProcessEnv = process.env;
  private instance: string;
  private readonly startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

  constructor(@Inject(ConfigService) private readonly config: AppConfig, private readonly metrics: Metrics, @Inject(DATABASE) private readonly db: Database, @Optional() queue?: QueueService) {
    this.redis = queue?.redis ?? null;
    this.component = this.env.MATELOT_COMPONENT ?? (process.argv[1]?.includes('worker') ? 'worker' : 'api');
    this.instance = this.env.HOSTNAME || `${hostname()}-${process.pid}`;
  }

  /** Tests: another environment than the process's. */
  withEnv(env: NodeJS.ProcessEnv): this {
    this.env = env; this.component = env.MATELOT_COMPONENT ?? this.component; this.instance = env.HOSTNAME || this.instance; return this;
  }

  /** The worker has no QueueService: it hands over its own connection (worker.service.ts), like WorkerGauges. */
  attach(redis: IORedis): void { this.redis = redis; }

  private get key(): string { return `${STATUS_KEY}${this.component}:${this.instance}`; }

  start(): void {
    if (this.timer) return;
    void this.heartbeat();
    this.timer = setInterval(() => void this.heartbeat(), Number(this.env.MATELOT_STATUS_HEARTBEAT_MS) || 15_000);
    this.timer.unref();
  }

  /** On shutdown the heartbeat goes with the pod: a rollout's terminated pods must not look like failures for 2 minutes. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.redis) await this.redis.del(this.key).catch(() => undefined);
  }

  /** This process's state (what goes to Redis). */
  own(now = new Date()): ComponentStatus {
    const t = tracingHandle();
    const l = logsHandle();
    const none = { count: 0, last: null, lastAt: null };
    const env = this.env;
    return {
      component: this.component,
      instance: this.instance,
      startedAt: this.startedAt,
      version: env.APP_VERSION ?? null,
      at: now.toISOString(),
      metricsScrapedAt: this.metrics.lastScrapeAt?.toISOString() ?? null,
      lastSpanAt: t?.lastSpanAt()?.toISOString() ?? null,
      tracing: t?.exporter ?? null,
      logs: l?.exporter ?? null,
      config: [t?.exporter ?? '-', t ? otlpEndpoint(env, 'traces') ?? '' : '', l?.exporter ?? '-', l ? otlpEndpoint(env, 'logs') ?? '' : ''].join('|'),
      events: getEvents().emitted(),
      exportFailures: { traces: t?.failures() ?? none, logs: l?.failures() ?? none },
    };
  }

  async heartbeat(): Promise<void> {
    if (!this.redis) return;
    try { await this.redis.set(this.key, JSON.stringify(this.own()), 'EX', STATUS_TTL_SECONDS); } catch (e) { this.logger.debug(`status heartbeat not written: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** Every heartbeat in Redis (this process's own state live, not its last heartbeat). */
  private async beats(now: Date): Promise<ComponentStatus[]> {
    const own = this.own(now);
    if (!this.redis) return [own];
    const out = new Map<string, ComponentStatus>();
    try {
      let cursor = '0';
      const keys: string[] = [];
      do {
        const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${STATUS_KEY}*`, 'COUNT', 200);
        cursor = next; keys.push(...batch);
      } while (cursor !== '0' && keys.length < 2000);
      const values = keys.length ? await this.redis.mget(...keys) : [];
      keys.forEach((k, i) => {
        const raw = values[i];
        if (!raw) return;
        try { const b = upgrade(JSON.parse(raw) as Record<string, unknown>, k); out.set(`${b.component}:${b.instance}`, b); } catch { /* not ours */ }
      });
    } catch (e) { this.logger.debug(`heartbeats not read: ${e instanceof Error ? e.message : String(e)}`); }
    out.set(`${own.component}:${own.instance}`, own);
    return [...out.values()];
  }

  async status(now = new Date()): Promise<ObservabilityStatus> {
    const env = this.env;
    const [beats, rows] = await Promise.all([
      this.beats(now),
      this.db.select({ status: runners.status, metadata: runners.metadata, lastHeartbeatAt: runners.lastHeartbeatAt }).from(runners).where(and(isNotNull(runners.lastHeartbeatAt), gt(runners.lastHeartbeatAt, new Date(now.getTime() - RUNNER_RECENT_MS)))),
    ]);
    const instances = classifyInstances(beats, now);
    const current = instances.filter((i) => i.state === 'current');
    const newest = (component: string) => current.filter((i) => i.component === component).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
    const byComponent: Record<string, EventCounts> = {};
    for (const i of current) {
      const c = (byComponent[i.component] ??= { audit: 0, security: 0 });
      c.audit += i.events.audit; c.security += i.events.security;
    }
    const total = Object.values(byComponent).reduce((a, c) => ({ audit: a.audit + c.audit, security: a.security + c.security }), { audit: 0, security: 0 });
    const failuresOf = (signal: 'traces' | 'logs') => {
      const last = newestOf(current.map((i) => ({ at: i.exportFailures[signal].lastAt, line: i.exportFailures[signal].last })));
      return { exportFailures: current.reduce((n, i) => n + i.exportFailures[signal].count, 0), lastExportError: last?.line ?? null, lastExportErrorAt: last?.at ?? null };
    };
    const scraped = rows.map((r) => (typeof r.metadata?.metricsScrapedAt === 'string' ? r.metadata.metricsScrapedAt : null)).filter((x): x is string => !!x).sort();
    const t = tracingHandle();
    const l = logsHandle();
    const own = this.own(now);
    const grafana = this.config.get('MATELOT_GRAFANA_URL', { infer: true });
    return {
      cell: env.BOOTSTRAP_ORG_SLUG ?? null,
      environment: env.DEPLOYMENT_ENVIRONMENT ?? 'production',
      metrics: { enabled: this.config.get('MATELOT_METRICS_ENABLED', { infer: true }) !== false, port: this.config.get('MATELOT_METRICS_PORT', { infer: true }), lastScrapeAt: own.metricsScrapedAt },
      tracing: {
        enabled: !!t, exporter: t?.exporter ?? null, endpoint: t ? otlpEndpoint(env, 'traces') : null,
        protocol: otlpProtocol(env, 'traces'),
        headers: maskHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS),
        sampler: env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on', getRatio: Number(env.MATELOT_TRACES_GET_RATIO ?? 0.1) || 0.1,
        lastSpanAt: current.map((i) => i.lastSpanAt).filter((x): x is string => !!x).sort().pop() ?? null,
        ...failuresOf('traces'),
      },
      logs: { enabled: !!l, exporter: l?.exporter ?? null, endpoint: l ? otlpEndpoint(env, 'logs') : null, protocol: otlpProtocol(env, 'logs'), emitted: total, ...failuresOf('logs') },
      events: { total, byComponent },
      grafana: grafana ? { url: grafana } : null,
      components: {
        api: newest('api'), worker: newest('worker'), instances,
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
      const finished = await t.flush(TEST_FLUSH_MS);
      const after = t.failures();
      result.traces = after.count !== before ? { attempted: true, ok: false, error: after.last }
        : finished ? { attempted: true, ok: true, error: null }
        : { attempted: true, ok: false, error: noAnswer(otlpEndpoint(this.env, 'traces')) };
    } else if (t) {
      result.traces = { attempted: false, ok: false, error: `traces go to the ${t.exporter} exporter, not OTLP` };
    } else {
      result.traces = { attempted: false, ok: false, error: 'tracing is off (no OTLP endpoint configured)' };
    }
    if (l && l.exporter === 'otlp') {
      const before = l.failures().count;
      logs.getLogger(EVENTS_SCOPE).emit({ severityNumber: SeverityNumber.INFO, severityText: 'INFO', body: 'matelot.test', attributes: { 'event.name': 'matelot.test', 'matelot.test': true } });
      const finished = await l.flush(TEST_FLUSH_MS);
      const after = l.failures();
      result.logs = after.count !== before ? { attempted: true, ok: false, error: after.last }
        : finished ? { attempted: true, ok: true, error: null }
        : { attempted: true, ok: false, error: noAnswer(otlpEndpoint(this.env, 'logs')) };
    } else if (l) {
      result.logs = { attempted: false, ok: false, error: `log records go to the ${l.exporter} exporter, not OTLP` };
    } else {
      result.logs = { attempted: false, ok: false, error: 'OTLP logs are off (OTEL_LOGS_EXPORTER unset)' };
    }
    return result;
  }
}
