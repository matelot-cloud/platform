import { uniqueVulnerabilities } from '../vulnerabilities/severity';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { containerImages, deployments, environments, findings, findingSboms, imageTags, releases, repositories, sboms, serviceRepositories, services, Severity } from '../database/schema';

/**
 * Environment lineage: two lanes — what was *released* (version tag → registries) and what actually *runs*
 * (digest → registries) — plus the drift between them. One call per environment, for the Security graph.
 */
@Injectable()
export class LineageService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Per SBOM: open vulnerabilities counted per unique (advisory, source package), plus the advisory×package total. */
  private async findingCounts(sbomIds: string[]): Promise<Map<string, { unique: Record<Severity, number>; packages: number }>> {
    const out = new Map<string, { unique: Record<Severity, number>; packages: number }>();
    if (!sbomIds.length) return out;
    const rows = await this.db.select({ sbomId: findingSboms.sbomId, severity: findings.severity, advisoryId: findings.advisoryId, canonicalId: findings.canonicalId, packageKey: findings.packageKey, componentId: findings.componentId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).where(and(inArray(findingSboms.sbomId, sbomIds), eq(findings.status, 'open')));
    for (const id of sbomIds) {
      const mine = rows.filter((r) => r.sbomId === id);
      const u = uniqueVulnerabilities(mine);
      const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
      for (const r of u.unique) c[r.severity]++;
      out.set(id, { unique: c, packages: u.packages });
    }
    return out;
  }

  async forEnvironment(environmentId: string) {
    const [env] = await this.db.select({ env: environments, service: services }).from(environments).innerJoin(services, eq(environments.serviceId, services.id)).where(eq(environments.id, environmentId)).limit(1);
    if (!env) throw new NotFoundException('Environment not found');
    const serviceId = env.service.id;
    const [repo] = await this.db.select({ r: repositories }).from(serviceRepositories).innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id)).where(eq(serviceRepositories.serviceId, serviceId)).orderBy(desc(eq(serviceRepositories.role, 'primary'))).limit(1);
    const [current] = await this.db.select().from(deployments).where(and(eq(deployments.environmentId, environmentId), isNull(deployments.supersededAt))).orderBy(desc(deployments.deployedAt)).limit(1);
    const images = await this.db.select().from(containerImages).where(eq(containerImages.serviceId, serviceId));
    const imageById = new Map(images.map((i) => [i.id, i]));
    const tags = images.length ? await this.db.select().from(imageTags).where(inArray(imageTags.imageId, images.map((i) => i.id))) : [];
    const allSboms = await this.db.select({ id: sboms.id, imageTagId: sboms.imageTagId, imageDigest: sboms.imageDigest, releaseId: sboms.releaseId, target: sboms.target, componentCount: sboms.componentCount, createdAt: sboms.createdAt }).from(sboms).where(eq(sboms.serviceId, serviceId)).orderBy(desc(sboms.createdAt));
    const counts = await this.findingCounts(allSboms.map((b) => b.id));
    // An image SBOM describes a digest (image_digest), never a tag row: a tag that moved keeps no stale SBOM.
    const sbomOfDigest = (digest: string | null | undefined) => (digest ? allSboms.find((b) => b.target === 'image' && b.imageDigest === digest.toLowerCase()) ?? null : null);
    const sbomOfTag = (tagId: string) => sbomOfDigest(tags.find((t) => t.id === tagId)?.digest);
    const view = (b: { id: string; componentCount: number } | null) => (b ? { id: b.id, componentCount: b.componentCount, findings: counts.get(b.id)?.unique ?? null, packageFindings: counts.get(b.id)?.packages ?? 0 } : null);
    const host = (name: string) => name.split('/')[0];
    const repoOf = (name: string) => name.split('/').slice(1).join('/');

    // ---- release lane
    let release = current?.releaseId ? (await this.db.select().from(releases).where(eq(releases.id, current.releaseId)).limit(1))[0] : null;
    if (!release && current?.version) release = (await this.db.select().from(releases).where(and(eq(releases.serviceId, serviceId), eq(releases.version, current.version))).limit(1))[0] ?? null;
    // Did the deployment *declare* the version (secops deploy --version / promote of a version tag), or is it a build
    // of a commit (promote of a <sha> tag) that merely shares the commit with a release? Only a declared version can drift.
    let declared = false;
    const releaseTags = release ? tags.filter((t) => t.releaseId === release!.id) : [];
    const releaseRegistries = [...new Map(releaseTags.map((t) => [t.imageId, t])).keys()].map((imageId) => {
      const img = imageById.get(imageId)!;
      const its = releaseTags.filter((t) => t.imageId === imageId);
      const versionTag = its.find((t) => t.tag.replace(/^v(?=\d)/, '') === release!.version) ?? its[0];
      const b = sbomOfTag(versionTag.id) ?? sbomOfDigest(versionTag.digest);
      return { image: img.name, host: host(img.name), repository: repoOf(img.name), tags: its.map((t) => t.tag), digest: versionTag.digest, builtAt: versionTag.builtAt, sbom: view(b), lastSyncedAt: img.lastSyncedAt, lastError: img.lastError };
    });
    const releaseSbom = release ? (allSboms.find((b) => b.releaseId === release!.id && b.target === 'source') ?? null) : null;

    // ---- running lane (by digest)
    const runTag = current?.imageTagId ? tags.find((t) => t.id === current.imageTagId) ?? null : null;
    let runDigest = runTag?.digest ?? (current?.imageRef?.includes('@sha256:') ? current.imageRef.split('@')[1] : null);
    // Deployment named only a version (no image): the best knowledge of what runs is the release's image — say so.
    let inferred = false;
    if (!runDigest && release) {
      const rel = tags.filter((t) => t.releaseId === release.id && t.digest);
      const pick = rel.find((t) => t.tag.replace(/^v(?=\d)/, '') === release.version && t.builtAt) ?? rel.sort((a, b) => (b.builtAt?.getTime() ?? 0) - (a.builtAt?.getTime() ?? 0))[0];
      if (pick?.digest) { runDigest = pick.digest; inferred = true; }
    }
    const runTags = runDigest ? tags.filter((t) => t.digest === runDigest) : runTag ? [runTag] : [];
    const deployedFrom = current?.imageRef ? current.imageRef.split('@')[0].replace(/:[^/:]+$/, '') : null;
    const runRegistries = [...new Map(runTags.map((t) => [t.imageId, t])).keys()].map((imageId) => {
      const img = imageById.get(imageId)!;
      const its = runTags.filter((t) => t.imageId === imageId);
      return { image: img.name, host: host(img.name), repository: repoOf(img.name), tags: its.map((t) => t.tag), digest: runDigest, deployedFrom: !!deployedFrom && img.name === deployedFrom.toLowerCase(), sbom: view(sbomOfTag(its[0].id) ?? sbomOfDigest(runDigest)), lastSyncedAt: img.lastSyncedAt, lastError: img.lastError };
    });
    // The repository the environment runs from is not always a tracked image (built-in environment repositories
    // <build>/<env> are written by promote): add it so deployedFrom always names the real source.
    if (deployedFrom && !runRegistries.some((r) => r.deployedFrom)) {
      const build = runRegistries.find((r) => deployedFrom.toLowerCase().startsWith(`${r.image}/`));
      runRegistries.unshift({ ...(build ?? runRegistries[0] ?? ({} as (typeof runRegistries)[number])), image: deployedFrom, host: host(deployedFrom), repository: repoOf(deployedFrom), tags: current?.imageRef?.includes(':') && !current.imageRef.split('@')[0]!.endsWith(deployedFrom) ? [current.imageRef.split('@')[0]!.split(':').pop()!] : [], digest: runDigest, deployedFrom: true });
    }
    // A promote of a <sha> tag inherits the release's version when the commit matches; that is a build of a commit,
    // not a declared version. Registry-recorded deployments are "declared" only if the running image carries the version tag.
    const versionTagPresent = !!release && runTags.some((t) => t.tag.replace(/^v(?=\d)/, '') === release!.version);
    declared = !!release && !!current?.version && current.version.replace(/^v(?=\d)/, '') === release.version && (current.source !== 'registry' || versionTagPresent);
    const commitFromTag = runTags.map((t) => /^(?:sha-)?([0-9a-f]{7,40})(?:[-_.][a-z0-9-]+)?$/i.exec(t.tag)?.[1]).find(Boolean) ?? null;
    const running = current ? { version: current.version, deployedAt: current.deployedAt, source: current.source, imageRef: current.imageRef, digest: runDigest, inferred, commitSha: release?.commitSha ?? commitFromTag, builtAt: runTags[0]?.builtAt ?? null, tags: [...new Set(runTags.map((t) => t.tag))], registries: runRegistries, runningFrom: runRegistries.find((r) => r.deployedFrom) ?? null, alsoPresentIn: runRegistries.filter((r) => !r.deployedFrom), sbom: view(sbomOfDigest(runDigest)) } : null;

    // ---- drift
    const drift: { level: 'error' | 'warning' | 'info'; code: string; message: string }[] = [];
    const versionLike = !!current?.version && /^v?\d+(\.\d+)+/.test(current.version);
    if (current && !release && versionLike) drift.push({ level: 'warning', code: 'no_release', message: `Version ${current.version} is deployed but no release exists for it.` });
    if (current && !runDigest) drift.push({ level: 'warning', code: 'no_digest', message: 'The deployment does not identify an image digest, so what runs cannot be verified.' });
    if (current && inferred) drift.push({ level: 'info', code: 'digest_inferred', message: `The deployment named version ${current.version} without an image; the running image is inferred from the release. Deploy with --image <ref>@<digest> to make it verifiable.` });
    if (current && runDigest && !runRegistries.length) drift.push({ level: 'error', code: 'unknown_image', message: `No known registry holds the running image (${runDigest.slice(7, 19)}). The registry was not read since the push, or the image was pushed from outside the platform.` });
    if (release && declared && runDigest && releaseRegistries.length) {
      const pointing = releaseRegistries.filter((r) => r.digest && r.digest !== runDigest);
      if (pointing.length === releaseRegistries.length) drift.push({ level: 'error', code: 'tag_moved', message: `Release ${release.version} now points to image ${releaseRegistries[0].digest?.slice(7, 19)} in ${pointing.map((r) => r.host).join(', ')}, but ${env.env.name} runs ${runDigest.slice(7, 19)} — the version tag was rebuilt after the deployment (or the environment was rolled back).` });
      else if (pointing.length) drift.push({ level: 'warning', code: 'tag_split', message: `Release ${release.version} points to different images in different registries (${pointing.map((r) => `${r.host}: ${r.digest?.slice(7, 19)}`).join(' · ')}); ${env.env.name} runs ${runDigest.slice(7, 19)}.` });
    }
    if (running && !running.sbom) drift.push({ level: 'warning', code: 'not_scanned', message: 'The running image has no SBOM: no vulnerability data for this environment.' });
    for (const r of [...releaseRegistries, ...runRegistries]) if (r.lastError) drift.push({ level: 'warning', code: 'registry_error', message: `${r.host}: last sync failed — ${r.lastError}` });

    const history = await this.db.select({ id: deployments.id, version: deployments.version, imageRef: deployments.imageRef, source: deployments.source, deployedAt: deployments.deployedAt, supersededAt: deployments.supersededAt }).from(deployments).where(eq(deployments.environmentId, environmentId)).orderBy(desc(deployments.deployedAt)).limit(8);

    return {
      environment: { id: env.env.id, name: env.env.name, slug: env.env.slug, kind: env.env.kind, internetFacing: env.env.internetFacing, protected: env.env.settings.protected === true },
      service: { id: env.service.id, name: env.service.name, slug: env.service.slug, criticality: env.service.criticality },
      repository: repo ? { id: repo.r.id, fullName: repo.r.fullName, htmlUrl: repo.r.htmlUrl, defaultBranch: repo.r.defaultBranch } : null,
      declared,
      release: release ? { id: release.id, version: release.version, tag: release.tag, commitSha: release.commitSha, htmlUrl: release.htmlUrl, releasedAt: release.releasedAt, source: release.source, sbom: view(releaseSbom), registries: releaseRegistries } : null,
      running,
      drift: [...new Map(drift.map((d) => [d.code + d.message, d])).values()],
      history,
    };
  }
}
