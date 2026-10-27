/**
 * The runner's observability without a dependency (the runner image ships no node_modules): spans exported as
 * OTLP/HTTP JSON, a Prometheus / OpenMetrics page with trace exemplars, and the JSON log line of docs/observability.md.
 * Same contract as the api / worker (which use the OpenTelemetry SDK): W3C traceparent in, OTLP out, resource
 * attributes service.name=matelot-runner, service.version, deployment.environment, matelot.cell, matelot.runner.name.
 *
 * Tracing is on only with OTEL_EXPORTER_OTLP_ENDPOINT (or MATELOT_TRACING_ENABLED=true). Export is asynchronous
 * (batches every 2 s, queue capped at 2048 spans, 5 s request timeout), an unreachable collector costs dropped spans
 * and one warning, and shutdown flushes with a 5 s cap. Only http/json and http/protobuf endpoints are reachable
 * from here (the JSON encoding is sent to both: OTLP/HTTP accepts it); `grpc` is answered with a warning.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

// ---------------------------------------------------------------- ids and traceparent
export function parseTraceparent(value: string | null | undefined): { traceId: string; spanId: string; sampled: boolean } | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec((value ?? '').trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase(), sampled: (parseInt(m[3], 16) & 1) === 1 };
}
export const traceparentOf = (traceId: string, spanId: string, sampled = true) => `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
const newId = (bytes: number) => randomBytes(bytes).toString('hex');

// ---------------------------------------------------------------- spans
export type AttrValue = string | number | boolean;
export interface SpanEvent { name: string; timeMs: number; attributes?: Record<string, AttrValue> }

export class Span {
  readonly spanId = newId(8);
  readonly startMs = Date.now();
  endMs: number | null = null;
  status: 'ok' | 'error' | 'unset' = 'unset';
  statusMessage = '';
  readonly events: SpanEvent[] = [];
  constructor(readonly tracer: Tracer, readonly name: string, readonly traceId: string, readonly parentSpanId: string | null, readonly attributes: Record<string, AttrValue> = {}, readonly sampled = true) {}
  get traceparent(): string { return traceparentOf(this.traceId, this.spanId, this.sampled); }
  setAttribute(key: string, value: AttrValue | null | undefined): this { if (value !== null && value !== undefined) this.attributes[key] = value; return this; }
  addEvent(name: string, attributes?: Record<string, AttrValue>): this { this.events.push({ name, timeMs: Date.now(), attributes }); return this; }
  /** Ends the span; an error message sets the error status. */
  end(error?: string | null): void {
    if (this.endMs !== null) return;
    this.endMs = Date.now();
    if (error) { this.status = 'error'; this.statusMessage = error; } else if (this.status === 'unset') this.status = 'ok';
    this.tracer.enqueue(this);
  }
  /** A child span; runs `fn` with it as the current span. */
  child<T>(name: string, fn: (span: Span) => Promise<T>, attributes?: Record<string, AttrValue>): Promise<T> {
    return this.tracer.run(this.tracer.start(name, this, attributes), fn);
  }
}

export interface TracerOptions {
  endpoint?: string;                  // OTEL_EXPORTER_OTLP_ENDPOINT (base) or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (full)
  headers?: Record<string, string>;
  resource: Record<string, AttrValue>;
  fetchImpl?: typeof fetch;
  batchMs?: number;
  maxQueue?: number;
  warn?: (message: string) => void;
}

