import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../database/database.module';
import { containerImages, deployments, environments, imageTags, sboms } from '../database/schema';

/**
 * "What runs where", resolved once for every view (findings, remediation, CRA, risk, graph, snapshots, summary).
 *
 * An image SBOM describes an image DIGEST (stored in `sboms.image_digest`), not a tag: tags move, digests do not.
 * The digest a deployment runs is the `@sha256:` it recorded; only when it recorded a tag do we fall back to the
 * tag's current digest. An image SBOM is used only when its image_digest equals that digest — a tag that moved
 * keeps no stale SBOM, and the same digest scanned under any tag or registry is reused.
 * Without any digest (version-only deployment), the release's image digests, then the release's source SBOM.
 */
export interface RunningSbom {
  deploymentId: string;
  environmentId: string;
  environmentName: string;
  environmentKind: string;
  internetFacing: boolean;
  serviceId: string;
  digest: string | null;
  sbomId: string | null;
  sbomTarget: string | null;
  via: 'digest' | 'release-image' | 'release-source' | null;
}

const SHA = /@(sha256:[0-9a-f]{64})/i;
export const digestOfRef = (ref: string | null | undefined): string | null => (ref ? SHA.exec(ref)?.[1]?.toLowerCase() ?? null : null);

export async function resolveRunningSboms(db: Database, filter: { serviceIds?: string[]; organizationId?: string; environmentKinds?: string[]; environmentIds?: string[] }): Promise<RunningSbom[]> {
  if (filter.serviceIds && filter.serviceIds.length === 0) return [];
  const rows = await db
    .select({ d: deployments, env: environments, tagDigest: imageTags.digest })
    .from(deployments)
    .innerJoin(environments, and(eq(deployments.environmentId, environments.id), isNull(environments.archivedAt)))
    .leftJoin(imageTags, eq(deployments.imageTagId, imageTags.id))
    .where(and(
      isNull(deployments.supersededAt),
      filter.serviceIds ? inArray(deployments.serviceId, filter.serviceIds) : undefined,
      filter.organizationId ? eq(deployments.organizationId, filter.organizationId) : undefined,
      filter.environmentKinds ? inArray(environments.kind, filter.environmentKinds as (typeof environments.kind.enumValues)[number][]) : undefined,
      filter.environmentIds ? inArray(environments.id, filter.environmentIds) : undefined,
    ));
  if (!rows.length) return [];
  const serviceIds = [...new Set(rows.map((r) => r.d.serviceId))];
  const digestOf = (r: (typeof rows)[number]) => digestOfRef(r.d.imageRef) ?? r.tagDigest?.toLowerCase() ?? null;
  // version-only deployments: the release's image digests
  const relIds = [...new Set(rows.filter((r) => !digestOf(r) && r.d.releaseId).map((r) => r.d.releaseId!))];
  const relDigests = relIds.length
    ? await db.select({ releaseId: imageTags.releaseId, digest: imageTags.digest }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(inArray(imageTags.releaseId, relIds), inArray(containerImages.serviceId, serviceIds), sql`${imageTags.digest} is not null`))
    : [];
  const wanted = [...new Set([...rows.map(digestOf), ...relDigests.map((r) => r.digest?.toLowerCase())].filter((x): x is string => !!x))];
  const imageSboms = wanted.length
    ? await db.select({ id: sboms.id, serviceId: sboms.serviceId, imageDigest: sboms.imageDigest, target: sboms.target }).from(sboms).where(and(inArray(sboms.serviceId, serviceIds), inArray(sboms.imageDigest, wanted))).orderBy(desc(sboms.createdAt))
    : [];
  const releaseIds = [...new Set(rows.map((r) => r.d.releaseId).filter((x): x is string => !!x))];
  const sourceSboms = releaseIds.length
    ? await db.select({ id: sboms.id, releaseId: sboms.releaseId, target: sboms.target }).from(sboms).where(and(inArray(sboms.releaseId, releaseIds), eq(sboms.target, 'source'))).orderBy(desc(sboms.createdAt))
    : [];
  return rows.map((r) => {
    const base = { deploymentId: r.d.id, environmentId: r.env.id, environmentName: r.env.name, environmentKind: r.env.kind, internetFacing: r.env.internetFacing, serviceId: r.d.serviceId };
    const digest = digestOf(r);
    if (digest) {
      const s = imageSboms.find((b) => b.serviceId === r.d.serviceId && b.imageDigest === digest);
      if (s) return { ...base, digest, sbomId: s.id, sbomTarget: s.target, via: 'digest' as const };
    } else if (r.d.releaseId) {
      const ds = relDigests.filter((x) => x.releaseId === r.d.releaseId).map((x) => x.digest?.toLowerCase());
      const s = imageSboms.find((b) => b.serviceId === r.d.serviceId && ds.includes(b.imageDigest ?? ''));
      if (s) return { ...base, digest: s.imageDigest, sbomId: s.id, sbomTarget: s.target, via: 'release-image' as const };
    }
    // A known digest without an image SBOM still has the release's source SBOM as best knowledge (marked as such).
    const src = r.d.releaseId ? sourceSboms.find((b) => b.releaseId === r.d.releaseId) : undefined;
    return src ? { ...base, digest, sbomId: src.id, sbomTarget: src.target, via: 'release-source' as const } : { ...base, digest, sbomId: null, sbomTarget: null, via: null };
  });
}

