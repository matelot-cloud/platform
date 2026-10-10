import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { deployments, environments, imageTags, pipelines, projects, releases, runnerPools, runners, sboms, services, teams, workspaces } from '../database/schema';

/** Aggregated numbers for dashboards; one round of small queries per call, no per-row fan-out. */
@Injectable()
export class OverviewService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async organization(organizationId: string) {
    const since24h = new Date(Date.now() - 24 * 3600_000);
    const since7d = new Date(Date.now() - 7 * 24 * 3600_000);
    const [[counts], envKinds, prodRows, pipeRows, runnerRows, [sbomCov], recent] = await Promise.all([
      this.db
        .select({
          workspaces: sql<number>`(select count(*) from workspaces w where w.organization_id = ${organizationId} and w.archived_at is null)`,
          teams: sql<number>`(select count(*) from teams t join workspaces w on w.id = t.workspace_id where w.organization_id = ${organizationId} and t.archived_at is null)`,
          projects: sql<number>`(select count(*) from projects p join teams t on t.id = p.team_id join workspaces w on w.id = t.workspace_id where w.organization_id = ${organizationId} and p.archived_at is null)`,
          services: sql<number>`(select count(*) from services s join projects p on p.id = s.project_id join teams t on t.id = p.team_id join workspaces w on w.id = t.workspace_id where w.organization_id = ${organizationId} and s.archived_at is null)`,
          releases7d: sql<number>`(select count(*) from releases r where r.organization_id = ${organizationId} and r.created_at >= ${since7d})`,
        })
        .from(sql`(select 1) as one`),
      this.db.select({ kind: environments.kind, internetFacing: environments.internetFacing, n: sql<number>`count(*)` }).from(environments).innerJoin(services, eq(environments.serviceId, services.id)).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(and(eq(workspaces.organizationId, organizationId), isNull(environments.archivedAt))).groupBy(environments.kind, environments.internetFacing),
      this.db
        .select({ deployment: deployments, environment: environments, service: services, project: projects, releaseVersion: releases.version, sbomCount: sql<number>`(select count(*) from sboms b where (b.release_id = ${deployments.releaseId} and ${deployments.releaseId} is not null) or (b.image_tag_id = ${deployments.imageTagId} and ${deployments.imageTagId} is not null))` })
        .from(deployments)
        .innerJoin(environments, eq(deployments.environmentId, environments.id))
        .innerJoin(services, eq(environments.serviceId, services.id))
        .innerJoin(projects, eq(services.projectId, projects.id))
        .leftJoin(releases, eq(deployments.releaseId, releases.id))
        .where(and(eq(deployments.organizationId, organizationId), isNull(deployments.supersededAt), eq(environments.kind, 'production'), isNull(services.archivedAt)))
        .orderBy(desc(deployments.deployedAt))
        .limit(50),
      this.db.select({ status: pipelines.status, n: sql<number>`count(*)` }).from(pipelines).where(and(eq(pipelines.organizationId, organizationId), gte(pipelines.createdAt, since24h))).groupBy(pipelines.status),
      this.db.select({ status: runners.status, n: sql<number>`count(*)` }).from(runners).innerJoin(runnerPools, eq(runners.poolId, runnerPools.id)).where(eq(runnerPools.organizationId, organizationId)).groupBy(runners.status),
      this.db
        .select({
          servicesWithSbom: sql<number>`count(distinct ${sboms.serviceId})`,
          sboms: sql<number>`count(*)`,
        })
        .from(sboms)
        .where(eq(sboms.organizationId, organizationId)),
      this.db
        .select({ pipeline: pipelines, serviceName: services.name, projectId: projects.id, projectName: projects.name })
        .from(pipelines)
        .innerJoin(services, eq(pipelines.serviceId, services.id))
        .innerJoin(projects, eq(services.projectId, projects.id))
        .where(eq(pipelines.organizationId, organizationId))
        .orderBy(desc(pipelines.createdAt))
        .limit(8),
    ]);
    const env = { total: 0, production: 0, internetFacing: 0 };
    for (const r of envKinds) {
      env.total += Number(r.n);
      if (r.kind === 'production') env.production += Number(r.n);
      if (r.internetFacing) env.internetFacing += Number(r.n);
    }
    const pipe = { total: 0, succeeded: 0, failed: 0, running: 0 };
    for (const r of pipeRows) {
      const n = Number(r.n);
      pipe.total += n;
      if (r.status === 'succeeded') pipe.succeeded += n;
      else if (r.status === 'failed') pipe.failed += n;
      else if (r.status === 'running' || r.status === 'created') pipe.running += n;
    }
    const run = { online: 0, offline: 0, total: 0 };
    for (const r of runnerRows) {
      const n = Number(r.n);
      run.total += n;
      if (r.status === 'online') run.online += n;
      else run.offline += n;
    }
    return {
      counts: { ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])), environments: env.total, productionEnvironments: env.production, internetFacing: env.internetFacing },
      pipelines24h: pipe,
      runners: run,
      sbom: { services: Number(sbomCov.servicesWithSbom), documents: Number(sbomCov.sboms), coverage: Number(counts.services) ? Math.round((Number(sbomCov.servicesWithSbom) / Number(counts.services)) * 100) : 0 },
      production: prodRows.map((r) => ({ deploymentId: r.deployment.id, projectId: r.project.id, projectName: r.project.name, projectCriticality: r.project.criticality, serviceId: r.service.id, serviceName: r.service.name, environmentId: r.environment.id, environmentName: r.environment.name, internetFacing: r.environment.internetFacing, version: r.deployment.version ?? r.releaseVersion ?? null, imageRef: r.deployment.imageRef, source: r.deployment.source, deployedAt: r.deployment.deployedAt, hasSbom: Number(r.sbomCount) > 0 })),
      recentPipelines: recent.map((r) => ({ id: r.pipeline.id, number: r.pipeline.number, status: r.pipeline.status, name: r.pipeline.name, ref: r.pipeline.ref, trigger: r.pipeline.trigger, createdAt: r.pipeline.createdAt, serviceName: r.serviceName, projectId: r.projectId, projectName: r.projectName })),
    };
  }

  async project(projectId: string) {
    const svc = await this.db.select().from(services).where(and(eq(services.projectId, projectId), isNull(services.archivedAt))).orderBy(services.name);
    const ids = svc.map((s) => s.id);
    if (!ids.length) return { services: [], environments: [], pipelines: [], stats: { services: 0, environments: 0, internetFacing: 0, releases: 0, images: 0, sboms: 0, pipelines: { total: 0, succeeded: 0, failed: 0 } } };
    const [envs, current, pipes, [stats]] = await Promise.all([
      this.db.select().from(environments).where(and(inArray(environments.serviceId, ids), isNull(environments.archivedAt))).orderBy(environments.name),
      this.db.select({ deployment: deployments, releaseVersion: releases.version, releaseCommit: releases.commitSha, tag: imageTags.tag, digest: imageTags.digest }).from(deployments).leftJoin(releases, eq(deployments.releaseId, releases.id)).leftJoin(imageTags, eq(deployments.imageTagId, imageTags.id)).where(and(inArray(deployments.serviceId, ids), isNull(deployments.supersededAt))),
      this.db.select({ pipeline: pipelines, serviceName: services.name }).from(pipelines).innerJoin(services, eq(pipelines.serviceId, services.id)).where(inArray(pipelines.serviceId, ids)).orderBy(desc(pipelines.createdAt)).limit(10),
      this.db
        .select({
          releases: sql<number>`(select count(*) from releases r where r.service_id in ${ids})`,
          images: sql<number>`(select count(*) from image_tags t join container_images i on i.id = t.image_id where i.service_id in ${ids})`,
          sboms: sql<number>`(select count(*) from sboms b where b.service_id in ${ids})`,
          pipelines: sql<number>`(select count(*) from pipelines pl where pl.service_id in ${ids})`,
          succeeded: sql<number>`(select count(*) from pipelines pl where pl.service_id in ${ids} and pl.status = 'succeeded')`,
          failed: sql<number>`(select count(*) from pipelines pl where pl.service_id in ${ids} and pl.status = 'failed')`,
        })
        .from(sql`(select 1) as one`),
    ]);
    const sbomByRelease = new Set((await this.db.select({ releaseId: sboms.releaseId, imageTagId: sboms.imageTagId }).from(sboms).where(inArray(sboms.serviceId, ids))).flatMap((b) => [b.releaseId, b.imageTagId].filter((x): x is string => !!x)));
    return {
      services: svc.map((s) => ({ id: s.id, name: s.name, slug: s.slug, kind: s.kind })),
      environments: envs.map((e) => {
        const d = current.find((x) => x.deployment.environmentId === e.id);
        return { id: e.id, serviceId: e.serviceId, name: e.name, slug: e.slug, kind: e.kind, internetFacing: e.internetFacing, protected: e.settings.protected === true, current: d ? { version: d.deployment.version ?? d.releaseVersion ?? null, commit: d.releaseCommit ?? null, tag: d.tag ?? null, digest: d.digest ?? null, imageRef: d.deployment.imageRef, source: d.deployment.source, deployedAt: d.deployment.deployedAt, hasSbom: !!((d.deployment.releaseId && sbomByRelease.has(d.deployment.releaseId)) || (d.deployment.imageTagId && sbomByRelease.has(d.deployment.imageTagId))) } : null };
      }),
      pipelines: pipes.map((p) => ({ id: p.pipeline.id, number: p.pipeline.number, status: p.pipeline.status, name: p.pipeline.name, ref: p.pipeline.ref, trigger: p.pipeline.trigger, createdAt: p.pipeline.createdAt, finishedAt: p.pipeline.finishedAt, serviceName: p.serviceName })),
      stats: { services: svc.length, environments: envs.length, internetFacing: envs.filter((e) => e.internetFacing).length, releases: Number(stats.releases), images: Number(stats.images), sboms: Number(stats.sboms), pipelines: { total: Number(stats.pipelines), succeeded: Number(stats.succeeded), failed: Number(stats.failed) } },
    };
  }
}
