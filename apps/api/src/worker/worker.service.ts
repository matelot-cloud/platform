import { PoolsService } from '../execution/pools.service';
import { UsageService } from '../usage/usage.service';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { AppConfig } from '../config/env';
import { GithubSyncService } from '../integrations/github/github-sync.service';
import { SourceSyncService } from '../integrations/source-sync.service';
import { JobsService } from '../execution/jobs.service';
import { InventoryService } from '../inventory/inventory.service';
import { RegistryService } from '../registry/registry.service';
import { CorrelationService } from '../vulnerabilities/correlation.service';
import { SnapshotsService } from '../vulnerabilities/snapshots.service';
import { PoliciesService } from '../policies/policies.service';
import { ExceptionsService } from '../policies/exceptions.service';
import { RemediationService } from '../remediation/remediation.service';
import { DigestService } from '../notifications/digest.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { and, eq, inArray } from 'drizzle-orm';
import { jobs } from '../database/schema';
import { DATABASE, Database } from '../database/database.module';
import { RiskService } from '../risk/risk.service';
import { GithubSyncJob, GithubWebhookJob, QUEUES } from '../jobs/queues';
import { WorkerGauges } from '../telemetry/worker-gauges';
import { Metrics } from '../telemetry/metrics';
import { contextFromTraceparent, emitCompletedSpan, inSpan } from '../telemetry/spans';
import { newSpanId, newTraceId } from '../telemetry/ids';
import { context as otelContext } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

