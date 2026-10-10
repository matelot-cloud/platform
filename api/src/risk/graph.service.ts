import { Inject, Injectable } from '@nestjs/common';
import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { containerImages, deployments, environments, findings, findingSboms, imageTags, projects, releases, repositories, riskScores, sboms, serviceRepositories, services } from '../database/schema';

export interface GraphNode {
  id: string;
  type: 'project' | 'service' | 'repository' | 'release' | 'image' | 'environment' | 'sbom';
  label: string;
  sub?: string;
  data: Record<string, unknown>;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: 'has_service' | 'has_repository' | 'has_release' | 'built_image' | 'deployed_to' | 'described_by';
}

/** The Product Security Graph of a project: what exists, what runs where, and the findings attached. */
@Injectable()
export class GraphService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async project(projectId: string): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return { nodes: [], edges: [] };
    const nodes: GraphNode[] = [{ id: `project:${project.id}`, type: 'project', label: project.name, sub: project.criticality.toLowerCase(), data: { criticality: project.criticality } }];
    const edges: GraphEdge[] = [];
    const svcs = await this.db.select().from(services).where(and(eq(services.projectId, projectId), isNull(services.archivedAt)));
    if (!svcs.length) return { nodes, edges };
    const ids = svcs.map((s) => s.id);
    const latestRisk = await this.db.selectDistinctOn([riskScores.serviceId], { serviceId: riskScores.serviceId, score: riskScores.score, grade: riskScores.grade }).from(riskScores).where(inArray(riskScores.serviceId, ids)).orderBy(riskScores.serviceId, desc(riskScores.day));
    const riskOf = new Map(latestRisk.map((r) => [r.serviceId, r]));
    const openCounts = await this.db.select({ serviceId: findings.serviceId, severity: findings.severity, n: sql<number>`count(distinct (coalesce(${findings.canonicalId}, ${findings.advisoryId}) || '|' || coalesce(${findings.packageKey}, ${findings.componentId}::text)))`, packages: sql<number>`count(*)` }).from(findings).where(and(inArray(findings.serviceId, ids), eq(findings.status, 'open'), eq(findings.running, true))).groupBy(findings.serviceId, findings.severity);
    const packagesOf = (serviceId: string) => openCounts.filter((r) => r.serviceId === serviceId).reduce((n, r) => n + Number(r.packages), 0);
    const countsOf = (serviceId: string) => { const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }; for (const r of openCounts) if (r.serviceId === serviceId) c[r.severity] = Number(r.n); return c; };
    for (const s of svcs) {
      const risk = riskOf.get(s.id);
      nodes.push({ id: `service:${s.id}`, type: 'service', label: s.name, sub: s.criticality ? s.criticality.toLowerCase() : undefined, data: { serviceId: s.id, packageFindings: packagesOf(s.id), risk: risk?.score ?? null, grade: risk?.grade ?? null, findings: countsOf(s.id) } });
      edges.push({ from: `project:${project.id}`, to: `service:${s.id}`, kind: 'has_service' });
    }
    // repositories
    const repos = await this.db.select({ serviceId: serviceRepositories.serviceId, role: serviceRepositories.role, repo: repositories }).from(serviceRepositories).innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id)).where(inArray(serviceRepositories.serviceId, ids));
    for (const r of repos) {
      const id = `repository:${r.repo.id}`;
      if (!nodes.some((n) => n.id === id)) nodes.push({ id, type: 'repository', label: r.repo.fullName, sub: r.repo.defaultBranch ?? undefined, data: { url: r.repo.htmlUrl } });
      edges.push({ from: `service:${r.serviceId}`, to: id, kind: 'has_repository' });
    }
    // environments + current deployment
    const envs = await this.db.select({ env: environments, d: deployments, releaseVersion: releases.version, tag: imageTags.tag, digest: imageTags.digest, imageName: containerImages.name }).from(environments).leftJoin(deployments, and(eq(deployments.environmentId, environments.id), isNull(deployments.supersededAt))).leftJoin(releases, eq(deployments.releaseId, releases.id)).leftJoin(imageTags, eq(deployments.imageTagId, imageTags.id)).leftJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(inArray(environments.serviceId, ids), isNull(environments.archivedAt)));
    // SBOM findings per sbom (open)
    const sbomRows = await this.db.select({ id: sboms.id, imageDigest: sboms.imageDigest, serviceId: sboms.serviceId, target: sboms.target, targetRef: sboms.targetRef, releaseId: sboms.releaseId, imageTagId: sboms.imageTagId, componentCount: sboms.componentCount, createdAt: sboms.createdAt }).from(sboms).where(inArray(sboms.serviceId, ids)).orderBy(desc(sboms.createdAt));
    const sbomFindings = sbomRows.length ? await this.db.select({ sbomId: findingSboms.sbomId, severity: findings.severity, n: sql<number>`count(distinct (coalesce(${findings.canonicalId}, ${findings.advisoryId}) || '|' || coalesce(${findings.packageKey}, ${findings.componentId}::text)))`, packages: sql<number>`count(*)` }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).where(and(inArray(findingSboms.sbomId, sbomRows.map((b) => b.id)), eq(findings.status, 'open'))).groupBy(findingSboms.sbomId, findings.severity) : [];
    const sbomCounts = (sbomId: string) => { const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }; for (const r of sbomFindings) if (r.sbomId === sbomId) c[r.severity] = Number(r.n); return c; };
    // releases (recent 5 per service) and images (tags currently deployed + recent)
    const rels = await this.db.select().from(releases).where(inArray(releases.serviceId, ids)).orderBy(desc(releases.createdAt));
    const perService = new Map<string, number>();
    for (const r of rels) {
      const n = perService.get(r.serviceId) ?? 0;
      const deployed = envs.some((e) => e.d?.releaseId === r.id);
      if (n >= 5 && !deployed) continue;
      perService.set(r.serviceId, n + 1);
      const sbom = sbomRows.find((b) => b.releaseId === r.id && b.target === 'source');
      nodes.push({ id: `release:${r.id}`, type: 'release', label: r.version, sub: r.commitSha ? r.commitSha.slice(0, 8) : undefined, data: { releaseId: r.id, commitSha: r.commitSha, sbomId: sbom?.id ?? null, findings: sbom ? sbomCounts(sbom.id) : null, deployed } });
      edges.push({ from: `service:${r.serviceId}`, to: `release:${r.id}`, kind: 'has_release' });
    }
    const tags = await this.db.select({ tag: imageTags, image: containerImages }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(inArray(containerImages.serviceId, ids)).orderBy(desc(imageTags.builtAt));
    const depDigest = (e: (typeof envs)[number]) => e.digest ?? (e.d?.imageRef?.includes('@sha256:') ? e.d.imageRef.split('@')[1] : null);
    // A digest is one image, whatever registry or tag it was pushed under: tags without a release inherit it from a same-digest tag that has one.
    const releaseByDigest = new Map<string, string>();
    for (const t of tags) if (t.tag.releaseId && t.tag.digest) releaseByDigest.set(t.tag.digest, t.tag.releaseId);
    const perImage = new Map<string, number>();
    for (const t of tags) {
      const n = perImage.get(t.image.id) ?? 0;
      const deployed = envs.some((e) => e.d?.imageTagId === t.tag.id || (!!depDigest(e) && depDigest(e) === t.tag.digest));
      if (n >= 3 && !deployed) continue;
      perImage.set(t.image.id, n + 1);
      const sbom = t.tag.digest ? sbomRows.find((b) => b.imageDigest === t.tag.digest!.toLowerCase()) : undefined;
      nodes.push({ id: `image:${t.tag.id}`, type: 'image', label: `${t.image.name.split('/').slice(-1)[0]}:${/^[0-9a-f]{12,}$/i.test(t.tag.tag) ? t.tag.tag.slice(0, 12) : t.tag.tag}`, sub: t.image.name.split('/')[0], data: { image: t.image.name, tag: t.tag.tag, digest: t.tag.digest, sbomId: sbom?.id ?? null, findings: sbom ? sbomCounts(sbom.id) : null, deployed, releaseId: t.tag.releaseId } });
      const releaseId = t.tag.releaseId ?? (t.tag.digest ? releaseByDigest.get(t.tag.digest) : undefined);
      const releaseShown = !!releaseId && nodes.some((n) => n.id === `release:${releaseId}`);
      edges.push({ from: releaseShown ? `release:${releaseId}` : `service:${t.image.serviceId}`, to: `image:${t.tag.id}`, kind: 'built_image' });
    }
    const runningByDeployment = new Map((await resolveRunningSboms(this.db, { serviceIds: [...new Set(envs.map((x) => x.env.serviceId))] })).map((x) => [x.deploymentId, x]));
    for (const e of envs) {
      const id = `environment:${e.env.id}`;
      const runningSbom = e.d ? sbomRows.find((b) => b.id === runningByDeployment.get(e.d!.id)?.sbomId) ?? null : null;
      nodes.push({ id, type: 'environment', label: e.env.name, sub: e.env.kind, data: { environmentId: e.env.id, kind: e.env.kind, internetFacing: e.env.internetFacing, protected: e.env.settings.protected === true, version: e.d?.version ?? e.releaseVersion ?? null, image: e.imageName ? `${e.imageName}:${e.tag ?? ''}` : (e.d?.imageRef ?? null), deployedAt: e.d?.deployedAt ?? null, findings: runningSbom ? sbomCounts(runningSbom.id) : null, sbomId: runningSbom?.id ?? null } });
      edges.push({ from: `service:${e.env.serviceId}`, to: id, kind: 'has_service' });
      const digest = depDigest(e);
      const repo = e.d?.imageRef ? e.d.imageRef.split('@')[0].replace(/:[^/:]+$/, '') : null;
      // Same digest: prefer the tag of the very image that was reported, else any registry holding that digest.
      const byDigest = digest ? (tags.find((t) => t.tag.digest === digest && t.image.name === repo && nodes.some((n) => n.id === `image:${t.tag.id}`)) ?? tags.find((t) => t.tag.digest === digest && nodes.some((n) => n.id === `image:${t.tag.id}`))) : undefined;
      if (e.d?.imageTagId && nodes.some((n) => n.id === `image:${e.d!.imageTagId}`)) edges.push({ from: `image:${e.d.imageTagId}`, to: id, kind: 'deployed_to' });
      else if (byDigest) edges.push({ from: `image:${byDigest.tag.id}`, to: id, kind: 'deployed_to' });
      else if (e.d?.releaseId && nodes.some((n) => n.id === `release:${e.d!.releaseId}`)) edges.push({ from: `release:${e.d.releaseId}`, to: id, kind: 'deployed_to' });
    }
    return { nodes, edges };
  }
}
