import { ObservabilityStatusService, STATUS_KEY, classifyInstances, maskHeaders, type ComponentStatus } from './observability-status.service';
import { Metrics } from './metrics';

const NOW = new Date('2026-11-10T10:00:00.000Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const none = { count: 0, last: null, lastAt: null };
const beat = (o: Partial<ComponentStatus> & Pick<ComponentStatus, 'component' | 'instance'>): ComponentStatus => ({
  startedAt: ago(3600), version: '1.2.3', at: ago(5), metricsScrapedAt: ago(10), lastSpanAt: null, tracing: 'otlp', logs: null,
  config: 'otlp|http://otel:4318/v1/traces|-|', events: { audit: 0, security: 0 }, exportFailures: { traces: none, logs: none }, ...o,
});

/** the bits of ioredis the service uses */
function fakeRedis(store: Map<string, string>) {
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
    mget: async (...ks: string[]) => ks.map((k) => store.get(k) ?? null),
    scan: async (_c: string, _m: string, pattern: string) => ['0', [...store.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, '')))] as [string, string[]],
  };
}

function service(store: Map<string, string>, env: NodeJS.ProcessEnv, rows: unknown[] = []) {
  const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
  const config = { get: (k: string) => ({ MATELOT_METRICS_ENABLED: true, MATELOT_METRICS_PORT: 9464, MATELOT_GRAFANA_URL: env.MATELOT_GRAFANA_URL } as Record<string, unknown>)[k] };
  const metrics = new Metrics({ env: { MATELOT_COMPONENT: 'api' } as NodeJS.ProcessEnv });
  return { metrics, svc: new ObservabilityStatusService(config as never, metrics, db as never, { redis: fakeRedis(store) } as never).withEnv(env) };
}

