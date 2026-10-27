/**
 * One trace per pipeline, end to end: the ids are fixed at creation and stored on the rows, the claim hands the
 * runner its job's traceparent, the job span is emitted at completion with those ids under the pipeline's root, and
 * the pipeline's root span is emitted at its terminal status — from a stateless API (nothing held between requests).
 */
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { JobsService } from '../execution/jobs.service';
import { PipelinesService } from '../execution/pipelines.service';
import { PinnedIdGenerator, parseTraceparent } from './ids';
import { Metrics, setMetricsForTests } from './metrics';
import { PipelineTelemetry } from './pipeline-telemetry';
import { currentTraceparent } from './spans';
import { QueueService } from '../jobs/queue.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('pipeline trace: ids fixed at creation, spans emitted at completion', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const audit = { record: async () => undefined };
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ idGenerator: new PinnedIdGenerator(), spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const metrics = new Metrics({ env: { APP_VERSION: 'test', MATELOT_COMPONENT: 'api' } as NodeJS.ProcessEnv });
  const telemetry = new PipelineTelemetry(metrics);
  const pipelines = Object.create(PipelinesService.prototype) as PipelinesService;
  Object.assign(pipelines, { db, audit, telemetry });
  const jobsService = Object.create(JobsService.prototype) as JobsService;
  Object.assign(jobsService, { db, audit, pipelines, telemetry, metrics, logger: { log: () => undefined, warn: () => undefined } });

  beforeAll(() => { context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()); trace.setGlobalTracerProvider(provider); setMetricsForTests(metrics); });
  afterAll(async () => { for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); await provider.shutdown(); await metrics.close(); trace.disable(); setMetricsForTests(null); });

  async function seed() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `tr-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [service] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [integration] = await db.insert(schema.integrations).values({ organizationId: org!.id, scopeType: 'ORGANIZATION', scopeId: org!.id, provider: 'git', authType: 'none', name: 'git', status: 'connected', externalAccountId: `g-${s}`, settings: {} }).returning();
    const [repo] = await db.insert(schema.repositories).values({ integrationId: integration!.id, externalId: 'r', fullName: 'acme/demo', defaultBranch: 'main' } as typeof schema.repositories.$inferInsert).returning();
    await db.insert(schema.serviceRepositories).values({ serviceId: service!.id, repositoryId: repo!.id } as typeof schema.serviceRepositories.$inferInsert);
    const [rp] = await db.insert(schema.runnerPools).values({ organizationId: org!.id, scopeType: 'ORGANIZATION', scopeId: org!.id, slug: 'default', name: 'default', tags: [] } as typeof schema.runnerPools.$inferInsert).returning();
    const [runner] = await db.insert(schema.runners).values({ poolId: rp!.id, name: 'r1', status: 'online', tags: ['linux'], tokenHash: `h-${s}`, lastHeartbeatAt: new Date() } as typeof schema.runners.$inferInsert).returning();
    const chain = { organizationId: org!.id, organizationAncestorIds: [], workspaceId: ws!.id, teamId: team!.id, projectId: proj!.id, serviceId: service!.id, refs: [{ type: 'ORGANIZATION', id: org!.id }, { type: 'WORKSPACE', id: ws!.id }, { type: 'TEAM', id: team!.id }, { type: 'PROJECT', id: proj!.id }, { type: 'SERVICE', id: service!.id }], target: { type: 'SERVICE', id: service!.id } } as never;
    const principal = { runner: runner!, pool: { ...rp!, managed: false, scopeType: 'ORGANIZATION', scopeId: org!.id } } as never;
    return { org: org!, chain, principal };
  }

  it('a two-stage pipeline: one trace, the runner parents under the claim\'s traceparent, spans arrive at completion', async () => {
    const { chain, principal } = await seed();
    exporter.reset();
    const created = await pipelines.create(null, chain, { stages: [{ name: 'source', jobs: [{ name: 'checkout', type: 'repository_check' }] }, { name: 'scan', jobs: [{ name: 'sbom', type: 'sbom' }] }] }) as { id: string };
    const [p] = await db.select().from(schema.pipelines).where(eq(schema.pipelines.id, created.id));
    const root = parseTraceparent(p!.traceParent)!;
    expect(root).toBeTruthy();
    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.pipelineId, created.id));
    expect(rows).toHaveLength(2);
    for (const j of rows) {
      const ids = parseTraceparent(j.traceParent)!;
      expect(ids.traceId).toBe(root.traceId);          // every job in the pipeline's trace
      expect(ids.spanId).not.toBe(root.spanId);        // with its own span id
    }
    expect(new Set(rows.map((j) => j.traceParent)).size).toBe(2);
    // the first stage is claimable at creation (same clock as created_at); the second only when its stage opens
    expect(rows.find((j) => j.type === 'repository_check')!.queuedAt?.getTime()).toBe(rows.find((j) => j.type === 'repository_check')!.createdAt.getTime());
    expect(rows.find((j) => j.type === 'sbom')!.queuedAt).toBeNull();
    expect(exporter.getFinishedSpans()).toHaveLength(0);   // nothing emitted yet: nothing has ended

    // the runner claims the checkout job: the claim response carries the job's traceparent
    const claimed = await jobsService.claim(principal);
    expect(claimed?.type).toBe('repository_check');
    expect(claimed?.traceParent).toBe(rows.find((j) => j.type === 'repository_check')!.traceParent);
    await jobsService.start(principal, claimed!.id);
    await new Promise((r) => setTimeout(r, 20));
    await jobsService.complete(principal, claimed!.id, { status: 'succeeded', result: { commit: 'abc' }, exitCode: 0 } as never);

    const spans1 = exporter.getFinishedSpans();
    expect(spans1.map((s) => s.name)).toEqual(['job repository_check']);
    const jobSpan = spans1[0];
    const jobIds = parseTraceparent(claimed!.traceParent)!;
    expect(jobSpan.spanContext().traceId).toBe(root.traceId);
    expect(jobSpan.spanContext().spanId).toBe(jobIds.spanId);           // the pinned id the runner parented under
    expect(jobSpan.parentSpanContext?.spanId).toBe(root.spanId);         // under the pipeline's root
    expect(jobSpan.attributes['matelot.job.kind']).toBe('repository_check');
    expect(jobSpan.attributes['matelot.job.status']).toBe('succeeded');
    expect(jobSpan.attributes['matelot.runner.name']).toBe('r1');
    expect(jobSpan.events.map((e) => e.name)).toEqual(['claimed', 'started']);
    const startMs = jobSpan.startTime[0] * 1000 + jobSpan.startTime[1] / 1e6;
    expect(Math.abs(startMs - claimed!.createdAt.getTime())).toBeLessThan(2);   // starts when the job was created (queue wait included)
    expect(jobSpan.status.code).toBe(1);

    // the second stage; the last job finishes the pipeline: its root span is emitted with the stored ids
    const second = await jobsService.claim(principal);
    expect(second?.type).toBe('sbom');
    await jobsService.start(principal, second!.id);
    await jobsService.complete(principal, second!.id, { status: 'failed', error: 'syft exited with 2', exitCode: 2 } as never);
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toEqual(['job repository_check', 'job sbom', 'pipeline Custom pipeline']);
    const sbomSpan = exporter.getFinishedSpans()[1];
    const [sbomRow] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, second!.id));
    expect(sbomRow!.queuedAt!.getTime()).toBeGreaterThan(sbomRow!.createdAt.getTime());   // queued when the first stage finished
    expect(sbomSpan.events.map((e) => e.name)).toEqual(['queued', 'claimed', 'started']);  // the span starts at creation, the queued event marks the stage opening
    expect(sbomSpan.status.code).toBe(2);
    expect(sbomSpan.status.message).toBe('syft exited with 2');
    expect(sbomSpan.attributes['matelot.job.exit_code']).toBe(2);
    const rootSpan = exporter.getFinishedSpans()[2];
    expect(rootSpan.spanContext().traceId).toBe(root.traceId);
    expect(rootSpan.spanContext().spanId).toBe(root.spanId);
    expect(rootSpan.parentSpanContext).toBeUndefined();
    expect(rootSpan.attributes['matelot.pipeline.status']).toBe('failed');
    expect(rootSpan.status.code).toBe(2);

    // metrics recorded at the same points, exemplars pointing at the pipeline's trace
    const page = (await metrics.render('application/openmetrics-text;version=1.0.0')).body;
    expect(page).toContain('matelot_pipeline_jobs_total{kind="repository_check",status="succeeded"} 1');
    expect(page).toContain('matelot_pipeline_jobs_total{kind="sbom",status="failed"} 1');
    expect(page).toContain('matelot_pipelines_total{status="failed",trigger="manual"} 1');
    expect(page).toMatch(new RegExp(`matelot_pipeline_job_duration_seconds_bucket\\{kind="sbom",le="1"\\} 1 # \\{trace_id="${root.traceId}",span_id="${parseTraceparent(second!.traceParent)!.spanId}"\\}`));
    expect(page).toContain('matelot_runner_claims_total{result="job"} 2');
  });

  it('a retried job gets a new span id in the same trace', async () => {
    const { chain, principal } = await seed();
    const created = await pipelines.create(null, chain, { stages: [{ name: 'source', jobs: [{ name: 'checkout', type: 'repository_check' }] }] }) as { id: string };
    const claimed = await jobsService.claim(principal);
    await jobsService.start(principal, claimed!.id);
    await jobsService.complete(principal, claimed!.id, { status: 'failed', error: 'x', exitCode: 1 } as never);
    const before = parseTraceparent(claimed!.traceParent)!;
    await pipelines.retryJob({ id: randomUUID(), email: 'a@b.c' } as never, (await db.select().from(schema.jobs).where(eq(schema.jobs.id, claimed!.id)))[0]!);
    const after = parseTraceparent((await db.select().from(schema.jobs).where(eq(schema.jobs.id, claimed!.id)))[0]!.traceParent)!;
    expect(after.traceId).toBe(before.traceId);
    expect(after.spanId).not.toBe(before.spanId);
    void created;
  });

  it('API → worker: the queue job data carries the active traceparent', async () => {
    const added: { data: Record<string, unknown> }[] = [];
    const queue = Object.create(QueueService.prototype) as QueueService;
    Object.assign(queue, { queues: new Map([['github-sync', { add: async (_n: string, data: Record<string, unknown>) => { added.push({ data }); } }]]) });
    await queue.enqueue('github-sync', { integrationId: 'i1' });
    expect(added[0].data).toEqual({ integrationId: 'i1' });     // no active span: nothing added
    const span = provider.getTracer('t').startSpan('request');
    await context.with(trace.setSpan(context.active(), span), async () => {
      expect(currentTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      await queue.enqueue('github-sync', { integrationId: 'i2' });
    });
    span.end();
    expect(added[1].data.__traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });
});