export class Tracer {
  private readonly als = new AsyncLocalStorage<Span>();
  private queue: Span[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly warned = new Set<string>();
  dropped = 0;
  exported = 0;
  readonly enabled: boolean;
  private readonly url: string | null;
  constructor(private readonly options: TracerOptions) {
    this.url = options.endpoint ? (options.endpoint.includes('/v1/traces') ? options.endpoint : `${options.endpoint.replace(/\/$/, '')}/v1/traces`) : null;
    this.enabled = !!this.url;
  }

  /** The span the current async context runs in (a child of the job span, say). */
  current(): Span | undefined { return this.als.getStore(); }
  /** The traceparent header for an outgoing request. */
  currentTraceparent(): string | undefined { return this.current()?.traceparent; }

  /** Starts a span under `parent` (a Span, a traceparent string, or the current span). */
  start(name: string, parent?: Span | string | null, attributes?: Record<string, AttrValue>): Span {
    const p = typeof parent === 'string' ? parseTraceparent(parent) : parent === undefined ? this.current() : parent;
    if (p instanceof Span) return new Span(this, name, p.traceId, p.spanId, { ...attributes }, p.sampled);
    if (p) return new Span(this, name, p.traceId, p.spanId, { ...attributes }, p.sampled);
    return new Span(this, name, newId(16), null, { ...attributes }, true);
  }

  run<T>(span: Span, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.als.run(span, async () => {
      try {
        const out = await fn(span);
        span.end();
        return out;
      } catch (error) {
        span.end(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }

  enqueue(span: Span): void {
    if (!this.enabled || !span.sampled) return;
    if (this.queue.length >= (this.options.maxQueue ?? 2048)) { this.dropped++; return; }
    this.queue.push(span);
    if (!this.timer) { this.timer = setTimeout(() => void this.flush(), this.options.batchMs ?? 2000); this.timer.unref(); }
  }

  /** The OTLP/JSON body for a batch (ExportTraceServiceRequest). */
  encode(spans: Span[]): unknown {
    const attr = (o: Record<string, AttrValue>) => Object.entries(o).map(([key, value]) => ({ key, value: typeof value === 'number' ? (Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }) : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) } }));
    return {
      resourceSpans: [{
        resource: { attributes: attr(this.options.resource) },
        scopeSpans: [{
          scope: { name: 'matelot-runner' },
          spans: spans.map((s) => ({
            traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}), name: s.name, kind: 1,
            startTimeUnixNano: `${s.startMs}000000`, endTimeUnixNano: `${s.endMs ?? s.startMs}000000`,
            attributes: attr(s.attributes),
            events: s.events.map((e) => ({ name: e.name, timeUnixNano: `${e.timeMs}000000`, attributes: attr(e.attributes ?? {}) })),
            status: s.status === 'error' ? { code: 2, message: s.statusMessage } : s.status === 'ok' ? { code: 1 } : { code: 0 },
          })),
        }],
      }],
    };
  }

