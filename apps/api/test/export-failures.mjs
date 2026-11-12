#!/usr/bin/env node
/**
 * The real OTLP exporters against endpoints that refuse them (kind rc.23: the cell's OTLP endpoint was Tempo, which
 * answers 404 on /v1/logs — the failure showed up as a *tracing* failure with a serialized stack). Built code
 * (dist/telemetry), no Docker, no network: a local HTTP server answers 404 for /v1/logs and 200 for /v1/traces.
 * Asserts that the logs counter alone counts, with the one-line description, and the traces counter stays at 0.
 *
 *   node apps/api/test/export-failures.mjs      (after `pnpm --filter @secops/api build`; CI job api)
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(API_DIR, 'package.json'));
const { exportFailures, watchExporter } = require('./dist/telemetry/export-failures.js');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { LoggerProvider, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { BasicTracerProvider, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');

const problems = [];
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.url === '/v1/traces') { res.writeHead(200, { 'content-type': 'application/x-protobuf' }); res.end(); }
    else { res.writeHead(404, 'Not Found'); res.end('404 page not found\n'); }   // Tempo's answer on /v1/logs
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const target = (signal) => ({ url: `${base}/v1/${signal}`, protocol: 'http/protobuf' });

const logProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: watchExporter(new OTLPLogExporter({ url: `${base}/v1/logs` }), 'logs', target('logs')) })] });
const traceProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(watchExporter(new OTLPTraceExporter({ url: `${base}/v1/traces` }), 'traces', target('traces')))] });

logProvider.getLogger('matelot.events').emit({ body: 'matelot.test', attributes: { 'event.name': 'matelot.test' } });
traceProvider.getTracer('matelot').startSpan('matelot.test').end();
await Promise.all([logProvider.forceFlush(), traceProvider.forceFlush()]);
for (let i = 0; i < 100 && !exportFailures().logs.count; i++) await new Promise((r) => setTimeout(r, 20));

const { traces, logs } = exportFailures();
const expected = `OTLPExporterError: Not Found (HTTP 404) — POST ${base}/v1/logs`;
if (logs.count !== 1) problems.push(`logs failures: ${logs.count}, expected 1`);
if (logs.last !== expected) problems.push(`logs last error: ${JSON.stringify(logs.last)}, expected ${JSON.stringify(expected)}`);
const notFoundLine = logs.last;
if (traces.count !== 0) problems.push(`traces failures: ${traces.count} (${traces.last}) — the logs exporter's 404 must not count for tracing`);

await Promise.all([logProvider.shutdown(), traceProvider.shutdown()]);
server.close();

// a refused connection is retried for ~15 s: the handle's flush must say it did NOT finish (Test OTLP said "sent"),
// and the failure arrives as one line once the exporter gives up
const refused = createServer();
await new Promise((r) => refused.listen(0, '127.0.0.1', r));
const deadPort = refused.address().port;
await new Promise((r) => refused.close(r));   // nothing listens there now
Object.assign(process.env, { MATELOT_TRACING_NO_AUTOSTART: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${deadPort}` });
const { startLogs } = require('./dist/telemetry/logs.js');
const { getEvents } = require('./dist/telemetry/events.js');
const handle = startLogs(process.env);
const before = exportFailures().logs.count;
getEvents().security('auth.failed', { reason: 'export-failures test', status: 401 });
const finished = await handle.flush(1500);
if (finished) problems.push('flush(1500) said finished while the exporter was still retrying a refused connection');
const t0 = Date.now();
while (exportFailures().logs.count === before && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 250));
const refusedLine = exportFailures().logs.last;
if (exportFailures().logs.count === before) problems.push('a refused connection was never counted as a logs failure (30 s)');
else if (!/^Error: connect ECONNREFUSED 127\.0\.0\.1:\d+ — POST http:\/\/127\.0\.0\.1:\d+\/v1\/logs$/.test(refusedLine)) problems.push(`refused: ${JSON.stringify(refusedLine)}`);
await handle.shutdown(1000);
if (problems.length) { console.error(`export-failures FAILED:\n  ${problems.join('\n  ')}`); process.exit(1); }
console.log(`export-failures ok: a 404 on /v1/logs → logs 1 failure "${notFoundLine}"; traces 0; a refused connection: flush not finished, then "${refusedLine}" after ${Math.round((Date.now() - t0) / 1000)} s`);