/** sbomId → environments that currently run it. */
export function environmentsBySbom(running: RunningSbom[]): Map<string, RunningSbom[]> {
  const m = new Map<string, RunningSbom[]>();
  for (const r of running) if (r.sbomId) m.set(r.sbomId, [...(m.get(r.sbomId) ?? []), r]);
  return m;
}

/**
 * The image digest an SBOM document describes, read from the document itself:
 * Syft JSON `source.version`/`source.metadata.userInput`, CycloneDX `metadata.component.version`/properties,
 * SPDX container package `versionInfo`/externalRefs. Null when the document does not say.
 */
export function imageDigestFromDocument(doc: unknown): string | null {
  const hit = (v: unknown) => (typeof v === 'string' ? (/^(sha256:[0-9a-f]{64})$/i.exec(v)?.[1] ?? digestOfRef(v)) : null);
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, any>;
  const syft = d.source && typeof d.source === 'object' && d.source.type === 'image' ? hit(d.source.version) ?? hit(d.source.metadata?.userInput) ?? (Array.isArray(d.source.metadata?.repoDigests) ? d.source.metadata.repoDigests.map(hit).find(Boolean) : null) : null;
  if (syft) return syft.toLowerCase();
  const comp = d.metadata?.component;
  if (comp && (comp.type === 'container' || comp.type === 'image' || !comp.type)) {
    const c = hit(comp.version) ?? hit(comp['bom-ref']) ?? hit(comp.purl) ?? (Array.isArray(comp.properties) ? comp.properties.map((p: { value?: string }) => hit(p.value)).find(Boolean) : null);
    if (c) return c.toLowerCase();
  }
  if (Array.isArray(d.packages)) {
    for (const p of d.packages) {
      if (p?.primaryPackagePurpose === 'CONTAINER' || /^sha256:/.test(p?.versionInfo ?? '')) {
        const s = hit(p.versionInfo) ?? (Array.isArray(p.externalRefs) ? p.externalRefs.map((r: { referenceLocator?: string }) => hit(r.referenceLocator)).find(Boolean) : null);
        if (s) return s.toLowerCase();
      }
    }
  }
  return null;
}

/**
 * The image digest(s) a release IS: digests its deployments recorded (@sha256), production first; only when no
 * deployment named a digest, the current digests of tags linked to the release. Plus a product reference for VEX
 * and evidence: the production deployment's repository, else the first deployment's, else none (plain digest).
 */
export async function releaseImage(db: Database, releaseId: string): Promise<{ digests: string[]; productRef: string | null }> {
  const deps = await db.select({ imageRef: deployments.imageRef, kind: environments.kind, at: deployments.deployedAt }).from(deployments).innerJoin(environments, eq(deployments.environmentId, environments.id)).where(eq(deployments.releaseId, releaseId)).orderBy(desc(deployments.deployedAt));
  const withDigest = deps.filter((d) => digestOfRef(d.imageRef));
  const ordered = [...withDigest.filter((d) => d.kind === 'production'), ...withDigest.filter((d) => d.kind !== 'production')];
  let digests = [...new Set(ordered.map((d) => digestOfRef(d.imageRef)!))];
  if (!digests.length) digests = [...new Set((await db.select({ digest: imageTags.digest }).from(imageTags).where(eq(imageTags.releaseId, releaseId))).map((t) => t.digest?.toLowerCase()).filter((x): x is string => !!x))];
  const ref = ordered[0]?.imageRef ?? null;
  return { digests, productRef: ref ? ref.split('@')[0]!.replace(/:[^/:]+$/, '') : null };
}

/** SBOMs that describe a release: its source SBOM(s) and image SBOMs whose image_digest is one of the release digests. Never by tag row. */
export async function releaseSbomIds(db: Database, serviceId: string, releaseId: string, digests: string[]): Promise<string[]> {
  const rows = await db.select({ id: sboms.id, releaseId: sboms.releaseId, target: sboms.target, imageDigest: sboms.imageDigest }).from(sboms).where(eq(sboms.serviceId, serviceId));
  return rows.filter((b) => (b.target === 'source' && b.releaseId === releaseId) || (b.target === 'image' && !!b.imageDigest && digests.includes(b.imageDigest))).map((b) => b.id);
}
