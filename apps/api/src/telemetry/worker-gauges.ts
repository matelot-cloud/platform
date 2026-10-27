import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { DATABASE, Database } from '../database/database.module';
import { backupReports, codeFindings, findings, jobs, remediations, runnerPools, runners } from '../database/schema';
import { QUEUES } from '../jobs/queues';
import { Metrics } from './metrics';

const HEARTBEAT_STALE_SECONDS = 60;   // jobs.service.ts: a runner is online while its heartbeat is younger than this

/**
 * The gauges that need a query — refreshed by the worker on a timer (every 15 s; findings every 10 min with the
 * correlation loop), never computed on scrape: BullMQ queue depth and age, the pipeline queue (jobs table) by kind
 * and pool, runners online / busy / last seen by pool, open findings by severity and kind.
 */
@Injectable()
export class WorkerGauges {
  private readonly logger = new Logger(WorkerGauges.name);
  private queues: Queue[] = [];

  constructor(@Inject(DATABASE) private readonly db: Database, private readonly metrics: Metrics) {}

  attach(connection: IORedis): void {
    this.queues = Object.values(QUEUES).map((name) => new Queue(name, { connection }));
  }

  /** Queue depth, runners, pipeline queue: cheap, every 15 s. */
  async refresh(now = new Date()): Promise<void> {
    try {
      await Promise.all([this.refreshQueues(now), this.refreshPipelineQueue(now), this.refreshRunners(now), this.refreshBackups()]);
    } catch (error) {
      this.logger.warn(`gauge refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async refreshQueues(now: Date): Promise<void> {
    const series: { value: number; attributes: { queue: string; state: string } }[] = [];
    const oldest: { value: number; attributes: { queue: string } }[] = [];
    for (const q of this.queues) {
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, value] of Object.entries(counts)) series.push({ value, attributes: { queue: q.name, state } });
      const [first] = await q.getWaiting(0, 0);
      oldest.push({ value: first ? Math.max(0, (now.getTime() - first.timestamp) / 1000) : 0, attributes: { queue: q.name } });
    }
    this.metrics.queueJobs.replace(series);
    this.metrics.queueOldestJobAge.replace(oldest);
  }

  private async refreshPipelineQueue(now: Date): Promise<void> {
    // queued jobs by kind and requested pool ("any" = no pool constraint); the oldest queued job's age by pool
    const rows = await this.db
      .select({ kind: jobs.type, pool: sql<string | null>`${runnerPools.slug}`, count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${jobs.createdAt})` })
      .from(jobs)
      .leftJoin(runnerPools, eq(runnerPools.id, jobs.requestedPoolId))
      .where(eq(jobs.status, 'queued'))
      .groupBy(jobs.type, runnerPools.slug);
    this.metrics.pipelineJobsQueued.replace(rows.map((r) => ({ value: Number(r.count), attributes: { kind: r.kind, pool: r.pool ?? 'any' } })));
    const byPool = new Map<string, number>();
    for (const r of rows) {
      const pool = r.pool ?? 'any';
      const age = r.oldest ? Math.max(0, (now.getTime() - new Date(r.oldest).getTime()) / 1000) : 0;
      byPool.set(pool, Math.max(byPool.get(pool) ?? 0, age));
    }
    this.metrics.pipelineOldestQueuedJobAge.replace([...byPool].map(([pool, value]) => ({ value, attributes: { pool } })));
  }