  async flush(timeoutMs = 5000): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.url || !this.queue.length) return;
    const batch = this.queue.splice(0, 512);
    const f = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await f(this.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.options.headers ?? {}) }, body: JSON.stringify(this.encode(batch)), signal: controller.signal });
      if (!res.ok) this.warnOnce(`collector answered ${res.status} for ${this.url}`); else this.exported += batch.length;
    } catch (error) {
      this.dropped += batch.length;
      this.warnOnce(`export to ${this.url} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(t);
    }
    if (this.queue.length) await this.flush(timeoutMs);
  }

  /** Shutdown: what is queued goes out within `capMs`, whatever the collector does. */
  async shutdown(capMs = 5000): Promise<void> {
    await Promise.race([this.flush(capMs), new Promise<void>((r) => setTimeout(r, capMs).unref())]);
    if (this.dropped) this.warnOnce(`${this.dropped} span(s) dropped during this process`);
  }

  private warnOnce(message: string): void {
    const key = message.replace(/\d+/g, 'N');
    if (this.warned.has(key)) return;
    this.warned.add(key);
    (this.options.warn ?? ((m) => process.stderr.write(`${m}\n`)))(`trace export: ${message} (further occurrences are not logged)`);
  }
}

/** The tracer from the environment (OTEL_* variables; MATELOT_TRACING_ENABLED=false forces off). */
export function tracerFromEnv(env: NodeJS.ProcessEnv, resource: Record<string, AttrValue>, warn?: (m: string) => void): Tracer {
  const flag = (env.MATELOT_TRACING_ENABLED ?? '').toLowerCase();
  const endpoint = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  const off = flag === 'false' || flag === '0' || !endpoint;
  const headers: Record<string, string> = {};
  for (const pair of (env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) { const i = pair.indexOf('='); if (i > 0) headers[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim()); }
  const protocol = (env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').toLowerCase();
  if (!off && protocol === 'grpc') (warn ?? ((m) => process.stderr.write(`${m}\n`)))('the runner exports OTLP over HTTP only (OTEL_EXPORTER_OTLP_PROTOCOL=grpc ignored): point it at the collector\'s 4318 port');
  return new Tracer({ endpoint: off ? undefined : endpoint, headers, resource, warn });
}

// ---------------------------------------------------------------- metrics
export const JOB_BUCKETS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 900, 1200, 1800];
/** The job kinds this runner executes (executor.ts) and the statuses a run ends in: every series exists at zero from
 *  the first scrape, so `rate()` counts the first job and the duration quantiles are numbers after it. */
export const RUNNER_JOB_KINDS = ['repository_check', 'sbom', 'sca', 'sast', 'secrets', 'iac', 'kubernetes_inventory', 'custom'];
export const RUNNER_JOB_STATUSES = ['succeeded', 'failed', 'skipped'];
type Labels = Record<string, string>;
const key = (l: Labels) => JSON.stringify(Object.entries(l).sort());
const render = (l: Labels, extra: Labels = {}) => { const e = [...Object.entries(l), ...Object.entries(extra)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); return e.length ? `{${e.map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`).join(',')}}` : ''; };

export class Metrics {
  private readonly counters = new Map<string, { labels: Labels; value: number }>();
  private readonly gauges = new Map<string, { labels: Labels; value: number }>();
  private readonly histograms = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number; exemplars: Map<number, { traceId: string; spanId: string; value: number; ts: number }> }>();
  lastScrapeAt: Date | null = null;
  private server: Server | null = null;
  constructor(private readonly buildInfo: Labels) {}

  /** Known series at zero: a counter at 0, a histogram with empty buckets (never counted as an observation). */
  seedKnownSeries(): void {
    for (const kind of RUNNER_JOB_KINDS) {
      for (const status of RUNNER_JOB_STATUSES) this.inc('matelot_runner_jobs_total', { kind, status }, 0);
      const k = `matelot_runner_job_duration_seconds|${key({ kind, phase: 'total' })}`;
      if (!this.histograms.has(k)) this.histograms.set(k, { labels: { kind, phase: 'total' }, counts: new Array(JOB_BUCKETS.length + 1).fill(0), sum: 0, count: 0, exemplars: new Map() });
    }
  }
  inc(name: string, labels: Labels, by = 1): void { const k = `${name}|${key(labels)}`; const c = this.counters.get(k) ?? { labels, value: 0 }; c.value += by; this.counters.set(k, c); }
  set(name: string, labels: Labels, value: number): void { this.gauges.set(`${name}|${key(labels)}`, { labels, value }); }
  observe(name: string, labels: Labels, value: number, exemplar?: { traceId: string; spanId: string }): void {
    const k = `${name}|${key(labels)}`;
    const h = this.histograms.get(k) ?? { labels, counts: new Array(JOB_BUCKETS.length + 1).fill(0), sum: 0, count: 0, exemplars: new Map() };
    let b = JOB_BUCKETS.findIndex((x) => value <= x); if (b < 0) b = JOB_BUCKETS.length;
    h.counts[b]++; h.sum += value; h.count++;
    if (exemplar) h.exemplars.set(b, { ...exemplar, value, ts: Date.now() });
    this.histograms.set(k, h);
  }

  page(openMetrics: boolean): string {
    const out: string[] = ['# HELP matelot_build_info Always 1; the version labels identify the build', '# TYPE matelot_build_info gauge', `matelot_build_info${render(this.buildInfo)} 1`];
    const families = (m: Map<string, { labels: Labels; value: number }>, type: string) => {
      const byName = new Map<string, { labels: Labels; value: number }[]>();
      for (const [k, v] of m) { const name = k.split('|')[0]; byName.set(name, [...(byName.get(name) ?? []), v]); }
      for (const [name, series] of [...byName].sort()) { out.push(`# TYPE ${name} ${type}`); for (const s of series) out.push(`${name}${render(s.labels)} ${s.value}`); }
    };
    families(this.counters, 'counter'); families(this.gauges, 'gauge');
    const hist = new Map<string, typeof this.histograms extends Map<string, infer V> ? V[] : never>();
    for (const [k, v] of this.histograms) { const name = k.split('|')[0]; hist.set(name, [...(hist.get(name) ?? []), v]); }
    for (const [name, series] of [...hist].sort()) {
      out.push(`# TYPE ${name} histogram`);
      for (const h of series) {
        let cum = 0;
        for (let i = 0; i < h.counts.length; i++) {
          cum += h.counts[i];
          const le = i < JOB_BUCKETS.length ? String(JOB_BUCKETS[i]) : '+Inf';
          const ex = openMetrics ? h.exemplars.get(i) : undefined;
          out.push(`${name}_bucket${render(h.labels, { le })} ${cum}${ex ? ` # {trace_id="${ex.traceId}",span_id="${ex.spanId}"} ${ex.value} ${(ex.ts / 1000).toFixed(3)}` : ''}`);
        }
        out.push(`${name}_sum${render(h.labels)} ${h.sum}`, `${name}_count${render(h.labels)} ${h.count}`);
      }
    }
    if (openMetrics) out.push('# EOF');
    return out.join('\n') + '\n';
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    if (this.server) return Promise.resolve(port);
    const server = createServer((req, res) => {
      if ((req.url ?? '/').split('?')[0] !== '/metrics') { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n'); return; }
      const open = (req.headers.accept ?? '').toLowerCase().includes('application/openmetrics-text');
      this.lastScrapeAt = new Date();
      res.writeHead(200, { 'content-type': open ? 'application/openmetrics-text; version=1.0.0; charset=utf-8' : 'text/plain; version=0.0.4; charset=utf-8' }).end(this.page(open));
    });
    this.server = server;
    return new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve((server.address() as { port: number }).port)));
  }
  close(): Promise<void> { const s = this.server; this.server = null; return s ? new Promise((r) => s.close(() => r())) : Promise.resolve(); }
}

// ---------------------------------------------------------------- logs
export const REDACTED_KEYS = ['authorization', 'cookie', 'password', 'secret', 'token', 'privateKey', 'registrationToken', 'runnerToken', 'managedSecret', 'apiKey'];
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type Level = keyof typeof LEVELS;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = REDACTED_KEYS.some((r) => r.toLowerCase() === k.toLowerCase()) ? '[Redacted]' : redact(v, depth + 1);
  return out;
}

/** The JSON log line of the schema: {time, level, component, cell, runner, msg, trace_id, span_id, …fields}. */
export class JsonLogger {
  constructor(private readonly base: Record<string, AttrValue>, private readonly tracer: Tracer | null, private readonly level: Level = 'info', private readonly out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {}
  log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const span = this.tracer?.current();
    this.out(JSON.stringify({ time: new Date().toISOString(), level, ...this.base, msg, ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}), ...(redact(fields) as Record<string, unknown>) }));
  }
  trace(msg: string, f?: Record<string, unknown>) { this.log('trace', msg, f); }
  debug(msg: string, f?: Record<string, unknown>) { this.log('debug', msg, f); }
  info(msg: string, f?: Record<string, unknown>) { this.log('info', msg, f); }
  warn(msg: string, f?: Record<string, unknown>) { this.log('warn', msg, f); }
  error(msg: string, f?: Record<string, unknown>) { this.log('error', msg, f); }
}

export function levelFromEnv(env: NodeJS.ProcessEnv): Level {
  const first = (env.LOG_LEVEL ?? 'info').split(',')[0].trim().toLowerCase();
  return first in LEVELS ? (first as Level) : 'info';
}

// ---------------------------------------------------------------- process-wide handles (set once by index.ts)
let activeTracer: Tracer | null = null;
export function setTracer(t: Tracer | null): void { activeTracer = t; }
export function getTracer(): Tracer | null { return activeTracer; }

/** Runs `fn` as a child span of the current span ("checkout", "tool syft", "upload sbom"); plain call without tracing. */
export function phase<T>(name: string, fn: () => Promise<T>, attributes?: Record<string, AttrValue>): Promise<T> {
  const current = activeTracer?.current();
  if (!activeTracer || !current) return fn();
  return current.child(name, () => fn(), attributes);
}
