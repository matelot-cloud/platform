// the shape of @opentelemetry/otlp-exporter-base's OTLPExporterError (0.223: message = statusMessage, code = HTTP status)
class OTLPExporterError extends Error {
  override name = 'OTLPExporterError';
  code: number | undefined;
  data: string | undefined;
  constructor(message: string, code?: number, data?: string) { super(message); this.code = code; this.data = data; }
}
import { SignalFailures, describeExportError, otlpEndpoint, watchExporter } from './export-failures';

describe('export failures: per signal, one line', () => {
  const http = { url: 'http://tempo.monitoring:4318/v1/logs', protocol: 'http/protobuf' };

  it('an HTTP failure: name, message, status, where — never the stack (kind rc.23)', () => {
    const e = new OTLPExporterError('Not Found', 404, '404 page not found');
    expect(describeExportError(e, http)).toBe('OTLPExporterError: Not Found (HTTP 404) — POST http://tempo.monitoring:4318/v1/logs');
    expect(describeExportError(e, http)).not.toContain('\n');
    expect(describeExportError(e, http)).not.toContain(' at ');
  });

  it('a network error keeps its code; a gRPC status is named; a multi-line message keeps its first line', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:4318'), { code: 'ECONNREFUSED' });
    expect(describeExportError(refused, { url: 'http://otel:4318/v1/traces', protocol: 'http/protobuf' })).toBe('Error: connect ECONNREFUSED 10.0.0.9:4318 — POST http://otel:4318/v1/traces');
    const dns = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' });
    expect(describeExportError(dns, { url: null, protocol: 'http/protobuf' })).toBe('Error: getaddrinfo failed (ENOTFOUND)');
    expect(describeExportError(Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 }), { url: 'otel:4317', protocol: 'grpc' })).toBe('Error: 14 UNAVAILABLE: No connection established (gRPC UNAVAILABLE) — gRPC otel:4317');
    expect(describeExportError(new Error('first\n    at x (y.js:1:1)'), http)).toBe('Error: first — POST http://tempo.monitoring:4318/v1/logs');
    expect(describeExportError(undefined, http)).toBe('Error: export failed — POST http://tempo.monitoring:4318/v1/logs');
  });

  it('watchExporter counts only failed exports, for its own signal, and still reports the result', () => {
    const traces = new SignalFailures();
    const logs = new SignalFailures();
    let next = { code: 0 } as { code: number; error?: Error };
    const fake = () => ({ export(_items: unknown[], done: (r: { code: number; error?: Error }) => void) { done(next); } });
    const t = watchExporter(fake(), 'traces', { url: 'http://otel:4318/v1/traces', protocol: 'http/protobuf' }, traces);
    const l = watchExporter(fake(), 'logs', http, logs);
    const results: number[] = [];
    t.export([1], (r) => results.push(r.code));
    next = { code: 1, error: new OTLPExporterError('Not Found', 404) };
    l.export([1], (r) => results.push(r.code));
    l.export([1], (r) => results.push(r.code));
    expect(results).toEqual([0, 1, 1]);
    expect(traces.snapshot()).toEqual({ count: 0, last: null, lastAt: null });
    expect(logs.count).toBe(2);
    expect(logs.last).toBe('OTLPExporterError: Not Found (HTTP 404) — POST http://tempo.monitoring:4318/v1/logs');
  });

  it('otlpEndpoint: the signal-specific variable wins, else the shared endpoint plus the http path', () => {
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/' }, 'traces')).toBe('http://otel-collector:4318/v1/traces');
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'otel-collector:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, 'logs')).toBe('otel-collector:4317');
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://a:4318', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://b:4318/v1/logs' }, 'logs')).toBe('http://b:4318/v1/logs');
    expect(otlpEndpoint({}, 'traces')).toBeNull();
  });
});

// the real OTLP exporter against a 404 endpoint: test/export-failures.mjs (the exporter's dynamic import('http') does not run under jest)