  private async refreshRunners(now: Date): Promise<void> {
    const stale = new Date(now.getTime() - HEARTBEAT_STALE_SECONDS * 1000);
    const rows = await this.db
      .select({ pool: runnerPools.slug, managed: runnerPools.managed, status: runners.status, lastSeen: runners.lastHeartbeatAt })
      .from(runners)
      .innerJoin(runnerPools, eq(runnerPools.id, runners.poolId))
      .where(and(inArray(runners.status, ['online', 'busy', 'draining']), sql`${runners.lastHeartbeatAt} > ${stale}`));
    const online = new Map<string, { managed: boolean; online: number; busy: number; lastSeen: number }>();
    for (const r of rows) {
      const e = online.get(r.pool) ?? { managed: r.managed, online: 0, busy: 0, lastSeen: 0 };
      e.online++;
      if (r.status === 'busy') e.busy++;
      if (r.lastSeen) e.lastSeen = Math.max(e.lastSeen, Math.floor(r.lastSeen.getTime() / 1000));
      online.set(r.pool, e);
    }
    // last_seen covers EVERY pool with a runner ever heard from (stale ones included), so NoRunnerOnline can be
    // `time() - matelot_runner_last_seen_timestamp_seconds > 600` per pool, an expression on the scrape, not a flag
    const seen = await this.db
      .select({ pool: runnerPools.slug, managed: runnerPools.managed, lastSeen: sql<Date | null>`max(${runners.lastHeartbeatAt})` })
      .from(runners)
      .innerJoin(runnerPools, eq(runnerPools.id, runners.poolId))
      .groupBy(runnerPools.slug, runnerPools.managed);
    this.metrics.runnersOnline.replace(seen.map((p) => ({ value: online.get(p.pool)?.online ?? 0, attributes: { pool: p.pool, managed: String(p.managed) } })));
    this.metrics.runnersBusy.replace(seen.map((p) => ({ value: online.get(p.pool)?.busy ?? 0, attributes: { pool: p.pool } })));
    this.metrics.runnerLastSeen.replace(seen.filter((p) => p.lastSeen).map((p) => ({ value: Math.floor(new Date(p.lastSeen!).getTime() / 1000), attributes: { pool: p.pool } })));
  }

  /** The newest successful and failed backup runs (reported by the backup job): BackupTooOld / BackupFailed read these. */
  private async refreshBackups(): Promise<void> {
    const newest = async (status: 'succeeded' | 'failed') => (await this.db.select({ finishedAt: backupReports.finishedAt, startedAt: backupReports.startedAt }).from(backupReports).where(eq(backupReports.status, status)).orderBy(sql`${backupReports.finishedAt} desc`).limit(1))[0];
    const [ok, bad] = await Promise.all([newest('succeeded'), newest('failed')]);
    this.metrics.backupLastSuccess.replace(ok ? [{ value: Math.floor(ok.finishedAt.getTime() / 1000) }] : []);
    this.metrics.backupLastFailure.replace(bad ? [{ value: Math.floor(bad.finishedAt.getTime() / 1000) }] : []);
    this.metrics.backupLastDuration.replace(ok?.startedAt ? [{ value: Math.max(0, (ok.finishedAt.getTime() - ok.startedAt.getTime()) / 1000) }] : []);
  }

  /** Open findings by severity and kind — one query over the cell, with the correlation loop (10 min). */
  async refreshFindings(): Promise<void> {
    try {
      const dep = await this.db.select({ severity: findings.severity, count: sql<number>`count(*)::int` }).from(findings).where(eq(findings.status, 'open')).groupBy(findings.severity);
      const code = await this.db.select({ severity: codeFindings.severity, count: sql<number>`count(*)::int` }).from(codeFindings).where(eq(codeFindings.status, 'open')).groupBy(codeFindings.severity);
      this.metrics.findingsOpen.replace([
        ...dep.map((r) => ({ value: Number(r.count), attributes: { severity: r.severity, kind: 'dependency' } })),
        ...code.map((r) => ({ value: Number(r.count), attributes: { severity: r.severity, kind: 'code' } })),
      ]);
      // SLA breaches: open remediations past their due date, by severity (the digest notifies daily; the gauge every 10 min)
      const breaches = await this.db.select({ severity: remediations.severity, count: sql<number>`count(*)::int` }).from(remediations).where(and(inArray(remediations.status, ['open', 'in_progress']), sql`${remediations.dueAt} < now()`)).groupBy(remediations.severity);
      this.metrics.slaBreaches.replace(breaches.map((r) => ({ value: Number(r.count), attributes: { severity: r.severity } })));
    } catch (error) {
      this.logger.warn(`findings gauge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.queues.map((q) => q.close().catch(() => undefined)));
  }
}
