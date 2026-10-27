import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { userIdOrNull, type AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Job, jobs, Pipeline, pipelines, repositories, runners, serviceRepositories, services } from '../database/schema';
import { ScopeChain } from '../rbac/scope.types';
import { StageDefinition, templateByKey } from './pipeline-templates';
import { PipelineTelemetry, pipelineTelemetry } from '../telemetry/pipeline-telemetry';

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'];

/** Pipelines = stages of jobs. Creates the jobs, advances stages, derives the pipeline status. */
@Injectable()
export class PipelinesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(PipelineTelemetry) telemetry: PipelineTelemetry | undefined,
  ) {
    if (telemetry) this.telemetry = telemetry;
  }
  private telemetry?: PipelineTelemetry;
  /** Injected by Nest; the process-wide instance where a spec built the service by hand. */
  private get tele(): PipelineTelemetry { return (this.telemetry ??= pipelineTelemetry()); }

  async create(user: AuthenticatedUser | null, serviceChain: ScopeChain, input: { template?: string; stages?: StageDefinition[]; repositoryId?: string; ref?: string; requiredTags?: string[]; poolId?: string; trigger?: Pipeline['trigger']; commitSha?: string }) {
    const serviceId = serviceChain.serviceId!;
    const [service] = await this.db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    if (!service) throw new NotFoundException('Service not found');
    const template = input.stages ? { key: 'custom', name: 'Custom pipeline', stages: input.stages } : templateByKey(input.template ?? 'security');
    if (!template) throw new BadRequestException(`Unknown pipeline template ${input.template}`);

    let repositoryId = input.repositoryId ?? null;
    if (!repositoryId) {
      const [link] = await this.db.select({ repositoryId: serviceRepositories.repositoryId }).from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)).orderBy(asc(serviceRepositories.role)).limit(1);
      repositoryId = link?.repositoryId ?? null;
    }
    if (!repositoryId) throw new BadRequestException('Attach a repository to the service first');
    const [repo] = await this.db.select({ defaultBranch: repositories.defaultBranch }).from(repositories).where(eq(repositories.id, repositoryId)).limit(1);

    // The ref every job works on: the one asked for, else the repository's default branch. Jobs used to get a ref only
    // when --ref was passed, so the evaluate job of a plain run had no subject and failed require_sbom (#42, #43).
    const effectiveRef = input.ref ?? repo?.defaultBranch ?? null;
    const [{ next }] = await this.db.select({ next: sql<number>`coalesce(max(${pipelines.number}), 0) + 1` }).from(pipelines).where(eq(pipelines.projectId, serviceChain.projectId!));
    const trace = this.tele.newTrace();   // one trace per pipeline; every job gets its span id now (the runner parents under it)
    const [pipeline] = await this.db
      .insert(pipelines)
      .values({ organizationId: serviceChain.organizationId, projectId: serviceChain.projectId!, serviceId, repositoryId, number: Number(next), name: template.name, ref: effectiveRef, commitSha: input.commitSha ?? null, trigger: input.trigger ?? 'manual', stages: template.stages, createdById: userIdOrNull(user), traceParent: trace.pipeline })
      .returning();

    const rows = template.stages.flatMap((stage, order) =>
      stage.jobs.map((job) => ({
        organizationId: serviceChain.organizationId,
        projectId: serviceChain.projectId!,
        serviceId,
        repositoryId,
        pipelineId: pipeline.id,
        stage: stage.name,
        stageOrder: order,
        name: job.name,
        type: job.type,
        status: (order === 0 ? 'queued' : 'pending') as Job['status'],
        queuedAt: order === 0 ? sql`now()` : null,   // the same clock as created_at: the first stage is queued at creation
        // policy_eval runs inside the platform (worker), so it carries a tag no runner has.
        requiredTags: job.type === 'policy_eval' ? ['__platform__'] : (input.requiredTags ?? []),
        poolId: input.poolId ?? null,
        requestedPoolId: input.poolId ?? null,
        payload: { ...(job.payload ?? {}), ...(effectiveRef ? { ref: effectiveRef } : {}), ...(input.commitSha ? { commitSha: input.commitSha } : {}) },
        createdById: userIdOrNull(user),
        traceParent: trace.job(),
      })),
    );
    await this.db.insert(jobs).values(rows);
    await this.db.update(pipelines).set({ status: 'running', startedAt: new Date() }).where(eq(pipelines.id, pipeline.id));
    await this.audit.record({ organizationId: pipeline.organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'pipeline.created', resourceType: 'pipeline', resourceId: pipeline.id, after: { number: pipeline.number, template: template.key, serviceId, repositoryId, ref: effectiveRef, refSource: input.ref ? 'requested' : effectiveRef ? 'default_branch' : null, trigger: input.trigger ?? 'manual' } });
    return this.get(pipeline.id);
  }

  async get(pipelineId: string) {
    const [pipeline] = await this.db.select().from(pipelines).where(eq(pipelines.id, pipelineId)).limit(1);
    if (!pipeline) throw new NotFoundException('Pipeline not found');
    const rows = await this.db
      .select({ job: jobs, runnerName: runners.name })
      .from(jobs)
      .leftJoin(runners, eq(jobs.runnerId, runners.id))
      .where(eq(jobs.pipelineId, pipelineId))
      .orderBy(asc(jobs.stageOrder), asc(jobs.createdAt));
    return { ...pipeline, jobs: rows.map((r) => ({ ...r.job, runnerName: r.runnerName })) };
  }

  async listForProject(projectId: string, limit = 30) {
    const list = await this.db
      .select({ pipeline: pipelines, serviceName: services.name, repositoryName: repositories.fullName })
      .from(pipelines)
      .leftJoin(services, eq(pipelines.serviceId, services.id))
      .leftJoin(repositories, eq(pipelines.repositoryId, repositories.id))
      .where(eq(pipelines.projectId, projectId))
      .orderBy(desc(pipelines.number))
      .limit(limit);
    const ids = list.map((p) => p.pipeline.id);
    const jobRows = ids.length ? await this.db.select({ id: jobs.id, pipelineId: jobs.pipelineId, stage: jobs.stage, stageOrder: jobs.stageOrder, name: jobs.name, type: jobs.type, status: jobs.status }).from(jobs).where(inArray(jobs.pipelineId, ids)).orderBy(asc(jobs.stageOrder)) : [];
    return list.map((p) => ({ ...p.pipeline, serviceName: p.serviceName, repositoryName: p.repositoryName, jobs: jobRows.filter((j) => j.pipelineId === p.pipeline.id) }));
  }

  /** Called after any job of the pipeline reaches a terminal state: start the next stage or finish. */
  async advance(pipelineId: string): Promise<void> {
    const [pipeline] = await this.db.select().from(pipelines).where(eq(pipelines.id, pipelineId)).limit(1);
    if (!pipeline || ['succeeded', 'failed', 'cancelled'].includes(pipeline.status)) return;
    const all = await this.db.select().from(jobs).where(eq(jobs.pipelineId, pipelineId)).orderBy(asc(jobs.stageOrder));
    if (all.some((j) => ['failed', 'timed_out'].includes(j.status))) {
      const skipped = await this.db.update(jobs).set({ status: 'skipped', error: 'skipped: an earlier stage failed', finishedAt: new Date() }).where(and(eq(jobs.pipelineId, pipelineId), eq(jobs.status, 'pending'))).returning();
      for (const j of skipped) this.tele.jobFinished(j, pipeline, null);
      await this.finish(pipeline, 'failed');
      return;
    }
    if (all.some((j) => j.status === 'cancelled')) {
      await this.db.update(jobs).set({ status: 'skipped', error: 'skipped: pipeline cancelled', finishedAt: new Date() }).where(and(eq(jobs.pipelineId, pipelineId), eq(jobs.status, 'pending')));
      await this.finish(pipeline, 'cancelled');
      return;
    }
    const activeOrder = all.filter((j) => !TERMINAL.includes(j.status) && j.status !== 'pending').map((j) => j.stageOrder);
    if (activeOrder.length) return; // current stage still running
    const nextPending = all.filter((j) => j.status === 'pending');
    if (!nextPending.length) {
      await this.finish(pipeline, 'succeeded');
      return;
    }
    const nextOrder = Math.min(...nextPending.map((j) => j.stageOrder));
    await this.db.update(jobs).set({ status: 'queued', queuedAt: new Date() }).where(and(eq(jobs.pipelineId, pipelineId), eq(jobs.stageOrder, nextOrder), eq(jobs.status, 'pending')));
  }

  private async finish(pipeline: Pipeline, status: Pipeline['status']) {
    const [done] = await this.db.update(pipelines).set({ status, finishedAt: new Date() }).where(eq(pipelines.id, pipeline.id)).returning();
    if (done) this.tele.pipelineFinished(done);
    await this.audit.record({ organizationId: pipeline.organizationId, actor: SYSTEM_ACTOR, action: `pipeline.${status}`, resourceType: 'pipeline', resourceId: pipeline.id, after: { number: pipeline.number } });
  }

  async cancel(user: AuthenticatedUser, pipelineId: string) {
    const pipeline = await this.get(pipelineId);
    const cancelled = await this.db.update(jobs).set({ status: 'cancelled', finishedAt: new Date(), error: `cancelled by ${user.email}` }).where(and(eq(jobs.pipelineId, pipelineId), inArray(jobs.status, ['queued', 'assigned', 'running']))).returning();
    const skipped = await this.db.update(jobs).set({ status: 'skipped', error: 'skipped: pipeline cancelled', finishedAt: new Date() }).where(and(eq(jobs.pipelineId, pipelineId), eq(jobs.status, 'pending'))).returning();
    for (const j of pipeline.jobs) if (j.runnerId && ['assigned', 'running'].includes(j.status)) await this.db.update(runners).set({ currentJobId: null, status: 'online' }).where(and(eq(runners.id, j.runnerId), eq(runners.currentJobId, j.id)));
    const [done] = await this.db.update(pipelines).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(pipelines.id, pipelineId)).returning();
    for (const j of [...cancelled, ...skipped]) this.tele.jobFinished(j, done ?? null, null);
    if (done) this.tele.pipelineFinished(done);
    await this.audit.record({ organizationId: pipeline.organizationId, actor: userActor(user), action: 'pipeline.cancelled', resourceType: 'pipeline', resourceId: pipelineId, after: { number: pipeline.number } });
    return this.get(pipelineId);
  }

  /** Re-runs one job in place (new attempt); a failed pipeline becomes running again. */
  async retryJob(user: AuthenticatedUser, job: Job) {
    if (!TERMINAL.includes(job.status)) throw new BadRequestException('Only finished jobs can be retried');
    const [pipeline] = job.pipelineId ? await this.db.select({ traceParent: pipelines.traceParent }).from(pipelines).where(eq(pipelines.id, job.pipelineId)).limit(1) : [];
    // a new attempt is a new span in the pipeline's trace
    await this.db.update(jobs).set({ status: 'queued', queuedAt: new Date(), runnerId: null, poolId: job.requestedPoolId, result: null, error: null, exitCode: null, startedAt: null, finishedAt: null, assignedAt: null, leaseExpiresAt: null, attempts: 0, traceParent: this.tele.jobTraceparentFor(pipeline?.traceParent) }).where(eq(jobs.id, job.id));
    if (job.pipelineId) {
      await this.db.update(jobs).set({ status: 'pending', error: null, finishedAt: null }).where(and(eq(jobs.pipelineId, job.pipelineId), eq(jobs.status, 'skipped'), sql`${jobs.stageOrder} > ${job.stageOrder}`));
      await this.db.update(pipelines).set({ status: 'running', finishedAt: null }).where(eq(pipelines.id, job.pipelineId));
    }
    await this.audit.record({ organizationId: job.organizationId, actor: userActor(user), action: 'job.retried', resourceType: 'job', resourceId: job.id, before: { status: job.status } });
  }
}
