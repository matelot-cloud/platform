import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { projectCondition, ProjectScope } from '../rbac/scope-projects';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { advisories, containerImages, deployments, environments, findings, findingSboms, imageTags, projects, riskScores, sboms, services, teams, workspaces } from '../database/schema';
import { scoreRisk, RiskResult } from './scoring';

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Computes and stores risk scores per service; serves rankings, details and the project graph. */
@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Recomputes today's score for one service. */
  async compute(serviceId: string): Promise<RiskResult & { serviceId: string }> {
    const [svc] = await this.db.select({ id: services.id, criticality: services.criticality, projectCriticality: projects.criticality }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).where(eq(services.id, serviceId)).limit(1);
    if (!svc) throw new Error('service not found');
    const envs = await this.db.select({ env: environments, d: deployments }).from(environments).leftJoin(deployments, and(eq(deployments.environmentId, environments.id), isNull(deployments.supersededAt))).where(and(eq(environments.serviceId, serviceId), isNull(environments.archivedAt)));
    // SBOM of what runs in each environment, by digest (sbom/running-sbom.ts), as in the vulnerability views.
    const envSbom = new Map<string, string | null>((await resolveRunningSboms(this.db, { serviceIds: [serviceId] })).map((r) => [r.environmentId, r.sbomId]));
    const sbomToEnvs = new Map<string, { kind: string; internetFacing: boolean }[]>();
    for (const e of envs) {
      const id = envSbom.get(e.env.id);
      if (!id) continue;
      sbomToEnvs.set(id, [...(sbomToEnvs.get(id) ?? []), { kind: e.env.kind, internetFacing: e.env.internetFacing }]);
    }
    const open = await this.db.select({ f: findings, kev: advisories.kev, epss: advisories.epssScore }).from(findings).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).where(and(eq(findings.serviceId, serviceId), eq(findings.status, 'open')));
    const links = open.length ? await this.db.select({ findingId: findingSboms.findingId, sbomId: findingSboms.sbomId }).from(findingSboms).where(inArray(findingSboms.findingId, open.map((o) => o.f.id))) : [];
    const now = Date.now();
    const input = {
      criticality: (svc.criticality ?? svc.projectCriticality) as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | null,
      // What RUNS, counted once per (advisory, source package): findings of images that run nowhere do not drive the
      // grade, and libc6 + libc-bin with the same CVE are one vulnerability (same basis as summary / gate / CRA).
      findings: (() => {
        const runningOpen = open.map((o) => ({ o, runs: links.filter((l) => l.findingId === o.f.id).flatMap((l) => sbomToEnvs.get(l.sbomId) ?? []) })).filter((x) => x.runs.length > 0);
        const groups = new Map<string, typeof runningOpen>();
        for (const x of runningOpen) { const k = `${x.o.f.canonicalId ?? x.o.f.advisoryId}|${x.o.f.packageKey ?? x.o.f.componentId}`; groups.set(k, [...(groups.get(k) ?? []), x]); }
        const RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 } as const;
        return [...groups.values()].map((g) => {
          const top = g.reduce((a, b) => (RANK[b.o.f.severity] > RANK[a.o.f.severity] ? b : a));
          const runs = g.flatMap((x) => x.runs);
          const o = top.o;
          return { severity: o.f.severity, kev: o.kev, epss: o.epss, fixAvailable: g.some((x) => !!x.o.f.fixedVersion), inProduction: runs.some((r) => r.kind === 'production'), internetFacing: runs.some((r) => r.internetFacing), runsIn: [...new Set(runs.map((r) => r.kind))], ageDays: Math.floor((now - o.f.firstSeenAt.getTime()) / 86400_000) };
        });
      })(),
      sbomAgeDays: await this.db.select({ createdAt: sboms.createdAt }).from(sboms).where(eq(sboms.serviceId, serviceId)).orderBy(desc(sboms.createdAt)).limit(1).then((r) => (r[0] ? Math.floor((now - r[0].createdAt.getTime()) / 86400_000) : null)),
      environments: envs.map((e) => ({ kind: e.env.kind, internetFacing: e.env.internetFacing, deployed: !!e.d, sbomKnown: !!envSbom.get(e.env.id) })),
    };
    const result = scoreRisk(input);
    const day = dayStart(new Date());
    await this.db.insert(riskScores).values({ serviceId, day, score: result.score, grade: result.grade, factors: result.factors, computedAt: new Date() }).onConflictDoUpdate({ target: [riskScores.serviceId, riskScores.day], set: { score: result.score, grade: result.grade, factors: result.factors, computedAt: new Date() } });
    return { serviceId, ...result };
  }

  /** All services of the organization (or project). */
  async computeAll(organizationId?: string, projectId?: string): Promise<number> {
    const rows = await this.db.select({ id: services.id }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(and(isNull(services.archivedAt), organizationId ? eq(workspaces.organizationId, organizationId) : undefined, projectId ? eq(projects.id, projectId) : undefined));
    for (const r of rows) await this.compute(r.id).catch((e: Error) => this.logger.warn(`risk for ${r.id}: ${e.message}`));
    return rows.length;
  }

  /** Ranking: latest score per service with project context and trend vs 7 days ago. */
  async ranking(organizationId: string, projectId?: ProjectScope) {
    const latest = this.db.selectDistinctOn([riskScores.serviceId], { serviceId: riskScores.serviceId, score: riskScores.score, grade: riskScores.grade, factors: riskScores.factors, day: riskScores.day, computedAt: riskScores.computedAt }).from(riskScores).orderBy(riskScores.serviceId, desc(riskScores.day)).as('latest');
    const weekAgo = new Date(dayStart(new Date()).getTime() - 7 * 86400_000);
    const rows = await this.db
      .select({ serviceId: services.id, serviceName: services.name, serviceSlug: services.slug, serviceCriticality: services.criticality, projectId: projects.id, projectName: projects.name, projectCriticality: projects.criticality, teamName: teams.name, workspaceName: workspaces.name, score: latest.score, grade: latest.grade, factors: latest.factors, computedAt: latest.computedAt })
      .from(services)
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .leftJoin(latest, eq(latest.serviceId, services.id))
      .where(and(eq(workspaces.organizationId, organizationId), isNull(services.archivedAt), projectCondition(projects.id, projectId)))
      .orderBy(desc(latest.score));
    const past = await this.db.select({ serviceId: riskScores.serviceId, score: riskScores.score, day: riskScores.day }).from(riskScores).where(and(inArray(riskScores.serviceId, rows.map((r) => r.serviceId).concat(['00000000-0000-0000-0000-000000000000'])), gte(riskScores.day, new Date(weekAgo.getTime() - 3 * 86400_000)))).orderBy(asc(riskScores.day));
    const weekAgoScore = new Map<string, number>();
    for (const p of past) if (p.day <= weekAgo || !weekAgoScore.has(p.serviceId)) weekAgoScore.set(p.serviceId, p.score);
    return rows.map((r) => ({ ...r, score: r.score ?? null, grade: r.grade ?? null, delta7d: r.score !== null && weekAgoScore.has(r.serviceId) ? r.score - weekAgoScore.get(r.serviceId)! : null }));
  }

  /** Detail: latest factors and 90-day history. */
  async detail(serviceId: string) {
    const history = await this.db.select({ day: riskScores.day, score: riskScores.score, grade: riskScores.grade }).from(riskScores).where(and(eq(riskScores.serviceId, serviceId), gte(riskScores.day, new Date(Date.now() - 90 * 86400_000)))).orderBy(asc(riskScores.day));
    const [latest] = await this.db.select().from(riskScores).where(eq(riskScores.serviceId, serviceId)).orderBy(desc(riskScores.day)).limit(1);
    return { latest: latest ?? null, history: history.map((h) => ({ day: h.day.toISOString().slice(0, 10), score: h.score, grade: h.grade })) };
  }
}
