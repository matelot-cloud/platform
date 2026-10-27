/**
 * The exposition format is pinned: Grafana dashboards and alert rules (deploy/observability) depend on these names.
 */
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ALLOWED_LABELS, BUCKETS, KNOWN_LABEL_SETS, Metrics } from './metrics';
import { labels, prometheusName, wantsOpenMetrics } from './exposition';

const ENV = { APP_VERSION: '0.1.0-rc.15', APP_COMMIT: 'abc1234', MATELOT_COMPONENT: 'api', BOOTSTRAP_ORG_SLUG: 'globex', OTEL_METRICS_EXPORTER: 'prometheus' } as NodeJS.ProcessEnv;
const TRACE = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';
const SPAN = '0102030405060708';
const PROMETHEUS_ACCEPT = 'application/openmetrics-text;version=1.0.0,application/openmetrics-text;version=0.0.1;q=0.75,text/plain;version=0.0.4;q=0.5,*/*;q=0.1';

function lines(body: string): string[] { return body.split('\n').filter(Boolean); }
function sample(body: string, prefix: string): string | undefined { return lines(body).find((l) => l.startsWith(prefix)); }

describe('metrics exposition', () => {
  let m: Metrics;
  beforeAll(() => { context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()); });
  beforeEach(() => { m = new Metrics({ env: ENV }); });
  afterEach(async () => { await m.close(); });

  it('names: dots → underscores, unit suffix, _total on counters, no suffix on gauges', () => {
    expect(prometheusName('http.server.request.duration', 's')).toBe('http_server_request_duration_seconds');
    expect(prometheusName('matelot.pipeline.jobs', undefined, true)).toBe('matelot_pipeline_jobs_total');
    expect(prometheusName('matelot.runner.last_seen.timestamp', 's')).toBe('matelot_runner_last_seen_timestamp_seconds');
    expect(prometheusName('matelot.build.info', undefined)).toBe('matelot_build_info');
    expect(prometheusName('matelot.queue.jobs', '1')).toBe('matelot_queue_jobs');
    expect(labels({ kind: 'sbom', status: 'succeeded' })).toBe('{kind="sbom",status="succeeded"}');
    expect(labels({ http_route: '/api/v1/projects/:projectId' }, { le: '0.5' })).toBe('{http_route="/api/v1/projects/:projectId",le="0.5"}');
    expect(labels({ q: 'a"b\\c\nd' })).toBe('{q="a\\"b\\\\c\\nd"}');
    expect(wantsOpenMetrics(PROMETHEUS_ACCEPT)).toBe(true);
    expect(wantsOpenMetrics('*/*')).toBe(false);
  });

  it('every enumerable series exists at zero before any work (rate() sees the first event; p95 after the first pipeline is a number)', async () => {
    const body = (await m.render(PROMETHEUS_ACCEPT)).body;
    const L = lines(body);
    for (const kind of KNOWN_LABEL_SETS.jobKinds) {
      for (const status of KNOWN_LABEL_SETS.jobTerminalStatuses) expect(L).toContain(`matelot_pipeline_jobs_total{kind="${kind}",status="${status}"} 0`);
      expect(L).toContain(`matelot_pipeline_job_duration_seconds_bucket{kind="${kind}",le="1"} 0`);
      expect(L).toContain(`matelot_pipeline_job_duration_seconds_bucket{kind="${kind}",le="+Inf"} 0`);
      expect(L).toContain(`matelot_pipeline_job_duration_seconds_count{kind="${kind}"} 0`);
      expect(L).toContain(`matelot_pipeline_job_queue_wait_seconds_sum{kind="${kind}"} 0`);
    }
    expect(L.filter((l) => l.startsWith('matelot_pipeline_jobs_total{'))).toHaveLength(KNOWN_LABEL_SETS.jobKinds.length * KNOWN_LABEL_SETS.jobTerminalStatuses.length);
    expect(L).not.toContain(expect.stringMatching(/^matelot_pipeline_jobs_total\{kind="[a-z_]+",status="(queued|running|assigned|pending)"\}/));
    expect(L).toContain('matelot_pipelines_total{status="failed",trigger="push"} 0');
    expect(L).toContain('matelot_pipeline_duration_seconds_bucket{le="1800",status="succeeded"} 0');
    expect(L).toContain('matelot_runner_claims_total{result="disconnected"} 0');
    expect(L).toContain('matelot_gate_evaluations_total{result="fail"} 0');
    expect(L).toContain('matelot_queue_jobs_processed_total{queue="github-webhooks",result="failed"} 0');
    expect(L).toContain('matelot_sbom_correlation_duration_seconds_count{source="loop"} 0');
    expect(L).toContain('matelot_integration_sync_failures_total{kind="source"} 0');
    expect(L).toContain('matelot_webhook_lag_seconds_count{provider="github"} 0');
    expect(L.filter((l) => l.startsWith('# TYPE matelot_pipeline_job_duration_seconds '))).toHaveLength(1);
    expect(body).not.toContain('http_server_request_duration_seconds_bucket');   // route templates are not enumerable: lazy, documented
    // observed series replace their zero; the untouched ones stay at zero in the same family, once
    m.pipelineJobDuration.record(3, { kind: 'sbom' });
    m.counterAdd(m.pipelineJobs, 1, { kind: 'sbom', status: 'succeeded' });
    const after = lines((await m.render(PROMETHEUS_ACCEPT)).body);
    expect(after).toContain('matelot_pipeline_job_duration_seconds_bucket{kind="sbom",le="5"} 1');
    expect(after).toContain('matelot_pipeline_job_duration_seconds_count{kind="sbom"} 1');
    expect(after).toContain('matelot_pipeline_job_duration_seconds_count{kind="sast"} 0');
    expect(after.filter((l) => l.startsWith('matelot_pipeline_job_duration_seconds_count{kind="sbom"}'))).toHaveLength(1);
    expect(after).toContain('matelot_pipeline_jobs_total{kind="sbom",status="succeeded"} 1');
    expect(after).toContain('matelot_pipeline_jobs_total{kind="sbom",status="failed"} 0');
    expect(after.filter((l) => l.startsWith('# TYPE matelot_pipeline_job_duration_seconds '))).toHaveLength(1);
    expect(after[after.length - 1]).toBe('# EOF');
  });

  it('build_info is 1 with the version labels; counters carry _total; gauges replace their series', async () => {
    m.counterAdd(m.pipelineJobs, 1, { kind: 'sbom', status: 'succeeded' });
    m.counterAdd(m.pipelineJobs, 2, { kind: 'sast', status: 'failed' });
    m.runnersOnline.replace([{ value: 2, attributes: { pool: 'default', managed: 'false' } }, { value: 1, attributes: { pool: 'managed', managed: 'true' } }]);
    m.runnerLastSeen.set(1760000000, { pool: 'default' });
    const { body, contentType } = await m.render('text/plain');
    expect(contentType).toContain('text/plain');
    expect(sample(body, 'matelot_build_info')).toBe('matelot_build_info{commit="abc1234",component="api",node_version="' + process.version + '",version="0.1.0-rc.15"} 1');
    expect(lines(body)).toContain('# TYPE matelot_pipeline_jobs_total counter');
    expect(lines(body)).toContain('matelot_pipeline_jobs_total{kind="sbom",status="succeeded"} 1');
    expect(lines(body)).toContain('matelot_pipeline_jobs_total{kind="sast",status="failed"} 2');
    expect(lines(body)).toContain('matelot_runners_online{managed="false",pool="default"} 2');
    expect(lines(body)).toContain('matelot_runner_last_seen_timestamp_seconds{pool="default"} 1760000000');
    expect(body).not.toContain('# EOF');
    // the worker's next refresh drops the managed pool: its series disappears instead of lingering at the old value
    m.runnersOnline.replace([{ value: 3, attributes: { pool: 'default', managed: 'false' } }]);
    const again = (await m.render('text/plain')).body;
    expect(lines(again)).toContain('matelot_runners_online{managed="false",pool="default"} 3');
    expect(again).not.toContain('pool="managed"');
  });

  it('histograms use the explicit buckets and carry exemplars for OpenMetrics scrapers only', async () => {
    const span = trace.wrapSpanContext({ traceId: TRACE, spanId: SPAN, traceFlags: 1, isRemote: false });
    context.with(trace.setSpan(context.active(), span), () => {
      m.httpRequestDuration.record(0.3, { http_request_method: 'GET', http_route: '/api/v1/projects/:projectId', http_response_status_code: '200' });
      m.pipelineJobDuration.record(42, { kind: 'sbom' });
    });
    m.httpRequestDuration.record(0.02, { http_request_method: 'GET', http_route: '/api/v1/projects/:projectId', http_response_status_code: '200' }); // no active span: no exemplar
    const open = (await m.render(PROMETHEUS_ACCEPT));
    expect(open.contentType).toContain('application/openmetrics-text');
    const o = lines(open.body);
    expect(o).toContain('# TYPE http_server_request_duration_seconds histogram');
    // every configured bucket, cumulative, then +Inf, sum and count
    for (const b of BUCKETS.http) expect(o.some((l) => l.startsWith(`http_server_request_duration_seconds_bucket{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId",le="${b}"}`))).toBe(true);
    expect(sample(open.body, 'http_server_request_duration_seconds_bucket{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId",le="0.25"}')).toMatch(/ 1$/);
    expect(sample(open.body, 'http_server_request_duration_seconds_bucket{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId",le="0.5"}')).toMatch(new RegExp(`^.* 2 # \\{trace_id="${TRACE}",span_id="${SPAN}"\\} 0.3 \\d+\\.\\d{3}$`));
    expect(sample(open.body, 'http_server_request_duration_seconds_bucket{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId",le="+Inf"}')).toMatch(/ 2$/);
    expect(o).toContain('http_server_request_duration_seconds_sum{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId"} 0.32');
    expect(o).toContain('http_server_request_duration_seconds_count{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId"} 2');
    expect(sample(open.body, 'matelot_pipeline_job_duration_seconds_bucket{kind="sbom",le="60"}')).toMatch(new RegExp(`# \\{trace_id="${TRACE}",span_id="${SPAN}"\\} 42 `));
    for (const b of BUCKETS.pipelineJob) expect(o.some((l) => l.startsWith(`matelot_pipeline_job_duration_seconds_bucket{kind="sbom",le="${b}"}`))).toBe(true);
    expect(o[o.length - 1]).toBe('# EOF');
    // the plain format: same series, no exemplars
    const plain = (await m.render('text/plain')).body;
    expect(plain).not.toContain('trace_id=');
    expect(plain).toContain('http_server_request_duration_seconds_count{http_request_method="GET",http_response_status_code="200",http_route="/api/v1/projects/:projectId"} 2');
  });

  it('refuses labels outside the allowed set (ids, names, paths never become series)', () => {
    expect(() => m.pipelineJobDuration.record(1, { kind: 'sbom', project_id: 'abc' } as never)).toThrow(/not in the allowed set/);
    expect(() => m.findingsOpen.set(1, { severity: 'high', repository: 'acme/shop' } as never)).toThrow(/not in the allowed set/);
    expect(() => m.counterAdd(m.pipelines, 1, { status: 'succeeded', user: 'x' })).toThrow(/not in the allowed set/);
  });

  it('every label on the page is in the allowed set', async () => {
    m.counterAdd(m.runnerClaims, 1, { result: 'job' });
    m.findingsOpen.replace([{ value: 4, attributes: { severity: 'critical', kind: 'dependency' } }]);
    m.pipelineJobsQueued.set(2, { kind: 'sbom', pool: 'default' });
    const { body } = await m.render(PROMETHEUS_ACCEPT);
    const keys = new Set<string>();
    for (const l of lines(body)) for (const mm of l.matchAll(/[{,]([a-z_]+)="/g)) keys.add(mm[1]);
    for (const k of keys) expect(k === 'le' || k === 'trace_id' || k === 'span_id' || ALLOWED_LABELS.has(k)).toBe(true);
  });
});