@Injectable()
export class WorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private readonly connection: IORedis;
  private workers: Worker[] = [];
  private sweeper?: NodeJS.Timeout;
  private imageSync?: NodeJS.Timeout;
  private registryReconcile?: NodeJS.Timeout;
  private correlate?: NodeJS.Timeout;
  private snapshotDaily?: NodeJS.Timeout;
  private gateLoop?: NodeJS.Timeout;
  private exceptionsLoop?: NodeJS.Timeout;
  private enrich?: NodeJS.Timeout;
  private usageLoop?: NodeJS.Timeout;

  constructor(
    @Inject(ConfigService) config: AppConfig,
    private readonly githubSync: GithubSyncService,
    private readonly sourceSync: SourceSyncService,
    private readonly jobs: JobsService,
    private readonly inventory: InventoryService,
    private readonly registry: RegistryService,
    private readonly correlation: CorrelationService,
    private readonly snapshots: SnapshotsService,
    private readonly risk: RiskService,
    private readonly usage: UsageService,
    private readonly poolsService: PoolsService,
    private readonly policiesService: PoliciesService,
    private readonly exceptionsService: ExceptionsService,
    private readonly remediationService: RemediationService,
    private readonly digest: DigestService,
    private readonly resolver: ScopeResolverService,
    @Inject(DATABASE) private readonly db: Database,
    private readonly gauges: WorkerGauges,
    private readonly metrics: Metrics,
  ) {
    this.connection = new IORedis(config.get('REDIS_URL', { infer: true }), { maxRetriesPerRequest: null });
  }
  private gaugeTick?: NodeJS.Timeout;

  /** A loop pass as one root span `worker <name>` (docs/observability.md): a slow run is one trace, never orphan query spans. */
  private loop<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return inSpan(`worker ${name}`, fn);
  }
  /** Housekeeping that runs every few seconds (sweeper, gauges, heartbeat): no span unless it did something — its
   *  queries are never recorded (an orphan `pg.query` root span was one of these, started outside any span). */
  private quiet<T>(fn: () => Promise<T>): Promise<T> {
    return otelContext.with(suppressTracing(otelContext.active()), fn);
  }

  onModuleInit(): void {
    this.workers = [
      new Worker<GithubSyncJob>(QUEUES.githubSync, (job) => this.handleSync(job), { connection: this.connection, concurrency: 2 }),
      new Worker<GithubWebhookJob>(QUEUES.githubWebhooks, (job) => this.handleWebhook(job), { connection: this.connection, concurrency: 5 }),
    ];
    for (const worker of this.workers) {
      worker.on('failed', (job, error) => { this.metrics.counterAdd(this.metrics.queueJobsProcessed, 1, { queue: worker.name, result: 'failed' }); this.logger.error(`${worker.name} job ${job?.id} failed: ${error.message}`); });
      worker.on('completed', (job) => { this.metrics.counterAdd(this.metrics.queueJobsProcessed, 1, { queue: worker.name, result: 'completed' }); this.logger.log(`${worker.name} job ${job.id} completed`); });
    }
    // the gauges a scrape cannot compute: queue depth, pipeline queue, runners (15 s); open findings with correlation
    this.gauges.attach(this.connection);
    void this.quiet(() => this.gauges.refresh());
    void this.quiet(() => this.gauges.refreshFindings());
    this.gaugeTick = setInterval(() => void this.quiet(() => this.gauges.refresh()), 15_000);
    // the sweeper every 15 s: silent, and a `worker sweep` span (emitted after the fact) only when it changed something
    this.sweeper = setInterval(() => void this.quiet(async () => {
      const started = new Date();
      const r = await this.jobs.sweep();
      if (r.requeued || r.failed || r.offline) emitCompletedSpan({ name: 'worker sweep', traceId: newTraceId(), spanId: newSpanId(), startTime: started, endTime: new Date(), attributes: { 'matelot.sweep.requeued': r.requeued, 'matelot.sweep.failed': r.failed, 'matelot.sweep.offline': r.offline } });
    }).catch((e: Error) => this.logger.error(`sweep failed: ${e.message}`)), 15_000);
    if (this.registry.available) {
      const run = () => void this.loop('registry reconcile', () => this.registry.reconcile()).then((r) => r.newTags && this.logger.log(`registry reconcile: ${r.newTags} new tags across ${r.repositories} repositories`)).catch((e: Error) => this.logger.warn(`registry reconcile failed: ${e.message}`));
      setTimeout(run, 10_000);
      this.registryReconcile = setInterval(run, 2 * 60_000);
    }
    // every interval loop is one root span ("worker <loop>"): a slow correlation run is one trace, not log lines
    const correlate = () => void inSpan('worker correlation', async () => {
      const started = Date.now();
      const r = await this.correlation.run({ limit: 2000 });
      this.metrics.sbomCorrelationDuration.record((Date.now() - started) / 1000, { source: 'loop' });
      if (r.checked || r.findingsOpened || r.findingsFixed) this.logger.log(`correlation: ${r.checked} components checked, ${r.newAdvisories} new advisories, ${r.findingsOpened} findings opened, ${r.findingsFixed} fixed`);
      await this.gauges.refreshFindings();
    }).catch((e: Error) => this.logger.warn(`correlation failed: ${e.message}`));
    // Pipeline "evaluate" stage: policy_eval jobs are executed here, not by runners.
    const exceptionsTick = () => this.loop('exceptions', () => this.exceptionsService.tick()).then((r) => { if (r.expired || r.applied) this.logger.log(`exceptions: ${r.expired} expired, ${r.applied} finding(s) covered`); }).catch((e: Error) => this.logger.warn(`exceptions tick failed: ${e.message}`));
    const digestTick = () => this.loop('digest', () => this.digest.tick()).then((r) => { if (r.overdue || r.kev || r.expiring) this.logger.log(`notifications: ${r.overdue} SLA, ${r.kev} KEV, ${r.expiring} expiring`); }).catch((e: Error) => this.logger.warn(`digest failed: ${e.message}`));
    const remediationTick = () => this.loop('remediation reconcile', async () => { const r = await this.remediationService.reconcile(); if (r.closed) this.logger.log(`remediations: ${r.closed} closed (findings resolved)`); const t = await this.remediationService.syncFromTrackers(); if (t.closed || t.reopened) this.logger.log(`trackers: ${t.closed} remediation(s) closed, ${t.reopened} reopened from Jira/GitHub/GitLab`); }).catch((e: Error) => this.logger.warn(`remediation reconcile failed: ${e.message}`));
    this.exceptionsLoop = setInterval(() => { void exceptionsTick(); void digestTick(); void remediationTick(); }, 60 * 60_000);
    setTimeout(() => void exceptionsTick(), 30_000);
    setTimeout(() => void digestTick().catch(() => undefined), 60_000);
    // Platform jobs (policy_eval, tags __platform__) run here, not on runners: first pass right away (jobs queued while
    // the worker was down), then every 5 s, never overlapping, every failure logged.
    void this.runPlatformJobsOnce();
    this.gateLoop = setInterval(() => void this.runPlatformJobsOnce(), 5_000);
    this.logger.log('platform job loop: policy_eval every 5 s');
    setTimeout(correlate, 20_000);
    setTimeout(() => void this.loop('snapshot backfill', () => this.snapshots.backfill(90).then(() => this.snapshots.snapshotToday())).catch((e: Error) => this.logger.warn(`snapshot backfill failed: ${e.message}`)), 40_000);
    this.snapshotDaily = setInterval(() => void this.loop('snapshot', () => this.snapshots.snapshotToday().then(() => this.risk.computeAll())).catch((e: Error) => this.logger.warn(`snapshot failed: ${e.message}`)), 6 * 3600_000);
    setTimeout(() => void this.loop('risk', () => this.risk.computeAll()).then((n) => this.logger.log(`risk scores computed for ${n} services`)).catch((e: Error) => this.logger.warn(`risk failed: ${e.message}`)), 60_000);
    this.correlate = setInterval(correlate, 10 * 60_000);
    this.enrich = setInterval(() => void this.loop('advisory enrichment', () => this.correlation.refreshEnrichment()).then((n) => n && this.logger.log(`advisory enrichment refreshed for ${n} advisories`)).catch((e: Error) => this.logger.warn(`enrichment failed: ${e.message}`)), 24 * 3600_000);
    // usage metering: current month of every organization hourly; last month is finalised on the first pass after it ends
    const usageTick = () => void this.loop('usage', async () => { const n = await this.poolsService.pruneManagedRunners().catch((e: Error) => { this.logger.warn(`managed runner prune failed: ${e.message}`); return 0; }); if (n) this.logger.log(`managed runners: ${n} gone for a day removed`); return this.usage.snapshotAll(); }).then((r) => r.finalised && this.logger.log(`usage: ${r.organizations} organization(s), ${r.finalised} previous-month snapshot(s) written`)).catch((e: Error) => this.logger.warn(`usage snapshot failed: ${e.message}`));
    setTimeout(usageTick, 45_000);
    this.usageLoop = setInterval(usageTick, 60 * 60_000);
    this.imageSync = setInterval(() => void this.loop('image sync', () => this.inventory.syncStaleImages(15)).then((n) => n && this.logger.log(`image tags refreshed for ${n} images`)).catch((e: Error) => this.logger.error(`image sync failed: ${e.message}`)), 5 * 60_000);
    this.logger.log(`Worker started: ${this.workers.map((w) => w.name).join(', ')} + job sweeper`);
  }

  private platformBusy = false;
  private platformWarned = new Set<string>();
  /** One pass over queued platform jobs. Returns what happened so tests (and the log) can see it. */
  async runPlatformJobsOnce(): Promise<{ claimed: number; succeeded: number; failed: number; skipped: number }> {
    const out = { claimed: 0, succeeded: 0, failed: 0, skipped: 0 };
    if (this.platformBusy) return out; // a previous pass is still evaluating: do not pile up
    this.platformBusy = true;
    // every 5 s: the heartbeat and the queue query are silent; an evaluation runs under its job's trace (below)
    return this.quiet(() => this.runPlatformJobsPass(out)).finally(() => { this.platformBusy = false; });
  }

  private async runPlatformJobsPass(out: { claimed: number; succeeded: number; failed: number; skipped: number }) {
    try {
      await this.jobs.platformHeartbeat().catch(() => undefined);
      const queued = await this.db.select().from(jobs).where(and(eq(jobs.type, 'policy_eval'), eq(jobs.status, 'queued'))).orderBy(jobs.createdAt).limit(20);
      for (const job of queued) {
        // stuck diagnostics: queued for > 2 min means a previous pass did not get to it
        const age = Date.now() - job.createdAt.getTime();
        if (age > 120_000 && !this.platformWarned.has(job.id)) { this.platformWarned.add(job.id); this.logger.warn(`platform job ${job.id} (${job.name ?? job.type}) has been queued for ${Math.round(age / 60_000)} min — picking it up now`); }
        // atomic claim: only one pass / worker instance runs a job
        const [claimed] = await this.db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued'))).returning({ id: jobs.id });
        if (!claimed) { out.skipped++; continue; }
        out.claimed++;
        try {
          if (!job.serviceId) throw new Error('job has no service');
          const chain = await this.resolver.resolveChain({ serviceId: job.serviceId });
          // the evaluation runs under the job's span in the pipeline's trace (jobs.finish emits the job span itself)
          const ev = await otelContext.with(contextFromTraceparent(job.traceParent), () => inSpan('gate evaluate', () => this.policiesService.evaluateJob({ id: job.id, serviceId: job.serviceId!, payload: job.payload as Record<string, unknown>, pipelineId: job.pipelineId }, chain), { attributes: { 'matelot.job.id': job.id, 'matelot.pipeline.id': job.pipelineId ?? '' } }));
          const lines = [`gate: ${ev.result.toUpperCase()} — ${ev.policies.length} polic${ev.policies.length === 1 ? 'y' : 'ies'} applied`, ...ev.violations.map((v) => `${v.action === 'block' ? '✗' : '!'} ${v.policyName}: ${v.message}`)];
          await this.jobs.appendSystemLog(job.id, lines);
          await this.jobs.finish(job.id, ev.result === 'fail' ? 'failed' : 'succeeded', { gate: ev.result, evaluationId: ev.id, violations: ev.violations }, ev.result === 'fail' ? ev.violations.filter((v) => v.action === 'block').map((v) => v.message).join('; ') : null);
          out.succeeded++;
        } catch (e) {
          out.failed++;
          this.logger.warn(`platform job ${job.id} failed: ${e instanceof Error ? e.message : String(e)}`);
          await this.jobs.finish(job.id, 'failed', {}, e instanceof Error ? e.message : String(e)).catch(() => undefined);
        }
      }
    } catch (e) {
      this.logger.error(`platform job loop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
  }

  /** A queue job runs under the trace of whoever enqueued it (QueueService puts the traceparent into the job data). */
  private async handleSync(job: Job<GithubSyncJob & { __traceparent?: string }>) {
    return otelContext.with(contextFromTraceparent(job.data.__traceparent), () => inSpan(`queue ${QUEUES.githubSync}`, async () => {
      try {
        const result = await this.sourceSync.sync(job.data.integrationId);
        this.logger.log(`synced integration ${job.data.integrationId}: ${JSON.stringify(result)}`);
        return result;
      } catch (error) {
        this.metrics.counterAdd(this.metrics.integrationSyncFailures, 1, { kind: 'source' });
        throw error;
      }
    }, { attributes: { 'messaging.system': 'bullmq', 'messaging.destination.name': QUEUES.githubSync } }));
  }

  private async handleWebhook(job: Job<GithubWebhookJob & { __traceparent?: string }>) {
    return otelContext.with(contextFromTraceparent(job.data.__traceparent), () => inSpan(`queue ${QUEUES.githubWebhooks}`, async () => {
      this.metrics.webhookLag.record(Math.max(0, (Date.now() - job.timestamp) / 1000), { provider: 'github' });
      await this.githubSync.processDelivery(job.data.deliveryId);
    }, { attributes: { 'messaging.system': 'bullmq', 'messaging.destination.name': QUEUES.githubWebhooks } }));
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.gaugeTick) clearInterval(this.gaugeTick);
    await this.gauges.close();
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.imageSync) clearInterval(this.imageSync);
    if (this.registryReconcile) clearInterval(this.registryReconcile);
    if (this.correlate) clearInterval(this.correlate);
    if (this.gateLoop) clearInterval(this.gateLoop);
    if (this.exceptionsLoop) clearInterval(this.exceptionsLoop);
    if (this.snapshotDaily) clearInterval(this.snapshotDaily);
    if (this.enrich) clearInterval(this.enrich);
    if (this.usageLoop) clearInterval(this.usageLoop);
    await Promise.all(this.workers.map((w) => w.close()));
    await this.connection.quit().catch(() => undefined);
  }
}
