import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JOB_BUCKETS, JsonLogger, Metrics, parseTraceparent, phase, redact, setTracer, Tracer, tracerFromEnv, traceparentOf } from './telemetry';

const RESOURCE = { 'service.name': 'matelot-runner', 'service.version': '0.3.3', 'matelot.runner.name': 'r1' };

test('traceparent: parse and build', () => {
  const p = parseTraceparent('00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-0102030405060708-01');
  assert.deepEqual(p, { traceId: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', spanId: '0102030405060708', sampled: true });
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-0102030405060708-01'), null);
  assert.equal(parseTraceparent('garbage'), null);
  assert.equal(parseTraceparent(undefined), null);
  assert.equal(traceparentOf(p!.traceId, p!.spanId), '00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-0102030405060708-01');
});

test('spans: a job span under the cell-fixed parent, phases as children, OTLP/JSON encoding, one batch to the collector', async () => {
  const posts: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => { posts.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
  const tracer = new Tracer({ endpoint: 'http://collector:4318', headers: { Authorization: 'Basic abc' }, resource: RESOURCE, fetchImpl, batchMs: 5 });
  setTracer(tracer);
  const job = tracer.start('job run sbom', '00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-0102030405060708-01', { 'matelot.job.kind': 'sbom', 'matelot.job.attempt': 1 });
  assert.equal(job.traceId, 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
  assert.equal(job.parentSpanId, '0102030405060708');
  let inner: string | undefined;
  await tracer.run(job, async () => {
    assert.equal(tracer.currentTraceparent(), job.traceparent);     // what client.ts sends as the traceparent header
    await phase('checkout', async () => { inner = tracer.currentTraceparent(); }, { 'matelot.tool': 'git' });
    await assert.rejects(phase('tool syft', async () => { throw new Error('syft exited with 2'); }), /syft exited/);
  });
  assert.ok(inner && inner !== job.traceparent && inner.startsWith('00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-'));
  await tracer.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'http://collector:4318/v1/traces');
  assert.equal(posts[0].headers.Authorization, 'Basic abc');
  const spans = posts[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.deepEqual(spans.map((s: any) => s.name), ['checkout', 'tool syft', 'job run sbom']);   // children end first
  const resourceAttrs = Object.fromEntries(posts[0].body.resourceSpans[0].resource.attributes.map((a: any) => [a.key, a.value.stringValue]));
  assert.equal(resourceAttrs['service.name'], 'matelot-runner');
  const jobSpan = spans[2];
  assert.equal(jobSpan.traceId, 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
  assert.equal(jobSpan.parentSpanId, '0102030405060708');
  assert.equal(jobSpan.status.code, 1);
  assert.deepEqual(jobSpan.attributes.find((a: any) => a.key === 'matelot.job.attempt').value, { intValue: '1' });
  assert.equal(spans[1].status.code, 2);
  assert.equal(spans[1].status.message, 'syft exited with 2');
  assert.equal(spans[0].parentSpanId, jobSpan.spanId);
  assert.match(jobSpan.startTimeUnixNano, /^\d{13}000000$/);
  assert.equal(tracer.exported, 3);
  setTracer(null);
});

test('spans: an unreachable collector costs dropped spans and ONE warning; the queue is bounded; shutdown is capped', async () => {
  const warnings: string[] = [];
  let calls = 0;
  const fetchImpl = (async () => { calls++; await new Promise((r) => setTimeout(r, 20)); throw new Error('connect ECONNREFUSED 10.0.0.1:4318'); }) as unknown as typeof fetch;
  const tracer = new Tracer({ endpoint: 'http://collector:4318', resource: RESOURCE, fetchImpl, batchMs: 5, maxQueue: 3, warn: (m) => warnings.push(m) });
  for (let i = 0; i < 6; i++) tracer.start(`s${i}`).end();
  assert.equal(tracer.dropped, 3);                 // 3 over the cap, dropped at enqueue
  const started = Date.now();
  await tracer.shutdown(100);
  assert.ok(Date.now() - started < 1000);
  assert.equal(warnings.filter((w) => w.includes('export to')).length, 1);
  assert.ok(warnings[0].includes('further occurrences are not logged'));
  assert.ok(calls >= 1);
});

test('tracerFromEnv: off without an endpoint or with MATELOT_TRACING_ENABLED=false; grpc warned', () => {
  const warnings: string[] = [];
  assert.equal(tracerFromEnv({}, RESOURCE).enabled, false);
  assert.equal(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', MATELOT_TRACING_ENABLED: 'false' }, RESOURCE).enabled, false);
  assert.equal(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }, RESOURCE).enabled, true);
  tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, RESOURCE, (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  const off = tracerFromEnv({}, RESOURCE);
  const s = off.start('x'); s.end();   // nothing queued, nothing thrown
  assert.equal(off.exported, 0);
});

test('metrics page: build_info, counters, gauge, the job histogram with the pipeline buckets and an exemplar for OpenMetrics', async () => {
  const m = new Metrics({ version: '0.3.3', commit: 'abc', node_version: process.version, component: 'runner' });
  m.inc('matelot_runner_jobs_total', { kind: 'sbom', status: 'succeeded' });
  m.inc('matelot_runner_jobs_total', { kind: 'sbom', status: 'succeeded' });
  m.set('matelot_runner_busy', {}, 1);
  m.observe('matelot_runner_job_duration_seconds', { kind: 'sbom', phase: 'total' }, 42, { traceId: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', spanId: '0102030405060708' });
  const open = m.page(true).split('\n');
  assert.ok(open.includes(`matelot_build_info{commit="abc",component="runner",node_version="${process.version}",version="0.3.3"} 1`));
  assert.ok(open.includes('matelot_runner_jobs_total{kind="sbom",status="succeeded"} 2'));
  assert.ok(open.includes('matelot_runner_busy 1'));
  for (const b of JOB_BUCKETS) assert.ok(open.some((l) => l.startsWith(`matelot_runner_job_duration_seconds_bucket{kind="sbom",le="${b}",phase="total"}`)), `bucket ${b}`);
  const sixty = open.find((l) => l.startsWith('matelot_runner_job_duration_seconds_bucket{kind="sbom",le="60",phase="total"}'))!;
  assert.match(sixty, /^.* 1 # \{trace_id="a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",span_id="0102030405060708"\} 42 \d+\.\d{3}$/);
  assert.ok(open.includes('matelot_runner_job_duration_seconds_sum{kind="sbom",phase="total"} 42'));
  assert.equal(open[open.length - 2], '# EOF');
  const plain = m.page(false);
  assert.ok(!plain.includes('trace_id='));
  assert.ok(!plain.includes('# EOF'));
  // the listener serves both formats by Accept
  const port = await m.listen(0, '127.0.0.1');
  const om = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { accept: 'application/openmetrics-text;version=1.0.0' } });
  assert.ok(om.headers.get('content-type')!.includes('openmetrics'));
  assert.ok((await om.text()).includes('# EOF'));
  const txt = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.ok(txt.headers.get('content-type')!.startsWith('text/plain'));
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
  await m.close();
});

test('log line: schema fields, trace ids from the current span, secrets redacted', async () => {
  const lines: any[] = [];
  const tracer = new Tracer({ resource: RESOURCE });
  const log = new JsonLogger({ component: 'runner', runner: 'r1', cell: 'globex' }, tracer, 'info', (l) => lines.push(JSON.parse(l)));
  log.debug('hidden');
  log.info('plain', { registrationToken: 'tok', nested: { password: 'pw', keep: 1 } });
  await tracer.run(tracer.start('job run sbom', '00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-0102030405060708-01'), async () => log.warn('inside'));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].component, 'runner');
  assert.equal(lines[0].cell, 'globex');
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].msg, 'plain');
  assert.equal(lines[0].registrationToken, '[Redacted]');
  assert.deepEqual(lines[0].nested, { password: '[Redacted]', keep: 1 });
  assert.match(lines[0].time, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(lines[1].trace_id, 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
  assert.match(lines[1].span_id, /^[0-9a-f]{16}$/);
  assert.deepEqual(redact({ Authorization: 'x', list: [{ secret: 'y' }] }), { Authorization: '[Redacted]', list: [{ secret: '[Redacted]' }] });
});

test('client: the traceparent header is the active span, log batches go unsampled (no server span at the cell)', async () => {
  const { CellClient } = await import('./client');
  const seen: { path: string; traceparent?: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => { seen.push({ path: new URL(url).pathname, traceparent: init.headers.traceparent }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch;
  try {
    const tracer = new Tracer({ resource: RESOURCE });
    setTracer(tracer);
    const client = new CellClient('http://cell/api/v1', 'tok');
    await client.start('j1');                                           // outside a span: no header
    await tracer.run(tracer.start('job run sbom', '00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-0102030405060708-01'), async () => {
      await client.start('j1');
      await client.logs('j1', [{ seq: 0, stream: 'stdout', content: 'x' }]);
      await client.complete('j1', 'succeeded', {}, undefined, 0);
    });
  } finally { globalThis.fetch = realFetch; setTracer(null); }
  assert.equal(seen[0].traceparent, undefined);
  assert.match(seen[1].traceparent!, /^00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-[0-9a-f]{16}-01$/);
  assert.match(seen[2].traceparent!, /^00-a0a1a2a3a4a5a6a7a8a9aaabacadaeaf-[0-9a-f]{16}-00$/);   // /logs: same trace, not sampled
  assert.equal(seen[2].path, '/api/v1/runner/jobs/j1/logs');
  assert.match(seen[3].traceparent!, /-01$/);
});
