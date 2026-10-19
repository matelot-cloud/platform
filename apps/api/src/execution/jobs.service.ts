import { hostname } from 'node:os';
import { BadRequestException, ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { userIdOrNull, type AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { containerImages, integrations, Job, jobLogChunks, jobs, pipelines, platformHeartbeats, repositories, runners, serviceRepositories, services } from '../database/schema';
import { GithubSyncService } from '../integrations/github/github-sync.service';
import { GithubAppClient } from '../integrations/github/github-app.client';
import { SourceSyncService } from '../integrations/source-sync.service';
import { ScopeChain } from '../rbac/scope.types';
import { AppendLogsDto, CompleteJobDto, CreateJobDto } from './dto/execution.dto';
import { InventoryService } from '../inventory/inventory.service';
import { RegistryService } from '../registry/registry.service';
import { dockerCredentialsFor } from '../integrations/registry-auth';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { PipelinesService } from './pipelines.service';
import { PoolsService } from './pools.service';
import { RunnerPrincipal } from './runner-auth';
import { PipelineTelemetry, pipelineTelemetry } from '../telemetry/pipeline-telemetry';
import { getMetrics, Metrics } from '../telemetry/metrics';

const LEASE_SECONDS = 60;
/** An assigned job the runner has not started within this many seconds goes back to the queue (the agent starts at once). */
const ASSIGN_START_SECONDS = 30;
const HEARTBEAT_STALE_SECONDS = 60;

/** Job lifecycle and the scheduler (claim / lease / requeue). Consumed by users, runners and the sweeper. */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly pools: PoolsService,
    private readonly sourceSync: SourceSyncService,
    private readonly githubSync: GithubSyncService,
    private readonly github: GithubAppClient,
    private readonly pipelines: PipelinesService,
    @Inject(PipelineTelemetry) telemetry: PipelineTelemetry | undefined,
    @Inject(Metrics) metrics: Metrics | undefined,
    @Inject(forwardRef(() => InventoryService)) private readonly inventory: InventoryService,
    private readonly resolver: ScopeResolverService,
    @Inject(forwardRef(() => RegistryService)) private readonly registry: RegistryService,
  ) {
    if (telemetry) this.telemetry = telemetry;
    if (metrics) this.metrics = metrics;
  }
  private telemetry?: PipelineTelemetry;
  private metrics?: Metrics;
  /** Injected by Nest; the process-wide instances where a spec built the service by hand. */
  private get tele(): PipelineTelemetry { return (this.telemetry ??= pipelineTelemetry()); }
  private get met(): Metrics { return (this.metrics ??= getMetrics()); }

  // ---------------------------------------------------------------- users

  async create(user: AuthenticatedUser | null, serviceChain: ScopeChain, dto: CreateJobDto) {
    const serviceId = serviceChain.serviceId!;
    const [service] = await this.db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    if (!service) throw new NotFoundException('Service not found');

    let repositoryId = dto.repositoryId ?? null;
    if (!repositoryId && dto.type !== 'custom' && dto.type !== 'kubernetes_inventory') {
      const [link] = await this.db.select({ repositoryId: serviceRepositories.repositoryId }).from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)).orderBy(asc(serviceRepositories.role)).limit(1);
      repositoryId = link?.repositoryId ?? null;
      if (!repositoryId) throw new BadRequestException('Attach a repository to the service first');
    }
    if (repositoryId) {
      const [ok] = await this.db.select({ id: serviceRepositories.repositoryId }).from(serviceRepositories).where(and(eq(serviceRepositories.serviceId, serviceId), eq(serviceRepositories.repositoryId, repositoryId))).limit(1);
      if (!ok) throw new BadRequestException('That repository is not attached to this service');
    }
    if (dto.poolId) {
      const usable = await this.pools.listForChain(serviceChain);
      if (!usable.some((p) => p.id === dto.poolId)) throw new BadRequestException('That runner pool does not serve this service');
    }
    const [job] = await this.db
      .insert(jobs)
      .values({
        organizationId: serviceChain.organizationId,
        projectId: serviceChain.projectId!,
        serviceId,
        repositoryId,
        type: dto.type,
        requiredTags: dto.requiredTags ?? [],
        poolId: dto.poolId ?? null,
        requestedPoolId: dto.poolId ?? null,
        payload: dto.payload ?? {},
        timeoutSeconds: dto.timeoutSeconds ?? 1800,
        createdById: userIdOrNull(user),
      })
      .returning();
    await this.audit.record({ organizationId: job.organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'job.created', resourceType: 'job', resourceId: job.id, after: { type: job.type, serviceId, repositoryId } });
    return job;
  }

  /** Work in progress across the organization (header activity indicator). */
  async activeForOrganization(organizationId: string) {
    return this.db
      .select({ id: jobs.id, type: jobs.type, status: jobs.status, name: jobs.name, stage: jobs.stage, projectId: jobs.projectId, serviceId: jobs.serviceId, pipelineId: jobs.pipelineId, payload: jobs.payload, createdAt: jobs.createdAt, startedAt: jobs.startedAt, serviceName: services.name })
      .from(jobs)
      .leftJoin(services, eq(jobs.serviceId, services.id))
      .where(and(eq(jobs.organizationId, organizationId), inArray(jobs.status, ['queued', 'assigned', 'running'])))
      .orderBy(desc(jobs.createdAt))
      .limit(50);
  }

  listForProject(projectId: string, limit = 50) {
    return this.db
      .select({ job: jobs, serviceName: services.name, repositoryName: repositories.fullName, runnerName: runners.name })
      .from(jobs)
      .leftJoin(services, eq(jobs.serviceId, services.id))
      .leftJoin(repositories, eq(jobs.repositoryId, repositories.id))
      .leftJoin(runners, eq(jobs.runnerId, runners.id))
      .where(eq(jobs.projectId, projectId))
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .then((rows) => rows.map((r) => ({ ...r.job, serviceName: r.serviceName, repositoryName: r.repositoryName, runnerName: r.runnerName })));
  }

  async get(jobId: string): Promise<Job> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async logs(jobId: string, afterSeq = -1) {
    const chunks = await this.db.select().from(jobLogChunks).where(and(eq(jobLogChunks.jobId, jobId), sql`${jobLogChunks.seq} > ${afterSeq}`)).orderBy(asc(jobLogChunks.seq)).limit(500);
    return chunks.map((c) => ({ seq: c.seq, stream: c.stream, content: c.content, at: c.createdAt }));
  }

  async cancel(user: AuthenticatedUser, job: Job) {
    if (!['queued', 'assigned', 'running'].includes(job.status)) throw new BadRequestException(`Job is already ${job.status}`);
    const [after] = await this.db.update(jobs).set({ status: 'cancelled', finishedAt: new Date(), error: `cancelled by ${user.email}` }).where(eq(jobs.id, job.id)).returning();
    if (after) await this.traceFinished(after, null);
    if (job.runnerId) await this.db.update(runners).set({ currentJobId: null, status: 'online' }).where(and(eq(runners.id, job.runnerId), eq(runners.currentJobId, job.id)));
    await this.audit.record({ organizationId: job.organizationId, actor: userActor(user), action: 'job.cancelled', resourceType: 'job', resourceId: job.id, before: { status: job.status } });
    if (job.pipelineId) await this.pipelines.advance(job.pipelineId);
    return after;
  }

  // ---------------------------------------------------------------- scheduler (runner side)

  /** Atomically hands the best matching queued job to this runner, or null. */
  async claim(principal: RunnerPrincipal): Promise<Job | null> {
    const { runner, pool } = principal;
    if (runner.status === 'draining') return null;
    const tags = [...new Set([...pool.tags, ...runner.tags])];
    // Jobs the pool may run: same organization and the pool's scope on the job's project path (managed pool: any).
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        WITH candidate AS (
          SELECT j.id FROM jobs j
          JOIN projects p ON p.id = j.project_id
          JOIN teams t ON t.id = p.team_id
          JOIN workspaces w ON w.id = t.workspace_id
          WHERE j.status = 'queued'
            AND (${pool.managed} OR j.organization_id = ${pool.organizationId})
            -- only the pool REQUESTED at creation constrains; pool_id is just where an earlier attempt ran
            AND (j.requested_pool_id IS NULL OR j.requested_pool_id = ${pool.id})
            AND j.required_tags <@ ${sql.raw(`ARRAY[${tags.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')}]::text[]`)}
            AND (
              -- the cell's managed pool serves every organization and project of the cell
              ${pool.managed}
              OR (${pool.scopeType} = 'ORGANIZATION' AND ${pool.scopeId}::uuid = j.organization_id)
              OR (${pool.scopeType} = 'WORKSPACE' AND ${pool.scopeId}::uuid = w.id)
              OR (${pool.scopeType} = 'TEAM' AND ${pool.scopeId}::uuid = t.id)
              OR (${pool.scopeType} = 'PROJECT' AND ${pool.scopeId}::uuid = p.id)
            )
          ORDER BY j.priority DESC, j.created_at ASC
          FOR UPDATE OF j SKIP LOCKED
          LIMIT 1
        )
        UPDATE jobs SET status = 'assigned', runner_id = ${runner.id}, pool_id = ${pool.id}, assigned_at = now(),
          lease_expires_at = now() + interval '${sql.raw(String(LEASE_SECONDS))} seconds', attempts = attempts + 1
        WHERE id = (SELECT id FROM candidate)
        RETURNING *`);
      return (rows.rows?.[0] ?? (Array.isArray(rows) ? rows[0] : undefined)) as Record<string, unknown> | undefined;
    });
    if (!claimed) return null;
    this.met.counterAdd(this.met.runnerClaims, 1, { result: 'job' });
    const job = await this.get(String(claimed.id));
    await this.db.update(runners).set({ status: 'busy', currentJobId: job.id, lastHeartbeatAt: new Date() }).where(eq(runners.id, runner.id));
    await this.appendSystemLog(job.id, `assigned to runner ${runner.name} (pool ${pool.slug})`);
    return job;
  }

  ownedJobOf(principal: RunnerPrincipal, jobId: string): Promise<Job> {
    return this.ownedJob(principal, jobId);
  }

  private async ownedJob(principal: RunnerPrincipal, jobId: string): Promise<Job> {
    const job = await this.get(jobId);
    if (job.runnerId !== principal.runner.id) throw new ForbiddenException('Job is not assigned to this runner');
    return job;
  }

  async start(principal: RunnerPrincipal, jobId: string) {
    const job = await this.ownedJob(principal, jobId);
    if (job.status === 'cancelled') return job;
    const [after] = await this.db.update(jobs).set({ status: 'running', startedAt: job.startedAt ?? new Date(), leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) }).where(eq(jobs.id, job.id)).returning();
    return after;
  }

  /** Extends the lease; tells the runner whether the job was cancelled meanwhile. */
  async jobHeartbeat(principal: RunnerPrincipal, jobId: string) {
    const job = await this.ownedJob(principal, jobId);
    await this.db.update(jobs).set({ leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) }).where(eq(jobs.id, job.id));
    await this.db.update(runners).set({ lastHeartbeatAt: new Date() }).where(eq(runners.id, principal.runner.id));
    return { status: job.status, cancelled: job.status === 'cancelled' };
  }

  async appendLogs(principal: RunnerPrincipal, jobId: string, dto: AppendLogsDto) {
    const job = await this.ownedJob(principal, jobId);
    if (!dto.chunks.length) return { ok: true };
    await this.db.insert(jobLogChunks).values(dto.chunks.map((c) => ({ jobId: job.id, seq: c.seq, stream: c.stream ?? 'stdout', content: c.content }))).onConflictDoNothing();
    return { ok: true };
  }

  /** Platform-side completion for jobs the platform executes itself (policy_eval): no runner involved. */
  /** The platform worker's job loop reports it is alive (every pass). */
  async platformHeartbeat(): Promise<void> {
    await this.db.insert(platformHeartbeats).values({ name: 'platform-worker', lastSeenAt: new Date(), detail: { pid: process.pid, host: hostname() } }).onConflictDoUpdate({ target: platformHeartbeats.name, set: { lastSeenAt: new Date(), detail: { pid: process.pid, host: hostname() } } });
  }
  /** When the platform worker last ran its loop (null = never). */
  async platformWorkerSeenAt(): Promise<Date | null> {
    const [r] = await this.db.select({ at: platformHeartbeats.lastSeenAt }).from(platformHeartbeats).where(eq(platformHeartbeats.name, 'platform-worker')).limit(1);
    return r?.at ?? null;
  }

  /** The job's span and metrics once it is terminal (telemetry/pipeline-telemetry.ts). */
  private async traceFinished(job: Job, runnerName: string | null): Promise<void> {
    const [pipeline] = job.pipelineId ? await this.db.select({ traceParent: pipelines.traceParent, number: pipelines.number }).from(pipelines).where(eq(pipelines.id, job.pipelineId)).limit(1) : [];
    this.tele.jobFinished(job, pipeline ?? null, runnerName);
  }

  async finish(jobId: string, status: 'succeeded' | 'failed', result: Record<string, unknown>, error: string | null) {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) return;
    const [done] = await this.db.update(jobs).set({ status, result, error, exitCode: status === 'succeeded' ? 0 : 1, finishedAt: new Date(), leaseExpiresAt: null }).where(eq(jobs.id, jobId)).returning();
    if (done) await this.traceFinished(done, 'platform');
    await this.audit.record({ organizationId: job.organizationId, actor: SYSTEM_ACTOR, action: `job.${status}`, resourceType: 'job', resourceId: job.id, after: { type: job.type, runner: 'platform', exitCode: status === 'succeeded' ? 0 : 1 }, reason: error ?? undefined });
    if (job.pipelineId) await this.pipelines.advance(job.pipelineId);
  }

  /**
   * The first job of a pipeline that reports the commit it checked out (checkout, sbom…) fixes the pipeline's commit;
   * jobs that have not started yet get it in their payload, so later stages (evaluate) work on the same commit.
   */
  async recordCommit(pipelineId: string, result: Record<string, unknown> | null | undefined) {
    const commit = typeof result?.commit === 'string' ? result.commit : typeof result?.commitSha === 'string' ? result.commitSha : null;
    if (!commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return;
    const [p] = await this.db.update(pipelines).set({ commitSha: commit }).where(and(eq(pipelines.id, pipelineId), isNull(pipelines.commitSha))).returning({ id: pipelines.id });
    if (!p) return;
    await this.db.execute(sql`update jobs set payload = payload || ${JSON.stringify({ commitSha: commit })}::jsonb where pipeline_id = ${pipelineId} and status in ('pending', 'queued') and not (payload ? 'commitSha')`);
  }

  async complete(principal: RunnerPrincipal, jobId: string, dto: CompleteJobDto) {
    const job = await this.ownedJob(principal, jobId);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job;
    const [after] = await this.db.update(jobs).set({ status: dto.status, result: dto.result ?? null, error: dto.error ?? null, exitCode: dto.exitCode ?? null, finishedAt: new Date(), leaseExpiresAt: null }).where(eq(jobs.id, job.id)).returning();
    await this.db.update(runners).set({ status: 'online', currentJobId: null, lastHeartbeatAt: new Date() }).where(eq(runners.id, principal.runner.id));
    await this.traceFinished(after, principal.runner.name);
    await this.audit.record({ organizationId: job.organizationId, actor: SYSTEM_ACTOR, action: `job.${dto.status}`, resourceType: 'job', resourceId: job.id, after: { type: job.type, runner: principal.runner.name, exitCode: dto.exitCode ?? null }, reason: dto.error });
    if (job.pipelineId && dto.status === 'succeeded') await this.recordCommit(job.pipelineId, dto.result);
    if (job.pipelineId) await this.pipelines.advance(job.pipelineId);
    if (dto.status === 'succeeded' && job.type === 'kubernetes_inventory' && dto.result && job.payload.environmentId) {
      try {
        const chain = await this.resolver.resolveChain({ environmentId: String(job.payload.environmentId) });
        const applied = await this.inventory.applyKubernetesInventory(chain, dto.result as { namespace: string; workloads: { name: string; kind: string; replicas?: number; images: string[] }[] });
        await this.appendSystemLog(job.id, `inventory applied: ${applied.recorded} deployments recorded from ${applied.workloads} workloads`);
      } catch (error) {
        await this.appendSystemLog(job.id, `inventory not applied: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return after;
  }

  /** What the runner needs to fetch the code, minted just in time. Never stored on the runner side. */
  /** Registry credentials for the image a job works on (payload.imageRef), if a registry connection covers it. */
  async registryCredentials(principal: RunnerPrincipal, jobId: string) {
    const job = await this.ownedJob(principal, jobId);
    const imageRef = String(job.payload.imageRef ?? '');
    if (!imageRef || !job.serviceId) return { kind: 'none' as const };
    const name = (imageRef.includes('@') ? imageRef.split('@')[0] : imageRef.split(/:(?=[^/]+$)/)[0]).toLowerCase();
    const internal = await this.registry.internalCredentialsFor(name);
    if (internal) return internal;
    const [img] = await this.db.select({ integrationId: containerImages.integrationId }).from(containerImages).where(and(eq(containerImages.serviceId, job.serviceId), eq(containerImages.name, name))).limit(1);
    if (!img?.integrationId) return { kind: 'none' as const };
    const [integration] = await this.db.select().from(integrations).where(eq(integrations.id, img.integrationId)).limit(1);
    if (!integration) return { kind: 'none' as const };
    const creds = this.sourceSync.credentialsOf(integration);
    const host = String(integration.settings.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const docker = await dockerCredentialsFor(host, creds, `integration:${integration.id}`).catch(() => null);
    if (docker) return { kind: 'registry' as const, host, username: docker.username, secret: docker.password };
    return { kind: 'none' as const };
  }

  async credentials(principal: RunnerPrincipal, jobId: string) {
    const job = await this.ownedJob(principal, jobId);
    if (!job.repositoryId) return { kind: 'none' as const };
    const [row] = await this.db.select({ repository: repositories, integration: integrations }).from(repositories).innerJoin(integrations, eq(repositories.integrationId, integrations.id)).where(eq(repositories.id, job.repositoryId)).limit(1);
    if (!row) throw new NotFoundException('Repository not found');
    const { repository, integration } = row;
    if (integration.provider === 'github' && integration.externalAccountId) {
      const token = await this.github.installationToken(integration.externalAccountId, this.githubSync.appConfigFor(integration));
      return { kind: 'https' as const, url: repository.cloneUrl ?? `${repository.htmlUrl}.git`, username: 'x-access-token', secret: token, defaultBranch: repository.defaultBranch, fullName: repository.fullName };
    }
    const creds = this.sourceSync.credentialsOf(integration);
    switch (creds.type) {
      case 'ssh':
        return { kind: 'ssh' as const, url: repository.sshUrl ?? String(integration.settings.repositoryUrl), privateKey: creds.privateKey, defaultBranch: repository.defaultBranch, fullName: repository.fullName };
      case 'token':
        return { kind: 'https' as const, url: repository.cloneUrl ?? String(integration.settings.repositoryUrl), username: creds.username ?? (integration.provider === 'gitlab' ? 'oauth2' : 'x-access-token'), secret: creds.token, defaultBranch: repository.defaultBranch, fullName: repository.fullName };
      case 'basic':
        return { kind: 'https' as const, url: repository.cloneUrl ?? String(integration.settings.repositoryUrl), username: creds.username, secret: creds.password, defaultBranch: repository.defaultBranch, fullName: repository.fullName };
      default:
        return { kind: 'https' as const, url: repository.cloneUrl ?? String(integration.settings.repositoryUrl), defaultBranch: repository.defaultBranch, fullName: repository.fullName };
    }
  }

  // ---------------------------------------------------------------- sweeper (worker side)

  /** Requeues or times out jobs whose lease expired; marks silent runners offline. Called periodically. */
  /**
   * Hands an assigned-but-never-started job back to the queue (the runner went away before receiving or starting it):
   * the attempt is not counted, the requested pool binding is restored, the runner is freed. Only while still
   * `assigned` to that runner — a started job is never taken back here.
   */
  async unclaim(jobId: string, runnerId: string, reason: string): Promise<boolean> {
    const [back] = await this.db.update(jobs)
      .set({ status: 'queued', runnerId: null, poolId: sql`${jobs.requestedPoolId}`, assignedAt: null, leaseExpiresAt: null, attempts: sql`greatest(${jobs.attempts} - 1, 0)` })
      .where(and(eq(jobs.id, jobId), eq(jobs.runnerId, runnerId), eq(jobs.status, 'assigned'), isNull(jobs.startedAt)))
      .returning({ id: jobs.id });
    if (!back) return false;
    await this.db.update(runners).set({ currentJobId: null, status: 'online' }).where(and(eq(runners.id, runnerId), eq(runners.currentJobId, jobId)));
    await this.appendSystemLog(jobId, reason);
    return true;
  }

  async sweep(): Promise<{ requeued: number; failed: number; offline: number }> {
    const now = new Date();
    // assigned but never started within ASSIGN_START_SECONDS: the runner never got it (or died right away)
    const unstarted = await this.db.select({ id: jobs.id, runnerId: jobs.runnerId }).from(jobs).where(and(eq(jobs.status, 'assigned'), isNull(jobs.startedAt), lt(jobs.assignedAt, new Date(now.getTime() - ASSIGN_START_SECONDS * 1000))));
    let returned = 0;
    for (const j of unstarted) if (j.runnerId && await this.unclaim(j.id, j.runnerId, `not started within ${ASSIGN_START_SECONDS}s of assignment (runner gone?); back in the queue`)) returned++;
    const expired = await this.db.select().from(jobs).where(and(inArray(jobs.status, ['assigned', 'running']), lt(jobs.leaseExpiresAt, now)));
    let requeued = 0;
    let failed = 0;
    for (const job of expired) {
      if (job.runnerId) await this.db.update(runners).set({ currentJobId: null, status: 'online' }).where(and(eq(runners.id, job.runnerId), eq(runners.currentJobId, job.id)));
      const overTime = job.startedAt && now.getTime() - job.startedAt.getTime() > job.timeoutSeconds * 1000;
      if (!overTime && job.attempts < job.maxAttempts) {
        // back to the requested binding (null = any eligible pool), not the pool of the runner that lost it
        await this.db.update(jobs).set({ status: 'queued', runnerId: null, poolId: job.requestedPoolId, assignedAt: null, leaseExpiresAt: null, startedAt: null }).where(eq(jobs.id, job.id));
        await this.appendSystemLog(job.id, `lease expired on attempt ${job.attempts}; requeued${job.requestedPoolId ? '' : ' for any eligible runner'}`);
        requeued++;
      } else {
        const [done] = await this.db.update(jobs).set({ status: overTime ? 'timed_out' : 'failed', error: overTime ? `exceeded ${job.timeoutSeconds}s` : `runner lost after ${job.attempts} attempts`, finishedAt: now, leaseExpiresAt: null }).where(eq(jobs.id, job.id)).returning();
        if (done) await this.traceFinished(done, null);
        await this.appendSystemLog(job.id, overTime ? 'timed out' : 'runner lost; no attempts left');
        if (job.pipelineId) await this.pipelines.advance(job.pipelineId);
        failed++;
      }
    }
    const stale = new Date(now.getTime() - HEARTBEAT_STALE_SECONDS * 1000);
    const offline = await this.db.update(runners).set({ status: 'offline', currentJobId: null }).where(and(inArray(runners.status, ['online', 'busy']), or(isNull(runners.lastHeartbeatAt), lt(runners.lastHeartbeatAt, stale)))).returning({ id: runners.id });
    if (requeued || failed || offline.length || returned) this.logger.log(`sweep: requeued ${requeued}, returned unstarted ${returned}, failed ${failed}, offline ${offline.length}`);
    return { requeued: requeued + returned, failed, offline: offline.length };
  }

  async appendSystemLog(jobId: string, message: string | string[]) {
    if (Array.isArray(message)) { for (const m of message) await this.appendSystemLog(jobId, m); return; }
    const [last] = await this.db.select({ seq: jobLogChunks.seq }).from(jobLogChunks).where(eq(jobLogChunks.jobId, jobId)).orderBy(desc(jobLogChunks.seq)).limit(1);
    await this.db.insert(jobLogChunks).values({ jobId, seq: (last?.seq ?? -1) + 1, stream: 'system', content: `${message}\n` }).onConflictDoNothing();
  }
}
