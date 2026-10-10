import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { projectCondition, ProjectScope } from '../rbac/scope-projects';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { userIdOrNull } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { advisories, components, containerImages, deployments, environments, findings, findingSboms, FindingStatus, imageTags, projects, releases, sboms, services, Severity, teams, workspaces } from '../database/schema';

export interface FindingFilters {
  severity?: Severity[];
  status?: FindingStatus[];
  kev?: boolean;
  q?: string;
  projectId?: ProjectScope;
  serviceId?: string;
  /** only findings whose component runs in some environment now */
  running?: boolean;
  limit?: number;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

@Injectable()
export class FindingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Findings with advisory, component, service/project and "runs in" (environments running an SBOM that contains it). */
  async list(organizationId: string, filters: FindingFilters) {
    const where: (SQL | undefined)[] = [eq(findings.organizationId, organizationId)];
    if (filters.severity?.length) where.push(inArray(findings.severity, filters.severity));
    if (filters.status?.length) where.push(inArray(findings.status, filters.status));
    if (filters.kev) where.push(eq(advisories.kev, true));
    if (filters.serviceId) where.push(eq(findings.serviceId, filters.serviceId));
    const pc = projectCondition(services.projectId, filters.projectId); if (pc) where.push(pc);
    if (filters.q) where.push(or(ilike(advisories.id, `%${filters.q}%`), ilike(components.name, `%${filters.q}%`), sql`exists (select 1 from unnest(${advisories.aliases}) a where a ilike ${`%${filters.q}%`})`));
    const rows = await this.db
      .select({ finding: findings, advisory: advisories, component: components, serviceName: services.name, projectId: projects.id, projectName: projects.name, projectCriticality: projects.criticality })
      .from(findings)
      .innerJoin(advisories, eq(findings.advisoryId, advisories.id))
      .innerJoin(components, eq(findings.componentId, components.id))
      .innerJoin(services, eq(findings.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .where(and(...where.filter((w): w is SQL => !!w)))
      .orderBy(desc(advisories.kev), desc(advisories.cvssScore), desc(findings.firstSeenAt))
      .limit(filters.limit ?? 500);
    const runsIn = await this.runningEnvironments(rows.map((r) => r.finding.id));
    const sources = await this.sourcesOf(rows.map((r) => r.finding.id));
    const out = rows.map((r) => ({
      id: r.finding.id,
      status: r.finding.status,
      severity: r.finding.severity,
      fixedVersion: r.finding.fixedVersion,
      firstSeenAt: r.finding.firstSeenAt,
      lastSeenAt: r.finding.lastSeenAt,
      resolvedAt: r.finding.resolvedAt,
      note: r.finding.note,
      advisory: { id: r.advisory.id, aliases: r.advisory.aliases, summary: r.advisory.summary, severity: r.advisory.severity, severitySource: r.advisory.severitySource ?? null, severityNote: r.advisory.severityNote ?? null, cvssScore: r.advisory.cvssScore, cvssVector: r.advisory.cvssVector, epssScore: r.advisory.epssScore, epssPercentile: r.advisory.epssPercentile, kev: r.advisory.kev, kevDueDate: r.advisory.kevDueDate, publishedAt: r.advisory.publishedAt },
      component: { id: r.component.id, purl: r.component.purl, type: r.component.type, namespace: r.component.namespace, name: r.component.name, version: r.component.version },
      serviceId: r.finding.serviceId,
      serviceName: r.serviceName,
      projectId: r.projectId,
      projectName: r.projectName,
      projectCriticality: r.projectCriticality,
      environments: runsIn.get(r.finding.id) ?? [],
      sources: sources.get(r.finding.id) ?? [],
    }));
    const filtered = filters.running ? out.filter((f) => f.environments.length > 0) : out;
    return filtered.sort((a, b) => (b.environments.some((e) => e.kind === 'production') ? 1 : 0) - (a.environments.some((e) => e.kind === 'production') ? 1 : 0) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (b.advisory.cvssScore ?? 0) - (a.advisory.cvssScore ?? 0));
  }

  /** SBOMs containing each finding, described as sources: the source repository (with release) or an image (name:tag). */
  private async sourcesOf(findingIds: string[]): Promise<Map<string, { sbomId: string; target: string; targetRef: string; releaseVersion: string | null; image: string | null; tag: string | null; createdAt: Date }[]>> {
    const map = new Map<string, { sbomId: string; target: string; targetRef: string; releaseVersion: string | null; image: string | null; tag: string | null; createdAt: Date }[]>();
    if (!findingIds.length) return map;
    const rows = await this.db
      .select({ findingId: findingSboms.findingId, sbomId: sboms.id, target: sboms.target, targetRef: sboms.targetRef, createdAt: sboms.createdAt, releaseVersion: releases.version, imageName: containerImages.name, tag: imageTags.tag })
      .from(findingSboms)
      .innerJoin(sboms, eq(findingSboms.sbomId, sboms.id))
      .leftJoin(releases, eq(sboms.releaseId, releases.id))
      .leftJoin(imageTags, eq(sboms.imageTagId, imageTags.id))
      .leftJoin(containerImages, eq(imageTags.imageId, containerImages.id))
      .where(inArray(findingSboms.findingId, findingIds))
      .orderBy(desc(sboms.createdAt));
    for (const r of rows) {
      const list = map.get(r.findingId) ?? [];
      list.push({ sbomId: r.sbomId, target: r.target, targetRef: r.targetRef, releaseVersion: r.releaseVersion, image: r.imageName ?? (r.target === 'image' ? r.targetRef.split(/[:@]/)[0] : null), tag: r.tag ?? (r.target === 'image' && r.targetRef.includes(':') ? r.targetRef.split(':').pop()! : null), createdAt: r.createdAt });
      map.set(r.findingId, list);
    }
    return map;
  }

  /** Environments currently running an SBOM (release / image tag) that contains each finding. */
  private async runningEnvironments(findingIds: string[]): Promise<Map<string, { id: string; name: string; kind: string; internetFacing: boolean }[]>> {
    const map = new Map<string, { id: string; name: string; kind: string; internetFacing: boolean }[]>();
    if (!findingIds.length) return map;
    // Same resolver as every other view: the SBOM each current deployment runs, by digest (see sbom/running-sbom.ts).
    const links = await this.db.select({ findingId: findingSboms.findingId, sbomId: findingSboms.sbomId, serviceId: findings.serviceId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).where(inArray(findingSboms.findingId, findingIds));
    const bySbom = environmentsBySbom(await resolveRunningSboms(this.db, { serviceIds: [...new Set(links.map((l) => l.serviceId))] }));
    for (const l of links) {
      const list = map.get(l.findingId) ?? [];
      for (const r of bySbom.get(l.sbomId) ?? []) if (!list.some((e) => e.id === r.environmentId)) list.push({ id: r.environmentId, name: r.environmentName, kind: r.environmentKind, internetFacing: r.internetFacing });
      map.set(l.findingId, list);
    }
    return map;
  }

  async serviceOfSbom(sbomId: string): Promise<string> {
    const [b] = await this.db.select({ serviceId: sboms.serviceId }).from(sboms).where(eq(sboms.id, sbomId)).limit(1);
    if (!b) throw new NotFoundException('SBOM not found');
    return b.serviceId;
  }

  async listForSbom(_user: AuthenticatedUser, sbomId: string, status: FindingStatus[]) {
    const [b] = await this.db.select({ organizationId: sboms.organizationId, serviceId: sboms.serviceId }).from(sboms).where(eq(sboms.id, sbomId)).limit(1);
    if (!b) throw new NotFoundException('SBOM not found');
    const ids = (await this.db.select({ id: findingSboms.findingId }).from(findingSboms).where(eq(findingSboms.sbomId, sbomId))).map((r) => r.id);
    if (!ids.length) return [];
    const rows = await this.list(b.organizationId, { serviceId: b.serviceId, status, limit: 1000 });
    const set = new Set(ids);
    const mine = rows.filter((r) => set.has(r.id));
    // fixedIn: for a service-level fixed finding, the oldest later release whose image SBOM no longer links it (same data the VEX uses)
    const fixedIds = mine.filter((r) => r.status === 'fixed').map((r) => r.id);
    const fixedIn = new Map<string, string>();
    if (fixedIds.length) {
      const [thisSbom] = await this.db.select({ createdAt: sboms.createdAt }).from(sboms).where(eq(sboms.id, sbomId)).limit(1);
      const later = await this.db.select({ id: sboms.id, releaseId: sboms.releaseId, imageDigest: sboms.imageDigest, createdAt: sboms.createdAt }).from(sboms).where(and(eq(sboms.serviceId, b.serviceId), eq(sboms.target, 'image'), sql`${sboms.createdAt} > ${thisSbom?.createdAt ?? new Date(0)}`)).orderBy(sboms.createdAt);
      const links = later.length ? await this.db.select({ sbomId: findingSboms.sbomId, findingId: findingSboms.findingId }).from(findingSboms).where(and(inArray(findingSboms.sbomId, later.map((x) => x.id)), inArray(findingSboms.findingId, fixedIds))) : [];
      const versionOf = new Map<string, string>();
      if (later.length) {
        const tagRows = await this.db.select({ digest: imageTags.digest, version: releases.version }).from(imageTags).innerJoin(releases, eq(imageTags.releaseId, releases.id)).where(and(eq(releases.serviceId, b.serviceId), inArray(imageTags.digest, later.map((x) => x.imageDigest).filter((x): x is string => !!x))));
        for (const t of tagRows) if (t.digest && !versionOf.has(t.digest)) versionOf.set(t.digest, t.version);
      }
      for (const fid of fixedIds) {
        const first = later.find((x) => !links.some((l) => l.sbomId === x.id && l.findingId === fid));
        if (first) fixedIn.set(fid, (first.imageDigest && versionOf.get(first.imageDigest)) ?? `sbom ${first.id.slice(0, 8)}`);
      }
    }
    return mine.map((r) => ({ ...r, serviceStatus: r.status, inThisSbom: r.status === 'fixed' ? `affected — fixed in ${fixedIn.get(r.id) ?? 'a later build'}` : 'affected', fixedIn: fixedIn.get(r.id) ?? null }));
  }

  async get(findingId: string) {
    const [row] = await this.db
      .select({ finding: findings, advisory: advisories, component: components, serviceName: services.name, projectId: projects.id, projectName: projects.name })
      .from(findings)
      .innerJoin(advisories, eq(findings.advisoryId, advisories.id))
      .innerJoin(components, eq(findings.componentId, components.id))
      .innerJoin(services, eq(findings.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .where(eq(findings.id, findingId))
      .limit(1);
    if (!row) throw new NotFoundException('Finding not found');
    const affected = await this.db
      .select({ sbomId: sboms.id, target: sboms.target, targetRef: sboms.targetRef, releaseVersion: releases.version, createdAt: sboms.createdAt })
      .from(findingSboms)
      .innerJoin(sboms, eq(findingSboms.sbomId, sboms.id))
      .leftJoin(releases, eq(sboms.releaseId, releases.id))
      .where(eq(findingSboms.findingId, findingId))
      .orderBy(desc(sboms.createdAt));
    const runsIn = await this.runningEnvironments([findingId]);
    return { ...row.finding, advisory: row.advisory, component: row.component, serviceName: row.serviceName, projectId: row.projectId, projectName: row.projectName, affected, environments: runsIn.get(findingId) ?? [] };
  }

  async setStatus(user: AuthenticatedUser, findingId: string, status: FindingStatus, note?: string) {
    const [before] = await this.db.select().from(findings).where(eq(findings.id, findingId)).limit(1);
    if (!before) throw new NotFoundException('Finding not found');
    if (status === 'fixed') throw new ForbiddenException('"fixed" is set by the platform when the vulnerable version is gone');
    const [after] = await this.db.update(findings).set({ status, note: note ?? before.note, statusChangedById: userIdOrNull(user), statusChangedAt: new Date(), resolvedAt: status === 'open' ? null : new Date() }).where(eq(findings.id, findingId)).returning();
    await this.audit.record({ organizationId: before.organizationId, actor: userActor(user), action: 'finding.status_changed', resourceType: 'finding', resourceId: findingId, before: { status: before.status }, after: { status, note: note ?? null, advisory: before.advisoryId } });
    return after;
  }

  /** Every environment with what runs there (release/image + SBOM) and the open findings of that SBOM, for the "Running in" panel. */
  async environments(organizationId: string, projectId?: ProjectScope) {
    const rows = await this.db
      .select({ env: environments, serviceName: services.name, serviceId: services.id, projectId: projects.id, projectName: projects.name, deployment: deployments, releaseVersion: releases.version, imageName: containerImages.name, tag: imageTags.tag, digest: imageTags.digest, imageId: imageTags.imageId })
      .from(environments)
      .innerJoin(services, eq(environments.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .leftJoin(deployments, and(eq(deployments.environmentId, environments.id), isNull(deployments.supersededAt)))
      .leftJoin(releases, eq(deployments.releaseId, releases.id))
      .leftJoin(imageTags, eq(deployments.imageTagId, imageTags.id))
      .leftJoin(containerImages, eq(imageTags.imageId, containerImages.id))
      .where(and(eq(workspaces.organizationId, organizationId), isNull(environments.archivedAt), isNull(services.archivedAt), projectCondition(projects.id, projectId) ?? undefined))
      .orderBy(projects.name, services.name, environments.name);
    // SBOM of what runs, by digest (sbom/running-sbom.ts).
    const runningByDeployment = new Map((await resolveRunningSboms(this.db, { serviceIds: [...new Set(rows.map((r) => r.serviceId))] })).map((x) => [x.deploymentId, x]));
    // A deployment attached to a digest placeholder (`sha256-<12>`) shows the real tag of that digest in the same image:
    // the environment's own tag first, then a version-like tag, then any.
    const placeholderImageIds = [...new Set(rows.filter((r) => r.tag && /^sha256-[0-9a-f]{12}$/.test(r.tag) && r.imageId).map((r) => r.imageId!))];
    const realTags = placeholderImageIds.length ? await this.db.select({ imageId: imageTags.imageId, tag: imageTags.tag, digest: imageTags.digest }).from(imageTags).where(and(inArray(imageTags.imageId, placeholderImageIds), sql`${imageTags.tag} !~ '^sha256-[0-9a-f]{12}$'`)) : [];
    const realTagFor = (imageId: string | null, digest: string | null, envSlug: string) => {
      if (!imageId || !digest) return null;
      const c = realTags.filter((t) => t.imageId === imageId && t.digest === digest);
      return (c.find((t) => t.tag === envSlug) ?? c.find((t) => /^v?\d+(\.\d+)+/.test(t.tag)) ?? c[0])?.tag ?? null;
    };
    const out = [];
    for (const r of rows) {
      let sbomId: string | null = null;
      let sbomTarget: string | null = null;
      let inferred: { image: string; tag: string; digest: string | null } | null = null;
      if (r.deployment) {
        const rs = runningByDeployment.get(r.deployment.id);
        sbomId = rs?.sbomId ?? null;
        sbomTarget = rs?.sbomTarget ?? null;
        // Version-only deployment (no image): show the release's version tag (any registry) as what runs.
        if (!r.deployment.imageTagId && !digestOfRef(r.deployment.imageRef) && r.deployment.releaseId) {
          const rel = await this.db.select({ id: imageTags.id, tag: imageTags.tag, digest: imageTags.digest, image: containerImages.name }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(eq(containerImages.serviceId, r.serviceId), eq(imageTags.releaseId, r.deployment.releaseId)));
          const pick = rel.find((t) => t.tag.replace(/^v(?=\d)/, '') === (r.releaseVersion ?? '')) ?? rel[0];
          if (pick) inferred = { image: pick.image, tag: pick.tag, digest: pick.digest };
        }
      }
      const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
      if (sbomId) {
        const fr = await this.db.select({ severity: findings.severity, n: sql<number>`count(distinct (coalesce(${findings.canonicalId}, ${findings.advisoryId}) || '|' || coalesce(${findings.packageKey}, ${findings.componentId}::text)))` }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).where(and(eq(findingSboms.sbomId, sbomId), eq(findings.status, 'open'))).groupBy(findings.severity);
        for (const x of fr) counts[x.severity] = Number(x.n);
      }
      out.push({ id: r.env.id, name: r.env.name, slug: r.env.slug, kind: r.env.kind, internetFacing: r.env.internetFacing, protected: r.env.settings.protected === true, serviceId: r.serviceId, serviceName: r.serviceName, projectId: r.projectId, projectName: r.projectName, current: r.deployment ? { version: r.deployment.version ?? r.releaseVersion ?? null, image: r.imageName ?? (r.deployment.imageRef ? r.deployment.imageRef.split(/[@]/)[0].split(/:(?=[^/]+$)/)[0] : null) ?? inferred?.image ?? null, tag: r.tag && (!r.imageName || !r.deployment.imageRef || r.deployment.imageRef.toLowerCase().startsWith(r.imageName.toLowerCase())) ? (/^sha256-[0-9a-f]{12}$/.test(r.tag) ? realTagFor(r.imageId ?? null, r.digest ?? null, r.env.slug) ?? r.tag : r.tag) : inferred?.tag ?? null, digest: r.digest ?? (r.deployment.imageRef?.includes('@') ? r.deployment.imageRef.split('@')[1] : null) ?? inferred?.digest ?? null, deployedAt: r.deployment.deployedAt, source: r.deployment.source } : null, sbomId, sbomTarget, findings: counts });
    }
    return out;
  }

  /** Counts for dashboards: open by severity, KEV, and open-in-production by severity. */
  async summary(organizationId: string, projectId?: ProjectScope) {
    const base = projectId ? and(eq(findings.organizationId, organizationId), projectCondition(services.projectId, projectId)) : eq(findings.organizationId, organizationId);
    const rows = await this.db
      .select({ severity: findings.severity, status: findings.status, kev: advisories.kev, n: sql<number>`count(distinct (coalesce(${findings.canonicalId}, ${findings.advisoryId}) || '|' || coalesce(${findings.packageKey}, ${findings.componentId}::text)))` })
      .from(findings)
      .innerJoin(advisories, eq(findings.advisoryId, advisories.id))
      .innerJoin(services, eq(findings.serviceId, services.id))
      .where(and(base, or(eq(findings.running, true), sql`${findings.status} <> 'open'`)))   // open counts = running images only
      .groupBy(findings.severity, findings.status, advisories.kev);
    const open: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    let kev = 0;
    let total = 0;
    let fixed = 0;
    for (const r of rows) {
      const n = Number(r.n);
      total += n;
      if (r.status === 'open') {
        open[r.severity] += n;
        if (r.kev) kev += n;
      }
      if (r.status === 'fixed') fixed += n;
    }
    const prodSbomIds = [...new Set((await resolveRunningSboms(this.db, { organizationId, environmentKinds: ['production'] })).map((r) => r.sbomId).filter((x): x is string => !!x))];
    const prod = prodSbomIds.length ? await this.db
      .select({ severity: findings.severity, n: sql<number>`count(distinct (coalesce(${findings.canonicalId}, ${findings.advisoryId}) || '|' || coalesce(${findings.packageKey}, ${findings.componentId}::text)))` })
      .from(findings)
      .innerJoin(services, eq(findings.serviceId, services.id))
      .innerJoin(findingSboms, eq(findingSboms.findingId, findings.id))
      .where(and(base, eq(findings.status, 'open'), inArray(findingSboms.sbomId, prodSbomIds)))
      .groupBy(findings.severity) : [];
    const production: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    for (const r of prod) production[r.severity] = Number(r.n);
    // Same basis everywhere: counts above are unique (advisory, source package); this is the advisory×package total.
    const [pf] = await this.db.select({ n: sql<number>`count(*)` }).from(findings).innerJoin(services, eq(findings.serviceId, services.id)).where(and(base, eq(findings.status, 'open'), eq(findings.running, true)));
    // Findings of images that run nowhere (still in a registry) stay open but are reported apart, not in `open`.
    const nr = await this.db.select({ severity: findings.severity, n: sql<number>`count(distinct (coalesce(${findings.canonicalId}, ${findings.advisoryId}) || '|' || coalesce(${findings.packageKey}, ${findings.componentId}::text)))` }).from(findings).innerJoin(services, eq(findings.serviceId, services.id)).where(and(base, eq(findings.status, 'open'), eq(findings.running, false))).groupBy(findings.severity);
    const notRunning = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } as Record<Severity, number>;
    for (const r of nr) notRunning[r.severity] = Number(r.n);
    return { open, kev, total, fixed, production, notRunning, unit: 'vulnerabilities (unique advisory per source package) of images that run somewhere', packageFindings: Number(pf?.n ?? 0) };
  }
}