describe('observability status (Administration → Observability, matelot doctor)', () => {
  it('maskHeaders: the header names, never a value', () => {
    expect(maskHeaders('Authorization=Basic abc123,X-Scope-OrgID=tenant-1')).toEqual(['Authorization=••••', 'X-Scope-OrgID=••••']);
    expect(maskHeaders('Authorization=Basic%20abc')).toEqual(['Authorization=••••']);
    expect(maskHeaders(undefined)).toEqual([]);
  });

  it('events are summed over api AND worker: a gate failure the worker reported is in the total (kind rc.23)', async () => {
    const store = new Map<string, string>();
    // the worker evaluated the gate of pipeline #8: gate.fail, job.failed, pipeline.failed audits + one gate.failed security event
    store.set(`${STATUS_KEY}worker:worker-7d9-abc`, JSON.stringify(beat({ component: 'worker', instance: 'worker-7d9-abc', events: { audit: 3, security: 1 } })));
    const { svc, metrics } = service(store, { MATELOT_COMPONENT: 'api', HOSTNAME: 'api-5f6-xyz', BOOTSTRAP_ORG_SLUG: 'acme' } as NodeJS.ProcessEnv);
    const s = await svc.status(NOW);
    expect(s.events.byComponent.worker).toEqual({ audit: 3, security: 1 });
    expect(s.events.total.security).toBe(1 + (s.events.byComponent.api?.security ?? 0));
    expect(s.events.total.audit).toBe(3 + (s.events.byComponent.api?.audit ?? 0));
    expect(s.logs.emitted).toEqual(s.events.total);
    expect(s.components.worker?.instance).toBe('worker-7d9-abc');
    expect(s.components.api?.instance).toBe('api-5f6-xyz');   // this process, live
    await metrics.close();
  });

  it('export failures per signal: a logs exporter answering 404 is not a tracing failure', async () => {
    const store = new Map<string, string>();
    const logs404 = { count: 3, last: 'OTLPExporterError: Not Found (HTTP 404) — POST http://tempo.monitoring:4318/v1/logs', lastAt: ago(20) };
    store.set(`${STATUS_KEY}worker:w1`, JSON.stringify(beat({ component: 'worker', instance: 'w1', logs: 'otlp', lastSpanAt: ago(28), exportFailures: { traces: none, logs: logs404 } })));
    const { svc, metrics } = service(store, { MATELOT_COMPONENT: 'api', HOSTNAME: 'a1' } as NodeJS.ProcessEnv);
    const s = await svc.status(NOW);
    expect(s.tracing.exportFailures).toBe(0);
    expect(s.tracing.lastExportError).toBeNull();
    expect(s.tracing.lastSpanAt).toBe(ago(28));
    expect(s.logs.exportFailures).toBe(3);
    expect(s.logs.lastExportError).toBe(logs404.last);
    expect(s.logs.lastExportErrorAt).toBe(ago(20));
    await metrics.close();
  });

  it('a rollout: the terminated pod with the old exporter settings is listed as superseded, never counted', async () => {
    const store = new Map<string, string>();
    const failing = { count: 3, last: 'OTLPExporterError: Not Found (HTTP 404) — POST http://tempo:4318/v1/logs', lastAt: ago(40) };
    store.set(`${STATUS_KEY}worker:old`, JSON.stringify(beat({ component: 'worker', instance: 'old', startedAt: ago(3600), at: ago(10), logs: 'otlp', config: 'otlp|t|otlp|http://tempo:4318/v1/logs', events: { audit: 9, security: 2 }, exportFailures: { traces: none, logs: failing } })));
    store.set(`${STATUS_KEY}worker:new`, JSON.stringify(beat({ component: 'worker', instance: 'new', startedAt: ago(30), at: ago(2), config: 'otlp|t|-|', events: { audit: 1, security: 0 } })));
    store.set(`${STATUS_KEY}worker:killed`, JSON.stringify(beat({ component: 'worker', instance: 'killed', startedAt: ago(7200), at: ago(90), config: 'otlp|t|-|', events: { audit: 50, security: 5 } })));
    // the drop-4 format (one key per component, a number for exportFailures): read, stale by age
    store.set(`${STATUS_KEY}api`, JSON.stringify({ component: 'api', at: ago(100), tracing: 'otlp', logs: 'otlp', events: { audit: 7, security: 0 }, exportFailures: 1 }));
    const { svc, metrics } = service(store, { MATELOT_COMPONENT: 'api', HOSTNAME: 'api-new' } as NodeJS.ProcessEnv);
    const s = await svc.status(NOW);
    const states = Object.fromEntries(s.components.instances.map((i) => [i.instance, [i.state, i.ageSeconds]]));
    expect(states).toMatchObject({ old: ['superseded', 10], new: ['current', 2], killed: ['stale', 90], unknown: ['stale', 100], 'api-new': ['current', 0] });
    expect(s.events.byComponent.worker).toEqual({ audit: 1, security: 0 });
    expect(s.logs.exportFailures).toBe(0);
    expect(s.tracing.exportFailures).toBe(0);
    expect(s.components.worker?.instance).toBe('new');
    await metrics.close();
  });

  it('two replicas with the same settings are both current and add up', () => {
    const r = classifyInstances([
      beat({ component: 'api', instance: 'a', startedAt: ago(100), events: { audit: 2, security: 1 } }),
      beat({ component: 'api', instance: 'b', startedAt: ago(50), events: { audit: 3, security: 0 } }),
    ], NOW);
    expect(r.map((i) => i.state)).toEqual(['current', 'current']);
  });

  it('heartbeat keys are per instance; stop() deletes this pod\'s key', async () => {
    const store = new Map<string, string>();
    const { svc, metrics } = service(store, { MATELOT_COMPONENT: 'worker', HOSTNAME: 'worker-abc' } as NodeJS.ProcessEnv);
    await svc.heartbeat();
    expect([...store.keys()]).toEqual([`${STATUS_KEY}worker:worker-abc`]);
    const b = JSON.parse(store.get(`${STATUS_KEY}worker:worker-abc`)!) as ComponentStatus;
    expect(b).toMatchObject({ component: 'worker', instance: 'worker-abc', exportFailures: { traces: none, logs: none } });
    expect(typeof b.startedAt).toBe('string');
    await svc.stop();
    expect(store.size).toBe(0);
    await metrics.close();
  });

  it('status(): headers masked, Grafana linked, runners from their heartbeat metadata', async () => {
    const env = { MATELOT_COMPONENT: 'api', HOSTNAME: 'a1', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic s3cret', MATELOT_GRAFANA_URL: 'https://grafana.example.com' } as NodeJS.ProcessEnv;
    const rows = [
      { status: 'online', metadata: { metricsScrapedAt: ago(20), tracing: true }, lastHeartbeatAt: NOW },
      { status: 'busy', metadata: { metricsScrapedAt: ago(5), tracing: false }, lastHeartbeatAt: NOW },
      { status: 'online', metadata: {}, lastHeartbeatAt: NOW },
    ];
    const { svc, metrics } = service(new Map(), env, rows);
    await metrics.render();
    const s = await svc.status(NOW);
    expect(s.tracing.headers).toEqual(['Authorization=••••']);
    expect(JSON.stringify(s)).not.toContain('s3cret');
    expect(s.grafana).toEqual({ url: 'https://grafana.example.com' });
    expect(s.metrics.lastScrapeAt).toBe(metrics.lastScrapeAt!.toISOString());
    expect(s.components.runners).toEqual({ online: 3, reporting: 2, metricsScrapedAt: ago(5), tracing: 1 });
    await metrics.close();
  });

  it('testOtlp(): says plainly when nothing is configured', async () => {
    const { svc, metrics } = service(new Map(), { MATELOT_COMPONENT: 'api' } as NodeJS.ProcessEnv);
    const r = await svc.testOtlp();
    expect(r.traces).toEqual({ attempted: false, ok: false, error: 'tracing is off (no OTLP endpoint configured)' });
    expect(r.logs).toEqual({ attempted: false, ok: false, error: 'OTLP logs are off (OTEL_LOGS_EXPORTER unset)' });
    await metrics.close();
  });
});
