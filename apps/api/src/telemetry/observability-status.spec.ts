import { ObservabilityStatusService, STATUS_KEY, maskHeaders, otlpEndpoint } from './observability-status.service';
import { Metrics } from './metrics';

describe('observability status (Settings → Observability, matelot doctor)', () => {
  it('maskHeaders: the header names, never a value', () => {
    expect(maskHeaders('Authorization=Basic abc123,X-Scope-OrgID=tenant-1')).toEqual(['Authorization=••••', 'X-Scope-OrgID=••••']);
    expect(maskHeaders('Authorization=Basic%20abc')).toEqual(['Authorization=••••']);
    expect(maskHeaders(undefined)).toEqual([]);
    expect(maskHeaders('').join()).not.toContain('abc');
  });

  it('otlpEndpoint: the signal-specific variable wins, else the shared endpoint plus the http path', () => {
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/' }, 'traces')).toBe('http://otel-collector:4318/v1/traces');
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318' }, 'logs')).toBe('http://otel-collector:4318/v1/logs');
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'otel-collector:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, 'traces')).toBe('otel-collector:4317');
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://b:4318/v1/traces' }, 'traces')).toBe('http://b:4318/v1/traces');
    expect(otlpEndpoint({}, 'traces')).toBeNull();
  });

  it('status(): this process plus the other components from Redis and the runners from their heartbeats; headers masked', async () => {
    const env = { MATELOT_COMPONENT: 'api', APP_VERSION: '1.2.3', BOOTSTRAP_ORG_SLUG: 'acme', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic s3cret', MATELOT_GRAFANA_URL: 'https://grafana.example.com' } as NodeJS.ProcessEnv;
    const store = new Map<string, string>([[`${STATUS_KEY}worker`, JSON.stringify({ component: 'worker', version: '1.2.3', at: '2026-11-01T10:00:00.000Z', metricsScrapedAt: '2026-11-01T09:59:50.000Z', lastSpanAt: '2026-11-01T09:59:59.000Z', tracing: 'otlp', logs: null, events: { audit: 4, security: 1 }, exportFailures: 2 })]]);
    const redis = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); return 'OK'; } };
    const rows = [
      { status: 'online', metadata: { metricsScrapedAt: '2026-11-01T09:59:40.000Z', tracing: true }, lastHeartbeatAt: new Date() },
      { status: 'busy', metadata: { metricsScrapedAt: '2026-11-01T09:59:55.000Z', tracing: false }, lastHeartbeatAt: new Date() },
      { status: 'online', metadata: {}, lastHeartbeatAt: new Date() },
    ];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
    const config = { get: (k: string) => ({ MATELOT_METRICS_ENABLED: true, MATELOT_METRICS_PORT: 9464, MATELOT_GRAFANA_URL: 'https://grafana.example.com' } as Record<string, unknown>)[k] };
    const metrics = new Metrics({ env: { MATELOT_COMPONENT: 'api' } as NodeJS.ProcessEnv });
    await metrics.render();
    const svc = new ObservabilityStatusService(config as never, metrics, db as never, { redis } as never).withEnv(env);
    await svc.heartbeat();
    expect(store.has(`${STATUS_KEY}api`)).toBe(true);
    const s = await svc.status(new Date('2026-11-01T10:00:05.000Z'));
    expect(s.cell).toBe('acme');
    expect(s.metrics).toEqual({ enabled: true, port: 9464, lastScrapeAt: metrics.lastScrapeAt!.toISOString() });
    expect(s.tracing.headers).toEqual(['Authorization=••••']);
    expect(JSON.stringify(s)).not.toContain('s3cret');
    expect(s.tracing.endpoint).toBeNull();            // tracing is not started in this test process: nothing is exported
    expect(s.tracing.lastSpanAt).toBe('2026-11-01T09:59:59.000Z');   // the worker's
    expect(s.tracing.exportFailures).toBe(2);
    expect(s.logs.emitted).toEqual({ audit: 4, security: 1 });
    expect(s.grafana).toEqual({ url: 'https://grafana.example.com' });
    expect(s.components.worker?.metricsScrapedAt).toBe('2026-11-01T09:59:50.000Z');
    expect(s.components.api?.component).toBe('api');
    expect(s.components.runners).toEqual({ online: 3, reporting: 2, metricsScrapedAt: '2026-11-01T09:59:55.000Z', tracing: 1 });
    await metrics.close();
  });

  it('testOtlp(): says plainly when nothing is configured', async () => {
    const metrics = new Metrics({ env: { MATELOT_COMPONENT: 'api' } as NodeJS.ProcessEnv });
    const svc = new ObservabilityStatusService({ get: () => undefined } as never, metrics, {} as never, undefined).withEnv({ MATELOT_COMPONENT: 'api' } as NodeJS.ProcessEnv);
    const r = await svc.testOtlp();
    expect(r.traces).toEqual({ attempted: false, ok: false, error: 'tracing is off (no OTLP endpoint configured)' });
    expect(r.logs).toEqual({ attempted: false, ok: false, error: 'OTLP logs are off (OTEL_LOGS_EXPORTER unset)' });
    await metrics.close();
  });
});
