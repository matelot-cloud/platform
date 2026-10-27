import { getMetrics } from '../telemetry/metrics';
import { uniqueVulnerabilities } from '../vulnerabilities/severity';
import { projectCondition, ProjectScope } from '../rbac/scope-projects';
import { BadRequestException, forwardRef, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CorrelationService } from '../vulnerabilities/correlation.service';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { userIdOrNull, type AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { components, containerImages, findings, findingSboms, imageTags, jobs, projects, releases, Sbom, sbomComponents, sboms, services } from '../database/schema';
import { ParsedSbom, parseSbom } from './parse';
import { digestOfRef, imageDigestFromDocument } from './running-sbom';

const normalizeVersion = (v: string) => v.replace(/^v(?=\d)/, '');

export interface IngestInput {
  organizationId: string;
  serviceId: string;
  source: Sbom['source'];
  target: Sbom['target'];
  targetRef: string;
  document: unknown;
  releaseVersion?: string | null;
  imageRef?: string | null;
  repositoryId?: string | null;
  jobId?: string | null;
  createdBy?: AuthenticatedUser | null;
}

const publicView = (s: Sbom) => {
  const { rawGz: _r, ...rest } = s;
  return rest;
};

@Injectable()
export class SbomService {
  /** The SBOM stored by a pipeline (its sbom job), else the newest source SBOM of the service. */
  async latestForPipeline(serviceId: string, pipelineId: string | null) {
    if (pipelineId) {
      const [byPipeline] = await this.db.select({ id: sboms.id, componentCount: sboms.componentCount }).from(sboms).innerJoin(jobs, eq(sboms.jobId, jobs.id)).where(and(eq(sboms.serviceId, serviceId), eq(jobs.pipelineId, pipelineId))).orderBy(desc(sboms.createdAt)).limit(1);
      if (byPipeline) return byPipeline;
    }
    const [latest] = await this.db.select({ id: sboms.id, componentCount: sboms.componentCount }).from(sboms).where(and(eq(sboms.serviceId, serviceId), eq(sboms.target, 'source'))).orderBy(desc(sboms.createdAt)).limit(1);
    return latest ?? null;
  }
  /** Open findings linked to an SBOM, unique per (canonical advisory, source package), by severity. */
  async findingSummary(sbomId: string): Promise<Record<'critical' | 'high' | 'medium' | 'low' | 'unknown', number> & { packages: number }> {
    const rows = await this.db.select({ severity: findings.severity, advisoryId: findings.advisoryId, canonicalId: findings.canonicalId, packageKey: findings.packageKey, componentId: findings.componentId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).where(and(eq(findingSboms.sbomId, sbomId), eq(findings.status, 'open')));
    const u = uniqueVulnerabilities(rows);
    const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, packages: u.packages };
    for (const r of u.unique) c[r.severity]++;
    return c;
  }

  private readonly logger = new Logger(SbomService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    @Optional() @Inject(forwardRef(() => CorrelationService)) private readonly correlation?: CorrelationService,
  ) {}

  async onModuleInit() {
    // Backfill image_digest for image SBOMs stored before migration 0030, from the documents themselves.
    // A stale tag link is never used as the source: a document that does not name its digest stays unresolved.
    setTimeout(() => void this.backfillImageDigests().catch(() => undefined), 5_000).unref?.();
  }

  async backfillImageDigests(batch = 200): Promise<number> {
    let done = 0;
    for (;;) {
      const rows = await this.db.select({ id: sboms.id, rawGz: sboms.rawGz }).from(sboms).where(and(eq(sboms.target, 'image'), isNull(sboms.imageDigest), sql`true`)).limit(batch);
      if (!rows.length) return done;
      for (const r of rows) {
        let digest: string | null = null;
        try { digest = imageDigestFromDocument(JSON.parse(gunzipSync(r.rawGz).toString('utf8'))); } catch { /* unreadable document */ }
        if (digest) { await this.db.update(sboms).set({ imageDigest: digest }).where(eq(sboms.id, r.id)); done++; }
        else await this.db.update(sboms).set({ imageDigest: 'unknown' }).where(eq(sboms.id, r.id));
      }
    }
  }

  /** Stores a document, normalizes its components, links it to the release / image tag it describes. */
  async ingest(input: IngestInput) {
    const started = process.hrtime.bigint();
    try { return await this.ingestTimed(input); }
    finally { getMetrics().sbomIngestDuration.record(Number(process.hrtime.bigint() - started) / 1e9, { source: input.source }); }
  }

  private async ingestTimed(input: IngestInput) {
    const raw = Buffer.from(JSON.stringify(input.document));
    if (raw.length > 30 * 1024 * 1024) throw new BadRequestException('SBOM larger than 30 MB');
    let parsed: ParsedSbom;
    try {
      parsed = parseSbom(input.document);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const digest = createHash('sha256').update(raw).digest('hex');
    const [existing] = await this.db.select().from(sboms).where(and(eq(sboms.serviceId, input.serviceId), eq(sboms.digest, digest))).limit(1);
    if (existing) return { ...publicView(existing), deduplicated: true };

    const releaseId = await this.resolveRelease(input.serviceId, input.releaseVersion ?? null, input.targetRef, input.target);
    const imageTagId = input.imageRef ? await this.resolveImageTag(input.serviceId, input.imageRef) : null;
    // The digest this image SBOM describes: the ref's @sha256, else what the document says, else the tag's digest right now (at scan time).
    let imageDigest: string | null = null;
    if (input.target === 'image') {
      imageDigest = digestOfRef(input.imageRef) ?? digestOfRef(input.targetRef) ?? imageDigestFromDocument(input.document);
      if (!imageDigest && imageTagId) imageDigest = (await this.db.select({ d: imageTags.digest }).from(imageTags).where(eq(imageTags.id, imageTagId)).limit(1))[0]?.d ?? null;
    }

    const [sbom] = await this.db
      .insert(sboms)
      .values({
        organizationId: input.organizationId,
        serviceId: input.serviceId,
        releaseId,
        imageTagId,
        imageDigest,
        repositoryId: input.repositoryId ?? null,
        jobId: input.jobId ?? null,
        source: input.source,
        target: input.target,
        targetRef: input.targetRef,
        format: parsed.format,
        specVersion: parsed.specVersion,
        tool: parsed.tool,
        componentCount: parsed.components.length,
        digest,
        rawGz: gzipSync(raw),
        generatedAt: parsed.generatedAt ? new Date(parsed.generatedAt) : new Date(),
        createdById: userIdOrNull(input.createdBy),
      })
      .returning();

    // Component catalog: upsert by purl in batches, then link.
    const uniq = new Map(parsed.components.map((c) => [c.purl, c]));
    const list = [...uniq.values()];
    for (let i = 0; i < list.length; i += 500) {
      const batch = list.slice(i, i + 500);
      await this.db.insert(components).values(batch.map((c) => ({ purl: c.purl, type: c.type, namespace: c.namespace, name: c.name, version: c.version }))).onConflictDoNothing();
      const rows = await this.db.select({ id: components.id, purl: components.purl }).from(components).where(inArray(components.purl, batch.map((c) => c.purl)));
      const idByPurl = new Map(rows.map((r) => [r.purl, r.id]));
      await this.db.insert(sbomComponents).values(batch.map((c) => ({ sbomId: sbom.id, componentId: idByPurl.get(c.purl)!, direct: c.direct, licenses: c.licenses, locations: c.locations }))).onConflictDoNothing();
    }
    await this.audit.record({ organizationId: input.organizationId, actor: input.createdBy ? userActor(input.createdBy) : SYSTEM_ACTOR, action: 'sbom.ingested', resourceType: 'sbom', resourceId: sbom.id, after: { target: input.target, targetRef: input.targetRef, components: parsed.components.length, releaseId, format: parsed.format } });
    // Findings follow the SBOM: correlate this service right away (new components are queried, known ones reused).
    // Always: even when every component was checked recently the new SBOM must get its findings linked. Queued, never dropped.
    if (this.correlation) this.correlation.request({ serviceId: input.serviceId });
    return { ...publicView(sbom), deduplicated: false };
  }

  private async resolveRelease(serviceId: string, version: string | null, targetRef: string, target: Sbom['target']): Promise<string | null> {
    let v = version ? normalizeVersion(version) : null;
    if (!v && target === 'source' && targetRef.includes('@')) v = normalizeVersion(targetRef.split('@').pop()!);
    if (!v && target === 'image' && targetRef.includes(':') && !targetRef.includes('@')) v = normalizeVersion(targetRef.split(':').pop()!);
    if (!v) return null;
    const [rel] = await this.db.select({ id: releases.id }).from(releases).where(and(eq(releases.serviceId, serviceId), eq(releases.version, v))).limit(1);
    return rel?.id ?? null;
  }

  private async resolveImageTag(serviceId: string, imageRef: string): Promise<string | null> {
    const [name, tagOrDigest] = imageRef.includes('@') ? imageRef.split('@') : imageRef.split(/:(?=[^/]+$)/);
    const [img] = await this.db.select({ id: containerImages.id }).from(containerImages).where(and(eq(containerImages.serviceId, serviceId), eq(containerImages.name, name.toLowerCase()))).limit(1);
    if (!img || !tagOrDigest) return null;
    const [t] = await this.db.select({ id: imageTags.id }).from(imageTags).where(and(eq(imageTags.imageId, img.id), imageRef.includes('@') ? eq(imageTags.digest, tagOrDigest) : eq(imageTags.tag, tagOrDigest))).limit(1);
    return t?.id ?? null;
  }

  listForService(serviceId: string) {
    return this.db
      .select({ sbom: sboms, releaseVersion: releases.version })
      .from(sboms)
      .leftJoin(releases, eq(sboms.releaseId, releases.id))
      .where(eq(sboms.serviceId, serviceId))
      .orderBy(desc(sboms.createdAt))
      .limit(100)
      .then((rows) => rows.map((r) => ({ ...publicView(r.sbom), releaseVersion: r.releaseVersion })));
  }

  async get(sbomId: string) {
    const [sbom] = await this.db.select().from(sboms).where(eq(sboms.id, sbomId)).limit(1);
    if (!sbom) throw new NotFoundException('SBOM not found');
    return sbom;
  }

  async componentsOf(sbomId: string, q?: string) {
    const rows = await this.db
      .select({ component: components, direct: sbomComponents.direct, licenses: sbomComponents.licenses, locations: sbomComponents.locations })
      .from(sbomComponents)
      .innerJoin(components, eq(sbomComponents.componentId, components.id))
      .where(and(eq(sbomComponents.sbomId, sbomId), q ? or(ilike(components.name, `%${q}%`), ilike(components.purl, `%${q}%`)) : undefined))
      .orderBy(components.type, components.name);
    return rows.map((r) => ({ ...r.component, direct: r.direct, licenses: r.licenses, locations: r.locations }));
  }

  async raw(sbomId: string): Promise<Buffer> {
    const sbom = await this.get(sbomId);
    return gunzipSync(Buffer.from(sbom.rawGz));
  }

  /** What changed between two SBOMs of the same service: added, removed, version changes. */
  async diff(fromId: string, toId: string) {
    const [from, to] = await Promise.all([this.componentsOf(fromId), this.componentsOf(toId)]);
    const key = (c: { type: string; namespace: string | null; name: string }) => `${c.type}:${c.namespace ?? ''}:${c.name}`;
    const a = new Map(from.map((c) => [key(c), c]));
    const b = new Map(to.map((c) => [key(c), c]));
    const added = [...b.values()].filter((c) => !a.has(key(c)));
    const removed = [...a.values()].filter((c) => !b.has(key(c)));
    const changed = [...b.values()].filter((c) => a.has(key(c)) && a.get(key(c))!.version !== c.version).map((c) => ({ ...c, previousVersion: a.get(key(c))!.version }));
    return { added, removed, changed, unchanged: to.length - added.length - changed.length };
  }

  /** "Which services contain X?" across the organization, using the latest SBOM per service. */
  async search(organizationId: string, q: string, limit = 200, projectScope?: ProjectScope) {
    const scopedServices = projectScope ? (await this.db.select({ id: services.id }).from(services).where(projectCondition(services.projectId, projectScope)!)).map((x) => x.id) : null;
    const latest = this.db
      .select({ id: sboms.id, serviceId: sboms.serviceId, rn: sql<number>`row_number() over (partition by ${sboms.serviceId}, ${sboms.target} order by ${sboms.createdAt} desc)`.as('rn') })
      .from(sboms)
      .where(and(eq(sboms.organizationId, organizationId), scopedServices ? (scopedServices.length ? inArray(sboms.serviceId, scopedServices) : eq(sboms.serviceId, '00000000-0000-0000-0000-000000000000')) : undefined))
      .as('latest');
    const rows = await this.db
      .select({ component: components, sbomId: sboms.id, target: sboms.target, targetRef: sboms.targetRef, serviceId: services.id, serviceName: services.name, projectId: projects.id, projectName: projects.name, releaseVersion: releases.version, licenses: sbomComponents.licenses })
      .from(sbomComponents)
      .innerJoin(components, eq(sbomComponents.componentId, components.id))
      .innerJoin(sboms, eq(sbomComponents.sbomId, sboms.id))
      .innerJoin(latest, and(eq(latest.id, sboms.id), eq(latest.rn, 1)))
      .innerJoin(services, eq(sboms.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .leftJoin(releases, eq(sboms.releaseId, releases.id))
      .where(and(eq(sboms.organizationId, organizationId), or(ilike(components.name, `%${q}%`), ilike(components.purl, `%${q}%`))))
      .orderBy(components.name, components.version)
      .limit(limit);
    return rows.map((r) => ({ ...r.component, sbomId: r.sbomId, target: r.target, targetRef: r.targetRef, serviceId: r.serviceId, serviceName: r.serviceName, projectId: r.projectId, projectName: r.projectName, releaseVersion: r.releaseVersion, licenses: r.licenses }));
  }

  /** Per-project counts for the overview. */
  async projectSummary(projectId: string) {
    const svc = await this.db.select({ id: services.id }).from(services).where(and(eq(services.projectId, projectId), isNull(services.archivedAt)));
    const ids = svc.map((s) => s.id);
    if (!ids.length) return { sboms: 0, components: 0 };
    const [[a], [b]] = await Promise.all([
      this.db.select({ n: sql<number>`count(*)` }).from(sboms).where(inArray(sboms.serviceId, ids)),
      this.db.select({ n: sql<number>`count(distinct ${sbomComponents.componentId})` }).from(sbomComponents).innerJoin(sboms, eq(sbomComponents.sbomId, sboms.id)).where(inArray(sboms.serviceId, ids)),
    ]);
    return { sboms: Number(a.n), components: Number(b.n) };
  }
}
