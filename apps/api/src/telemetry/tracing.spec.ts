import { execFileSync } from 'node:child_process';
import { ignoredIncomingPath, OnceLogger, resourceAttributes, tracingEnabled } from './tracing';

describe('tracing preload', () => {
  it('is on only with an endpoint or an explicit switch', () => {
    expect(tracingEnabled({})).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318' })).toBe(true);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://jaeger:4318', MATELOT_TRACING_ENABLED: 'false' })).toBe(false);
    expect(tracingEnabled({ MATELOT_TRACING_ENABLED: 'true' })).toBe(true);
    expect(tracingEnabled({ OTEL_TRACES_EXPORTER: 'console' })).toBe(true);
    expect(tracingEnabled({ OTEL_TRACES_EXPORTER: 'none', MATELOT_TRACING_ENABLED: '' })).toBe(false);
  });

  it('resource: service.name per component, version, environment, cell', () => {
    expect(resourceAttributes({ MATELOT_COMPONENT: 'worker', APP_VERSION: '0.1.0-rc.15', BOOTSTRAP_ORG_SLUG: 'globex', DEPLOYMENT_ENVIRONMENT: 'staging', OTEL_RESOURCE_ATTRIBUTES: 'k8s.namespace.name=tenant-globex,region=eu%2Dwest' }))
      .toEqual({ 'service.name': 'matelot-worker', 'service.version': '0.1.0-rc.15', 'deployment.environment': 'staging', 'matelot.component': 'worker', 'matelot.cell': 'globex', 'k8s.namespace.name': 'tenant-globex', region: 'eu-west' });
  });

  it('never traces probes, scrapes or heartbeats', () => {
    for (const p of ['/api/v1/health/live', '/api/v1/health/ready', '/metrics', '/api/v1/runner/heartbeat', '/api/v1/runner/jobs/abc/heartbeat']) expect(ignoredIncomingPath(p)).toBe(true);
    for (const p of ['/api/v1/runner/jobs/claim', '/api/v1/projects/x', '/api/v1/runner/jobs/abc/complete']) expect(ignoredIncomingPath(p)).toBe(false);
  });

  it('warns once per failure shape and counts the rest', () => {
    const out: string[] = [];
    const once = new OnceLogger((m) => out.push(m));
    once.warn('request to http://collector:4318/v1/traces failed, reason: connect ECONNREFUSED 10.0.0.1:4318');
    once.warn('request to http://collector:4318/v1/traces failed, reason: connect ECONNREFUSED 10.0.0.2:4318');
    once.warn('request to http://collector:4318/v1/traces failed, reason: connect ECONNREFUSED 10.0.0.3:4318');
    expect(out).toHaveLength(1);
    expect(once.dropped).toBe(2);
    expect(out[0]).toContain('further occurrences are not logged');
  });

  it('disabled: the preload loads no OpenTelemetry SDK module; enabled with OTEL_TRACES_EXPORTER=none: registers a provider', () => {
    // a child process, because the preload decides at require time from the environment
    const probe = `
      require(${JSON.stringify(require.resolve('./tracing'))});
      const loaded = Object.keys(require.cache).filter((f) => f.includes('@opentelemetry/sdk-') || f.includes('@opentelemetry/instrumentation'));
      const api = require('@opentelemetry/api');
      const span = api.trace.getTracer('probe').startSpan('probe'); const registered = span.isRecording(); span.end();
      console.log(JSON.stringify({ loaded: loaded.length, registered, handle: !!globalThis.__matelotTracing }));
    `;
    const run = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ['-r', require.resolve('tsx/cjs'), '-e', probe], { env: { ...process.env, ...env, MATELOT_TRACING_ENABLED: env.MATELOT_TRACING_ENABLED ?? '', OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '' }, encoding: 'utf8' }).trim().split('\n').pop()!);
    expect(run({})).toEqual({ loaded: 0, registered: false, handle: false });
    expect(run({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', MATELOT_TRACING_ENABLED: 'false' })).toEqual({ loaded: 0, registered: false, handle: false });
    const on = run({ MATELOT_TRACING_ENABLED: 'true', OTEL_TRACES_EXPORTER: 'none' });
    expect(on.registered).toBe(true);
    expect(on.handle).toBe(true);
    expect(on.loaded).toBeGreaterThan(0);
  });
});
