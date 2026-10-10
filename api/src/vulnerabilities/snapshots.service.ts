import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { projectCondition, ProjectScope } from '../rbac/scope-projects';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { advisories, containerImages, deployments, environmentFindingSnapshots, environments, findings, findingSboms, imageTags, projects, sboms, services, teams, workspaces } from '../database/schema';

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

/**
 * Daily snapshots of open findings per environment. `snapshotToday` runs after every correlation;
 * `backfill` reconstructs past days from the deployment history and the findings' first-seen / resolved timeline.
 */
@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** SBOM that describes a deployment, by digest (sbom/running-sbom.ts). */
  private async sbomOfDeployment(serviceId: string, d: { id?: string; imageTagId: string | null; releaseId: string | null; imageRef?: string | null }): Promise<string | null> {
    const running = await resolveRunningSboms(this.db, { serviceIds: [serviceId] });
    return (d.id ? running.find((r) => r.deploymentId === d.id) : undefined)?.sbomId ?? null;
  }

  /** Open findings of an SBOM as of `at` (null = now): first seen ≤ at and not resolved before at. */
  private async countsAt(sbomId: string | null, at: Date | null) {
    const c = { critical: 0, high: 0, medium: 0, low: 0, kev: 0 };
    if (!sbomId) return c;
    const rows = await this.db
      .select({ severity: findings.severity, kev: advisories.kev, n: sql<number>`count(*)` })
      .from(findingSboms)
      .innerJoin(findings, eq(findingSboms.findingId, findings.id))
      .innerJoin(advisories, eq(findings.advisoryId, advisories.id))
      .where(and(eq(findingSboms.sbomId, sbomId), at ? and(lte(findings.firstSeenAt, at), or(isNull(findings.resolvedAt), gte(findings.resolvedAt, at))) : eq(findings.status, 'open')))
      .groupBy(findings.severity, advisories.kev);
    for (const r of rows) {
      const n = Number(r.n);
      if (r.severity in c) c[r.severity as 'critical' | 'high' | 'medium' | 'low'] += n;
      if (r.kev) c.kev += n;
    }
    return c;
  }

  /** Today's snapshot for every environment with a deployment (idempotent per day). */
  async snapshotToday(): Promise<number> {
    const today = dayStart(new Date());
    const rows = await this.db
      .select({ envId: environments.id, serviceId: environments.serviceId, d: deployments })
      .from(environments)
      .innerJoin(deployments, and(eq(deployments.environmentId, environments.id), isNull(deployments.supersededAt)))
      .where(isNull(environments.archivedAt));
    for (const r of rows) {
      const sbomId = await this.sbomOfDeployment(r.serviceId, r.d);
      const c = await this.countsAt(sbomId, null);
      await this.db.insert(environmentFindingSnapshots).values({ environmentId: r.envId, day: today, version: r.d.version, imageRef: r.d.imageRef, sbomId, ...c, computedAt: new Date() }).onConflictDoUpdate({ target: [environmentFindingSnapshots.environmentId, environmentFindingSnapshots.day], set: { version: r.d.version, imageRef: r.d.imageRef, sbomId, ...c, computedAt: new Date() } });
    }
    return rows.length;
  }

  /** Reconstructs the last `days` days for every environment from the deployment history (only days without a snapshot). */
  async backfill(days = 90): Promise<number> {
    const envs = await this.db.select({ id: environments.id, serviceId: environments.serviceId }).from(environments).where(isNull(environments.archivedAt));
    const today = dayStart(new Date());
    let written = 0;
    for (const env of envs) {
      const history = await this.db.select().from(deployments).where(eq(deployments.environmentId, env.id)).orderBy(asc(deployments.deployedAt));
      if (!history.length) continue;
      const existing = new Set((await this.db.select({ day: environmentFindingSnapshots.day }).from(environmentFindingSnapshots).where(eq(environmentFindingSnapshots.environmentId, env.id))).map((r) => r.day.getTime()));
      const sbomCache = new Map<string, string | null>();
      const first = dayStart(history[0].deployedAt);
      for (let day = new Date(Math.max(first.getTime(), addDays(today, -days).getTime())); day < today; day = addDays(day, 1)) {
        if (existing.has(day.getTime())) continue;
        const endOfDay = addDays(day, 1);
        const current = [...history].reverse().find((d) => d.deployedAt < endOfDay && (!d.supersededAt || d.supersededAt >= endOfDay));
        if (!current) continue;
        if (!sbomCache.has(current.id)) sbomCache.set(current.id, await this.sbomOfDeployment(env.serviceId, current));
        const sbomId = sbomCache.get(current.id) ?? null;
        const c = await this.countsAt(sbomId, endOfDay);
        await this.db.insert(environmentFindingSnapshots).values({ environmentId: env.id, day, version: current.version, imageRef: current.imageRef, sbomId, ...c }).onConflictDoNothing();
        written++;
      }
    }
    if (written) this.logger.log(`backfilled ${written} environment finding snapshots`);
    return written;
  }

  /** Series for the trend panel. */
  async trend(organizationId: string, days: number, projectId?: ProjectScope) {
    const since = addDays(dayStart(new Date()), -days);
    const rows = await this.db
      .select({ envId: environments.id, envName: environments.name, kind: environments.kind, serviceName: services.name, projectId: projects.id, projectName: projects.name, snap: environmentFindingSnapshots })
      .from(environmentFindingSnapshots)
      .innerJoin(environments, eq(environmentFindingSnapshots.environmentId, environments.id))
      .innerJoin(services, eq(environments.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(and(eq(workspaces.organizationId, organizationId), gte(environmentFindingSnapshots.day, since), projectCondition(projects.id, projectId) ?? undefined))
      .orderBy(asc(environmentFindingSnapshots.day));
    const series = new Map<string, { environmentId: string; name: string; kind: string; serviceName: string; projectId: string; projectName: string; points: { day: string; version: string | null; critical: number; high: number; medium: number; low: number; kev: number }[] }>();
    for (const r of rows) {
      let s = series.get(r.envId);
      if (!s) {
        s = { environmentId: r.envId, name: r.envName, kind: r.kind, serviceName: r.serviceName, projectId: r.projectId, projectName: r.projectName, points: [] };
        series.set(r.envId, s);
      }
      s.points.push({ day: r.snap.day.toISOString().slice(0, 10), version: r.snap.version, critical: r.snap.critical, high: r.snap.high, medium: r.snap.medium, low: r.snap.low, kev: r.snap.kev });
    }
    return [...series.values()];
  }
}
