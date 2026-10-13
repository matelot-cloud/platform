import { uniqueVulnerabilities } from '../vulnerabilities/severity';
import type { Severity } from '../database/schema';
import { digestOfRef } from '../sbom/running-sbom';
import { Optional, BadRequestException, ConflictException, forwardRef, Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { userIdOrNull, type AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../database/errors';
import { ContainerImage, containerImages, deployments, environments, findings, findingSboms, imageTags, integrations, jobs, Release, releases, repositories, sboms, serviceRepositories, services , projects, teams, workspaces } from '../database/schema';
import { JobsService } from '../execution/jobs.service';
import { PoliciesService } from '../policies/policies.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { lsRemoteTags } from '../integrations/git/git-remote';
import { githubToken, gitlab } from '../integrations/git/token-providers';
import { GithubAppClient } from '../integrations/github/github-app.client';
import { GithubSyncService } from '../integrations/github/github-sync.service';
import { SourceSyncService } from '../integrations/source-sync.service';
import { ScopeChain } from '../rbac/scope.types';
import { CreateImageDto, CreateReleaseDto, RecordDeploymentDto } from './dto/inventory.dto';
import { parseImageName, RegistryClient } from './registry.client';
import { dockerCredentialsFor } from '../integrations/registry-auth';
import type { IntegrationCredentials } from '../integrations/credentials';
import { RegistryService } from '../registry/registry.service';

const normalizeVersion = (v: string) => v.replace(/^v(?=\d)/, '');

/** Newest first: numeric parts compare as numbers, longer/more specific versions win ties, non-versions sort last alphabetically. */
function compareVersionsDesc(a: string, b: string): number {
  const parse = (s: string) => s.replace(/^v(?=\d)/, '').split(/[.\-_]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parse(a);
  const pb = parse(b);
  const va = typeof pa[0] === 'number';
  const vb = typeof pb[0] === 'number';
  if (va !== vb) return va ? -1 : 1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return y - x;
    } else if (String(x) !== String(y)) return String(y).localeCompare(String(x));
  }
  return 0;
}

const usableRegistry = (r: typeof integrations.$inferSelect) => r.status !== 'disconnected' && !(r.settings.keyless === true && r.settings.verified !== true);

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  onModuleInit() {
    setTimeout(() => void this.repointBorrowedDeployments().catch((e: Error) => this.logger.warn(`repoint failed: ${e.message}`)), 8_000).unref?.();
  }

  /**
   * Backfill: deployments attached to a tag row of ANOTHER registry (borrowed by digest before this fix) get a tag row
   * in the image their imageRef names. Idempotent; runs once after boot.
   */
  async repointBorrowedDeployments(): Promise<number> {
    const rows = await this.db.select({ d: deployments, tagImage: containerImages.name, tagName: imageTags.tag, tagDigest: imageTags.digest })
      .from(deployments).innerJoin(imageTags, eq(deployments.imageTagId, imageTags.id)).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id))
      .where(sql`${deployments.imageRef} is not null and lower(split_part(split_part(${deployments.imageRef}, '@', 1), ':', 1)) <> ${containerImages.name} and position('/' in split_part(${deployments.imageRef}, '@', 1)) > 0`);
    let fixed = 0;
    for (const r of rows) {
      const ref = r.d.imageRef!;
      const [refName, digestPart] = ref.includes('@') ? ref.split('@') : [ref, null];
      const name = refName!.replace(/:[^/:]+$/, '').toLowerCase();
      if (name === r.tagImage.toLowerCase()) continue; // name:tag form where the tag part contained the mismatch
      const digest = digestPart ?? r.tagDigest;
      let [img] = await this.db.select({ id: containerImages.id }).from(containerImages).where(and(eq(containerImages.serviceId, r.d.serviceId), eq(containerImages.name, name))).limit(1);
      if (!img) { const reg = await this.registryByHost(r.d.serviceId, r.d.organizationId, name); [img] = await this.db.insert(containerImages).values({ organizationId: r.d.organizationId, serviceId: r.d.serviceId, name, integrationId: reg?.id ?? null }).onConflictDoNothing().returning({ id: containerImages.id }); }
      if (!img) continue;
      let [t] = digest ? await this.db.select({ id: imageTags.id }).from(imageTags).where(and(eq(imageTags.imageId, img.id), eq(imageTags.digest, digest))).limit(1) : [];
      if (!t) {
        const tagInRef = /:([^/:]+)$/.exec(refName!)?.[1] ?? null;
        [t] = await this.db.insert(imageTags).values({ imageId: img.id, tag: tagInRef ?? (digest ? `sha256-${digest.replace(/^sha256:/, '').slice(0, 12)}` : r.tagName), digest: digest ?? null }).onConflictDoNothing().returning({ id: imageTags.id });
        if (!t && tagInRef) [t] = await this.db.select({ id: imageTags.id }).from(imageTags).where(and(eq(imageTags.imageId, img.id), eq(imageTags.tag, tagInRef))).limit(1);
      }
      if (t) { await this.db.update(deployments).set({ imageTagId: t.id }).where(eq(deployments.id, r.d.id)); fixed++; }
    }
    if (fixed) this.logger.log(`re-pointed ${fixed} deployment(s) to a tag row of their own registry`);
    return fixed;
  }

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly sourceSync: SourceSyncService,
    private readonly githubSync: GithubSyncService,
    private readonly github: GithubAppClient,
    @Inject(forwardRef(() => RegistryService)) private readonly registry: RegistryService,
    @Inject(forwardRef(() => JobsService)) private readonly jobsService: JobsService,
    private readonly resolver: ScopeResolverService,
    @Optional() @Inject(forwardRef(() => PoliciesService)) private readonly policies?: PoliciesService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- releases

  listReleases(serviceId: string) {
    return this.db.select().from(releases).where(eq(releases.serviceId, serviceId)).orderBy(desc(releases.releasedAt), desc(releases.createdAt));
  }

  async createRelease(user: AuthenticatedUser, chain: ScopeChain, dto: CreateReleaseDto): Promise<Release> {
    try {
      const [release] = await this.db
        .insert(releases)
        .values({ organizationId: chain.organizationId, serviceId: chain.serviceId!, repositoryId: dto.repositoryId ?? null, version: normalizeVersion(dto.version), tag: dto.tag ?? null, commitSha: dto.commitSha ?? null, notes: dto.notes ?? null, source: 'manual', releasedAt: dto.releasedAt ? new Date(dto.releasedAt) : new Date(), createdById: userIdOrNull(user) })
        .returning();
      await this.audit.record({ organizationId: chain.organizationId, actor: userActor(user), action: 'release.created', resourceType: 'release', resourceId: release.id, after: { version: release.version, serviceId: release.serviceId } });
      await this.matchTagsToReleases(chain.serviceId!);
      return release;
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new ConflictException(`Release ${dto.version} already exists for this service`);
      throw error;
    }
  }

  /** Pulls tags (and GitHub/GitLab releases) of every repository attached to the service. */
  async syncReleases(actor: AuthenticatedUser | null, chain: ScopeChain): Promise<{ created: number; seen: number; errors: string[] }> {
    const serviceId = chain.serviceId!;
    const links = await this.db.select({ repository: repositories, integration: integrations }).from(serviceRepositories).innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id)).innerJoin(integrations, eq(repositories.integrationId, integrations.id)).where(eq(serviceRepositories.serviceId, serviceId));
    if (!links.length) throw new BadRequestException('Attach a repository to the service first');
    let created = 0;
    let seen = 0;
    const errors: string[] = [];
    for (const { repository, integration } of links) {
      let found: Awaited<ReturnType<InventoryService['remoteTags']>>;
      try {
        found = await this.remoteTags(repository, integration);
      } catch (error) {
        errors.push(`${repository.fullName}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const t of found) {
        seen++;
        const inserted = await this.db
          .insert(releases)
          .values({ organizationId: chain.organizationId, serviceId, repositoryId: repository.id, version: normalizeVersion(t.tag), tag: t.tag, commitSha: t.sha ?? null, source: t.source, notes: t.notes ?? null, htmlUrl: t.url ?? null, releasedAt: t.at ? new Date(t.at) : null, createdById: userIdOrNull(actor) })
          .onConflictDoUpdate({ target: [releases.serviceId, releases.version], set: { commitSha: t.sha ?? null, tag: t.tag, ...(t.notes ? { notes: t.notes } : {}), ...(t.url ? { htmlUrl: t.url } : {}), ...(t.at ? { releasedAt: new Date(t.at) } : {}), ...(t.source !== 'git_tag' ? { source: t.source } : {}) } })
          .returning({ createdAt: releases.createdAt });
        if (inserted[0] && Date.now() - inserted[0].createdAt.getTime() < 5000) created++;
      }
    }
    await this.matchTagsToReleases(serviceId);
    await this.audit.record({ organizationId: chain.organizationId, actor: actor ? userActor(actor) : SYSTEM_ACTOR, action: 'release.synced', resourceType: 'service', resourceId: serviceId, after: { created, seen, errors } });
    if (!seen && errors.length) throw new BadRequestException(`No repository could be read: ${errors.join('; ')}`);
    return { created, seen, errors };
  }

  private async remoteTags(repository: typeof repositories.$inferSelect, integration: typeof integrations.$inferSelect): Promise<{ tag: string; sha?: string; source: Release['source']; notes?: string; url?: string; at?: string }[]> {
    const out: { tag: string; sha?: string; source: Release['source']; notes?: string; url?: string; at?: string }[] = [];
    const creds = this.sourceSync.credentialsOf(integration);
    const baseUrl = String(integration.settings.baseUrl ?? '');
    if (integration.provider === 'github' && integration.externalAccountId) {
      const token = await this.github.installationToken(integration.externalAccountId, this.githubSync.appConfigFor(integration));
      const api = this.githubSync.appConfigFor(integration)?.apiUrl ?? this.github.config?.apiUrl ?? 'https://api.github.com';
      return githubToken.tagsAndReleases(api, token, repository.fullName);
    }
    if (integration.provider === 'github_token' && creds.type === 'token') return githubToken.tagsAndReleases(baseUrl || 'https://api.github.com', creds.token, repository.fullName);
    if (integration.provider === 'gitlab' && creds.type === 'token') return gitlab.tagsAndReleases((baseUrl || 'https://gitlab.com').replace(/\/$/, ''), creds.token, repository.externalId);
    const url = repository.sshUrl ?? repository.cloneUrl ?? String(integration.settings.repositoryUrl ?? '');
    for (const t of await lsRemoteTags(url, creds)) out.push({ tag: t.tag, sha: t.sha, source: 'git_tag' });
    return out;
  }

  // ---------------------------------------------------------------- images

  /** Same data as the web app's inventory (warnings, release by digest, SBOM, environments) — one view for UI, CLI and MCP. */
  async listImages(serviceId: string) {
    const images = await this.db.select().from(containerImages).where(eq(containerImages.serviceId, serviceId));
    const { images: view } = await this.serviceOverview(serviceId);
    const byId = new Map(view.map((v) => [v.id, v]));
    return images.map((i) => ({ ...i, tags: byId.get(i.id)?.tags ?? [] }));
  }

  async addImage(user: AuthenticatedUser, chain: ScopeChain, dto: CreateImageDto): Promise<ContainerImage> {
    const [image] = await this.db
      .insert(containerImages)
      .values({ organizationId: chain.organizationId, serviceId: chain.serviceId!, integrationId: dto.integrationId ?? null, name: dto.name.toLowerCase(), createdById: userIdOrNull(user) })
      .onConflictDoUpdate({ target: [containerImages.serviceId, containerImages.name], set: { integrationId: dto.integrationId ?? null } })
      .returning();
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(user), action: 'image.added', resourceType: 'container_image', resourceId: image.id, after: { name: image.name } });
    await this.syncImage(image.id, dto.insecure).catch(() => undefined);
    return image;
  }

  async removeImage(user: AuthenticatedUser, chain: ScopeChain, imageId: string) {
    const [image] = await this.db.delete(containerImages).where(and(eq(containerImages.id, imageId), eq(containerImages.serviceId, chain.serviceId!))).returning();
    if (!image) throw new NotFoundException('Image not found');
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(user), action: 'image.removed', resourceType: 'container_image', resourceId: image.id, before: { name: image.name } });
  }

  /** Lists tags and digests from the registry; matches tags to releases. */
  async syncImage(imageId: string, insecure = false): Promise<{ tags: number; total?: number }> {
    const [image] = await this.db.select().from(containerImages).where(eq(containerImages.id, imageId)).limit(1);
    if (!image) throw new NotFoundException('Image not found');
    let integration = image.integrationId ? (await this.db.select().from(integrations).where(eq(integrations.id, image.integrationId)).limit(1))[0] : undefined;
    if (!integration) {
      // Image registered from a deployment (or backfilled) without a connection: find one by host on the service's chain,
      // nearest first. Without it, private registries (ACR, ECR, GAR, Hub private repos) can never be listed.
      integration = await this.registryByHost(image.serviceId, image.organizationId, image.name);
      if (integration) await this.db.update(containerImages).set({ integrationId: integration.id }).where(eq(containerImages.id, image.id));
    }
    const stored = integration ? this.sourceSync.credentialsOf(integration) : { type: 'none' as const };
    try {
      const builtIn = this.registry.host && image.name.startsWith(`${this.registry.host.toLowerCase()}/`);
      const ref = parseImageName(image.name);
      // ECR/ACR credentials are exchanged for short-lived Docker credentials; static ones pass through.
      const docker = await dockerCredentialsFor(ref.registry, stored, integration ? `integration:${integration.id}` : undefined);
      const creds: IntegrationCredentials = docker ? { type: 'basic', username: docker.username, password: docker.password } : { type: 'none' };
      // The built-in registry is dialled at its internal address (REGISTRY_INTERNAL_URL): its public host is Caddy / the
      // ingress, and `localhost:5000` inside the api container is the api itself.
      const client = new RegistryClient(ref, creds, insecure || image.name.startsWith('localhost') || (!!builtIn && !this.registry.host!.includes('.')), builtIn ? (this.registry.internalToken(ref.repository) ?? undefined) : undefined, builtIn ? this.registry.internalUrl : undefined);
      const all = await client.tags();
      // Public images can carry thousands of tags; keep the newest 100 by version (semver-ish sort), plus mutable channel tags.
      const channel = all.filter((t) => /^(latest|stable|main|edge|nightly)$/i.test(t));
      const versioned = all.filter((t) => !channel.includes(t)).sort((a, b) => compareVersionsDesc(a, b));
      const tags = [...channel, ...versioned.slice(0, 100)];
      const now = new Date();
      const known = new Set((await this.db.select({ tag: imageTags.tag }).from(imageTags).where(eq(imageTags.imageId, image.id))).map((t) => t.tag));
      const firstSync = !image.lastSyncedAt;
      const knownRows = await this.db.select({ tag: imageTags.tag, digest: imageTags.digest, builtAt: imageTags.builtAt }).from(imageTags).where(eq(imageTags.imageId, image.id));
      const knownDigest = new Map(knownRows.map((t) => [t.tag, t.digest]));
      const missingBuiltAt = new Set(knownRows.filter((t) => !t.builtAt).map((t) => t.tag));
      const unresolved: string[] = [];
      for (const tag of tags) {
        // A failed lookup must not erase what we knew (ACR used to answer without a digest header).
        const resolved = await client.digestWithReason(tag);
        if (!resolved.digest) { this.logger.warn(`digest of ${image.name}:${tag} not resolved (${resolved.reason}); ${knownDigest.get(tag) ? 'keeping the known digest' : 'stored as unknown'}`); unresolved.push(`${tag} (${resolved.reason ?? 'unknown'})`); }
        const digest = resolved.digest ?? knownDigest.get(tag) ?? null;
        if (digest && knownDigest.get(tag) && knownDigest.get(tag) !== digest && !InventoryService.isReleaseTag(tag)) await this.db.update(imageTags).set({ releaseId: null }).where(and(eq(imageTags.imageId, image.id), eq(imageTags.tag, tag)));
        const changed = !knownDigest.has(tag) || knownDigest.get(tag) !== digest;
        // Build time comes from the image config; read it for new/changed tags and for tags still missing it.
        const builtAt = changed || missingBuiltAt.has(tag) ? await client.builtAt(tag) : undefined;
        const [row] = await this.db.insert(imageTags).values({ imageId: image.id, tag, digest, lastSeenAt: now, builtAt: builtAt ?? null }).onConflictDoUpdate({ target: [imageTags.imageId, imageTags.tag], set: { digest, lastSeenAt: now, ...(builtAt ? { builtAt } : {}) } }).returning({ id: imageTags.id });
        // New tags after the first sync are new builds: scan them. The historical backlog is scanned on demand.
        if (!firstSync && !known.has(tag) && !/^(latest|stable|main|edge|nightly)$/i.test(tag)) await this.queueImageSbom(image.serviceId, image.name, tag, row.id);
      }
      // Unresolved digests are a sync problem the user must see (Inventory shows lastError), not a silent null.
      if (integration) await this.sourceSync.markHealthy(integration.id);
      await this.db.update(containerImages).set({ lastSyncedAt: now, lastError: unresolved.length ? `digest unresolved for ${unresolved.length} tag(s): ${unresolved.slice(0, 3).join('; ')}${unresolved.length > 3 ? ' …' : ''}` : null }).where(eq(containerImages.id, image.id));
      await this.matchTagsToReleases(image.serviceId);
      await this.replaceDigestPlaceholders(image.id);
      // Deployments recorded from this registry while its tag digests were unknown were attached to a same-digest tag of
      // ANOTHER registry (so "current.tag" showed Docker Hub's `test` for an ACR deployment): re-point them now.
      const deps = await this.db.select({ id: deployments.id, imageRef: deployments.imageRef, imageTagId: deployments.imageTagId }).from(deployments).where(and(eq(deployments.serviceId, image.serviceId), isNull(deployments.supersededAt), sql`lower(${deployments.imageRef}) like ${image.name.toLowerCase() + '@%'}`));
      const mine = await this.db.select({ id: imageTags.id, digest: imageTags.digest }).from(imageTags).where(eq(imageTags.imageId, image.id));
      for (const d of deps) {
        const digest = d.imageRef?.split('@')[1]?.toLowerCase();
        const own = mine.find((t) => t.digest?.toLowerCase() === digest);
        if (own && d.imageTagId !== own.id && !mine.some((t) => t.id === d.imageTagId)) await this.db.update(deployments).set({ imageTagId: own.id }).where(eq(deployments.id, d.id));
      }
      // Deployments reported by digest before this image's tags were known: attach them to the tag now.
      const known2 = await this.db.select({ id: imageTags.id, digest: imageTags.digest }).from(imageTags).where(eq(imageTags.imageId, image.id));
      const tagByDigest = new Map(known2.filter((t) => t.digest).map((t) => [t.digest!, t.id]));
      const orphans = await this.db.select({ id: deployments.id, imageRef: deployments.imageRef }).from(deployments).where(and(eq(deployments.serviceId, image.serviceId), isNull(deployments.imageTagId), sql`${deployments.imageRef} like '%@sha256:%'`));
      for (const d of orphans) {
        const digest = d.imageRef?.split('@')[1] ?? '';
        let tagId = tagByDigest.get(digest);
        if (!tagId) tagId = (await this.db.select({ id: imageTags.id }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(eq(containerImages.serviceId, image.serviceId), eq(imageTags.digest, digest))).limit(1))[0]?.id;
        if (tagId) await this.db.update(deployments).set({ imageTagId: tagId }).where(eq(deployments.id, d.id));
      }
      return { tags: tags.length, total: all.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.update(containerImages).set({ lastError: message }).where(eq(containerImages.id, image.id));
      throw new BadRequestException(message);
    }
  }

  /** A registry connection on the project's path whose host matches the image. */
  /**
   * A deployment recorded before the registry was listed got a placeholder row (`sha256-<12>`). Once the registry sync
   * brings the real tag(s) for that digest, deployments move to the real tag and the placeholder is removed.
   */
  async replaceDigestPlaceholders(imageId: string): Promise<number> {
    const rows = await this.db.select({ id: imageTags.id, tag: imageTags.tag, digest: imageTags.digest, releaseId: imageTags.releaseId }).from(imageTags).where(eq(imageTags.imageId, imageId));
    let moved = 0;
    const deps = await this.db.select({ imageTagId: deployments.imageTagId, imageRef: deployments.imageRef }).from(deployments).where(isNull(deployments.supersededAt));
    for (const ph of rows.filter((t) => /^sha256-[0-9a-f]{12}$/.test(t.tag) && t.digest)) {
      // a placeholder nobody runs and no real tag explains is leftover noise ("Generate SBOM" on a ghost row): drop it
      const referenced = deps.some((d) => d.imageTagId === ph.id || (d.imageRef && d.imageRef.toLowerCase().endsWith(`@${ph.digest!.toLowerCase()}`)));
      const hasReal = rows.some((t) => t.id !== ph.id && t.digest === ph.digest && !/^sha256-[0-9a-f]{12}$/.test(t.tag));
      if (!referenced && !hasReal) { await this.db.delete(imageTags).where(eq(imageTags.id, ph.id)); moved++; continue; }
      // prefer a version-like tag, then the environment-looking one, then any real tag with the same digest
      const real = rows.filter((t) => t.id !== ph.id && t.digest === ph.digest && !/^sha256-[0-9a-f]{12}$/.test(t.tag)).sort((a, b) => (/^v?\d+(\.\d+)+/.test(b.tag) ? 1 : 0) - (/^v?\d+(\.\d+)+/.test(a.tag) ? 1 : 0) || a.tag.localeCompare(b.tag))[0];
      if (!real) continue;
      await this.db.update(deployments).set({ imageTagId: real.id }).where(eq(deployments.imageTagId, ph.id));
      if (ph.releaseId && !real.releaseId) await this.db.update(imageTags).set({ releaseId: ph.releaseId }).where(eq(imageTags.id, real.id));
      await this.db.delete(imageTags).where(eq(imageTags.id, ph.id));
      moved++;
    }
    return moved;
  }

  /** Registry connection for a host, by proximity on the service's chain (project → team → workspace → organization). */
  private async registryByHost(serviceId: string, organizationId: string, imageName: string) {
    const host = parseImageName(imageName).registry.toLowerCase();
    const [chain] = await this.db.select({ projectId: projects.id, teamId: teams.id, workspaceId: workspaces.id }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(services.id, serviceId)).limit(1);
    const rows = await this.db.select().from(integrations).where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, 'registry')));
    // disconnected and unverified keyless connections cannot pull: never pick them for an image
    const byHost = rows.filter(usableRegistry).filter((r) => String(r.settings.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase() === host);
    const order: [string, string | null][] = [['PROJECT', chain?.projectId ?? null], ['TEAM', chain?.teamId ?? null], ['WORKSPACE', chain?.workspaceId ?? null], ['ORGANIZATION', organizationId]];
    for (const [type, id] of order) { const hit = byHost.find((r) => r.scopeType === type && (r.scopeId ?? r.organizationId) === id); if (hit) return hit; }
    return byHost[0];
  }

  private async registryFor(chain: ScopeChain, imageName: string) {
    const host = parseImageName(imageName).registry;
    const rows = await this.db.select().from(integrations).where(and(eq(integrations.organizationId, chain.organizationId), eq(integrations.provider, 'registry')));
    const refs = new Set(chain.refs.map((r) => `${r.type}:${r.id}`));
    return rows.filter(usableRegistry).find((r) => refs.has(`${r.scopeType}:${r.scopeId ?? r.organizationId}`) && String(r.settings.baseUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '') === host);
  }

  async currentDeploymentOf(environmentId: string) {
    const [row] = await this.db.select().from(deployments).where(and(eq(deployments.environmentId, environmentId), isNull(deployments.supersededAt))).orderBy(desc(deployments.deployedAt)).limit(1);
    return row ?? null;
  }

  /** Public entry for other services (registry events). */
  queueImageSbomFor(serviceId: string, imageName: string, tag: string, tagId: string): Promise<void> {
    return this.queueImageSbom(serviceId, imageName, tag, tagId);
  }

  /** Queues an image SBOM for a tag that has none yet (one per digest). */
  private async queueImageSbom(serviceId: string, imageName: string, tag: string, tagId: string): Promise<void> {
    // One SBOM per DIGEST: the same image in several registries is scanned once, and a tag that MOVED to a new digest
    // is scanned again (an SBOM linked to the tag row may describe the old image).
    const [self] = await this.db.select({ digest: imageTags.digest }).from(imageTags).where(eq(imageTags.id, tagId)).limit(1);
    if (self?.digest) {
      const [sameDigest] = await this.db.select({ id: sboms.id }).from(sboms).where(and(eq(sboms.serviceId, serviceId), eq(sboms.imageDigest, self.digest.toLowerCase()))).limit(1);
      if (sameDigest) return;
    } else {
      const [existing] = await this.db.select({ id: sboms.id }).from(sboms).where(eq(sboms.imageTagId, tagId)).limit(1);
      if (existing) return; // digest not read yet: avoid re-queuing while the registry sync catches up
    }
    const [queued] = await this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.serviceId, serviceId), eq(jobs.type, 'sbom'), inArray(jobs.status, ['queued', 'assigned', 'running']), sql`${jobs.payload}->>'imageRef' = ${`${imageName}:${tag}`}`)).limit(1);
    if (queued) return;
    // Back-off: a scan that failed recently is not retried automatically (people retry from the job page once the cause is fixed).
    const [recentFailure] = await this.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.serviceId, serviceId), eq(jobs.type, 'sbom'), inArray(jobs.status, ['failed', 'timed_out']), sql`${jobs.payload}->>'imageRef' = ${`${imageName}:${tag}`}`, sql`${jobs.createdAt} > now() - interval '12 hours'`)).limit(1);
    if (recentFailure) return;
    try {
      const chain = await this.resolver.resolveChain({ serviceId });
      await this.jobsService.create(null, chain, { type: 'sbom', payload: { target: 'image', imageRef: `${imageName}:${tag}`, version: tag } });
    } catch {
      /* no runner / no permission: the tag can be scanned by hand from the UI */
    }
  }

  /** Worker: refresh tags of images not synced for a while. */
  async syncStaleImages(olderThanMinutes = 15): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const stale = await this.db.select({ id: containerImages.id, name: containerImages.name }).from(containerImages).where(or(isNull(containerImages.lastSyncedAt), lt(containerImages.lastSyncedAt, cutoff))).limit(50);
    let n = 0;
    for (const img of stale) {
      await this.syncImage(img.id, img.name.startsWith('localhost')).then(() => n++).catch(() => undefined);
    }
    return n;
  }

  /** image tag "4.2.0" / "v4.2.0" ↔ release 4.2.0 */
  /**
   * Links image tags to releases. Two rules, in order:
   *  1. tag equals the version ("1.6.0" / "v1.6.0");
   *  2. tag is the release's commit ("ae2d1fe…", "sha-ae2d1fe", or a ≥7-char prefix of the commit sha) —
   *     the way CI usually tags build images. A release created later from that commit picks up its images.
   */
  /** Version-like (1.0.25, v2.1.0-rc1) or commit-like (sha-07f11b7, 07f11b7a…) tags carry release identity; `preprod`, `latest`, `sha256-…` do not. */
  static isReleaseTag(tag: string): boolean { return /^v?\d+(\.\d+)+/.test(tag) || /^(?:sha-)?[0-9a-f]{7,40}(?:[-_.][a-z0-9-]+)?$/i.test(tag) && !/^sha256-/.test(tag); }

  async matchTagsToReleases(serviceId: string): Promise<number> {
    const rels = await this.db.select({ id: releases.id, version: releases.version, commitSha: releases.commitSha }).from(releases).where(eq(releases.serviceId, serviceId));
    if (!rels.length) return 0;
    const byVersion = new Map(rels.map((r) => [r.version, r.id]));
    const byCommit = rels.filter((r) => r.commitSha).map((r) => ({ id: r.id, version: r.version, sha: r.commitSha!.toLowerCase() }));
    const images = await this.db.select({ id: containerImages.id }).from(containerImages).where(eq(containerImages.serviceId, serviceId));
    if (!images.length) return 0;
    const tags = await this.db.select().from(imageTags).where(and(inArray(imageTags.imageId, images.map((i) => i.id)), isNull(imageTags.releaseId)));
    let linked = 0;
    for (const t of tags) {
      if (!InventoryService.isReleaseTag(t.tag)) continue; // environment / floating tags are attributed by digest at read time
      let releaseId = byVersion.get(normalizeVersion(t.tag));
      if (!releaseId) {
        // Commit-tagged builds: `<sha>`, `sha-<sha>`, and `<sha>-<variant>` (e.g. <sha>-prod, <sha>-test).
        const m = /^(?:sha-)?([0-9a-f]{7,40})(?:[-_.][a-z0-9-]+)?$/i.exec(t.tag);
        const candidate = m?.[1]?.toLowerCase();
        // Several releases can share a commit (1.9.3-rc1 and 1.9.3): prefer the final version, then the newest.
        if (candidate) releaseId = byCommit.find((r) => r.sha.startsWith(candidate) && !/-/.test(r.version))?.id ?? byCommit.find((r) => r.sha.startsWith(candidate))?.id;
      }
      if (releaseId) {
        await this.db.update(imageTags).set({ releaseId }).where(eq(imageTags.id, t.id));
        linked++;
      }
    }
    await this.backfillDeploymentReleases(serviceId);
    return linked;
  }

  /**
   * Deployments recorded before their release existed (or before the image tag was linked) get the
   * release attached: by image tag, by digest, or by version. Keeps "runs in" and the release view consistent.
   */
  async backfillDeploymentReleases(serviceId: string): Promise<number> {
    const open = await this.db.select().from(deployments).where(and(eq(deployments.serviceId, serviceId), isNull(deployments.releaseId), isNull(deployments.supersededAt)));
    if (!open.length) return 0;
    const rels = await this.db.select({ id: releases.id, version: releases.version }).from(releases).where(eq(releases.serviceId, serviceId));
    const byVersion = new Map(rels.map((r) => [r.version, r.id]));
    const images = await this.db.select({ id: containerImages.id }).from(containerImages).where(eq(containerImages.serviceId, serviceId));
    const tags = images.length ? await this.db.select().from(imageTags).where(inArray(imageTags.imageId, images.map((i) => i.id))) : [];
    let n = 0;
    for (const d of open) {
      let releaseId: string | null = null;
      if (d.imageTagId) releaseId = tags.find((t) => t.id === d.imageTagId)?.releaseId ?? null;
      if (!releaseId && d.imageRef?.includes('@')) {
        const digest = d.imageRef.split('@')[1];
        releaseId = tags.find((t) => t.digest === digest && t.releaseId)?.releaseId ?? null;
      }
      if (!releaseId && d.version) releaseId = byVersion.get(normalizeVersion(d.version)) ?? null;
      if (releaseId) {
        const version = rels.find((r) => r.id === releaseId)!.version;
        await this.db.update(deployments).set({ releaseId, version: d.version ?? version }).where(eq(deployments.id, d.id));
        n++;
      }
    }
    return n;
  }

  /** Everything the inventory page needs for one service, joined: environments → what runs; releases → images + where; images → releases + where. */
  async serviceOverview(serviceId: string) {
    const [envs, rels, imgs] = await Promise.all([
      this.db.select().from(environments).where(and(eq(environments.serviceId, serviceId), isNull(environments.archivedAt))).orderBy(environments.name),
      this.db.select().from(releases).where(eq(releases.serviceId, serviceId)).orderBy(desc(releases.createdAt)).limit(200),
      this.db.select().from(containerImages).where(eq(containerImages.serviceId, serviceId)).orderBy(containerImages.name),
    ]);
    const tags = imgs.length ? await this.db.select().from(imageTags).where(inArray(imageTags.imageId, imgs.map((i) => i.id))).orderBy(desc(sql`coalesce(${imageTags.builtAt}, ${imageTags.firstSeenAt})`)) : [];
    const current = envs.length ? await this.db.select().from(deployments).where(and(inArray(deployments.environmentId, envs.map((e) => e.id)), isNull(deployments.supersededAt))) : [];
    const sbomRows = await this.db.select({ id: sboms.id, releaseId: sboms.releaseId, imageTagId: sboms.imageTagId, imageDigest: sboms.imageDigest, target: sboms.target, componentCount: sboms.componentCount, createdAt: sboms.createdAt }).from(sboms).where(eq(sboms.serviceId, serviceId)).orderBy(desc(sboms.createdAt));
    // Open findings per SBOM by severity (for the cards).
    const findingRows = sbomRows.length ? await this.db.select({ sbomId: findingSboms.sbomId, severity: findings.severity, advisoryId: findings.advisoryId, canonicalId: findings.canonicalId, packageKey: findings.packageKey, componentId: findings.componentId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).where(and(inArray(findingSboms.sbomId, sbomRows.map((b) => b.id)), inArray(findings.status, ['open', 'fixed']))) : []; // per SBOM: what was IN that image (service-level `fixed` = gone from later builds, still affected here)
    // Per SBOM, unique (canonical advisory, source package) counts — the same unit as `findings environments` — plus the package total.
    const findingsOf = (sbomId: string) => { const u = uniqueVulnerabilities(findingRows.filter((r) => r.sbomId === sbomId)); const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } as Record<Severity, number> & { packages?: number }; for (const r of u.unique) c[r.severity]++; c.packages = u.packages; return c; };
    // Release attribution at read time: a floating tag (preprod, latest, sha256-…) belongs to the release of the VERSION/COMMIT tag that carries its digest.
    const releaseByDigest = new Map<string, string>();
    for (const t of tags) if (t.releaseId && t.digest && InventoryService.isReleaseTag(t.tag) && !releaseByDigest.has(t.digest.toLowerCase())) releaseByDigest.set(t.digest.toLowerCase(), t.releaseId);
    const releaseOf = (t: typeof imageTags.$inferSelect): string | null => (InventoryService.isReleaseTag(t.tag) ? t.releaseId : t.digest ? releaseByDigest.get(t.digest.toLowerCase()) ?? null : null);
    const imageById = new Map(imgs.map((i) => [i.id, i]));
    const tagById = new Map(tags.map((t) => [t.id, t]));
    const releaseById = new Map(rels.map((r) => [r.id, r]));
    const withFindings = <T extends { id: string } | null>(b: T) => (b ? { ...b, findings: findingsOf(b.id) } : null);
    const sbomForRelease = (releaseId: string) => withFindings(sbomRows.find((b) => b.releaseId === releaseId && b.target === 'source') ?? null);
    const sbomForTag = (tagId: string) => { const d = tagById.get(tagId)?.digest?.toLowerCase(); return withFindings((d ? sbomRows.find((b) => b.imageDigest === d) : null) ?? null); };
    /** An image SBOM describes a digest: any tag, in any registry, with the same digest reuses it. */
    const sbomForTagOrDigest = (t: typeof imageTags.$inferSelect) => {
      if (!t.digest) return null;
      const d = t.digest.toLowerCase();
      const own = sbomRows.find((b) => b.imageDigest === d && b.imageTagId === t.id);
      if (own) return { id: own.id, componentCount: own.componentCount, shared: false };
      const viaDigest = sbomRows.find((b) => b.imageDigest === d);
      return viaDigest ? { id: viaDigest.id, componentCount: viaDigest.componentCount, shared: true, from: viaDigest.imageTagId && tagById.get(viaDigest.imageTagId) ? imageById.get(tagById.get(viaDigest.imageTagId)!.imageId)?.name ?? null : null } : null;
    };
    const tagView = (t: typeof imageTags.$inferSelect) => ({ id: t.id, tag: t.tag, digest: t.digest, image: imageById.get(t.imageId)?.name ?? null, releaseId: releaseOf(t), releaseVersion: releaseOf(t) ? (releaseById.get(releaseOf(t)!)?.version ?? null) : null, lastSeenAt: t.lastSeenAt, firstSeenAt: t.firstSeenAt, builtAt: t.builtAt, sbom: sbomForTag(t.id) });
    const envView = envs.map((e) => {
      const d = current.find((x) => x.environmentId === e.id) ?? null;
      const tag = d?.imageTagId ? tagById.get(d.imageTagId) : undefined;
      const release = d?.releaseId ? releaseById.get(d.releaseId) : undefined;
      return {
        id: e.id, name: e.name, slug: e.slug, kind: e.kind, internetFacing: e.internetFacing, settings: e.settings,
        current: d ? { deploymentId: d.id, version: d.version ?? release?.version ?? null, releaseId: d.releaseId, commitSha: release?.commitSha ?? null, imageRef: d.imageRef, imageTag: tag ? tagView(tag) : null, source: d.source, deployedAt: d.deployedAt, sbom: (tag && sbomForTag(tag.id)) ?? (release && sbomForRelease(release.id)) ?? null } : null,
      };
    });
    const releaseTagIds = (releaseId: string) => new Set(tags.filter((t) => t.releaseId === releaseId).map((t) => t.id));
    const releaseDigests = (releaseId: string) => new Set(tags.filter((t) => t.releaseId === releaseId && t.digest).map((t) => t.digest!));
    const releaseView = rels.map((r) => {
      const tagIds = releaseTagIds(r.id);
      const digests = releaseDigests(r.id);
      return {
        ...r,
        images: tags.filter((t) => releaseOf(t) === r.id).map(tagView),
        environments: envView
          .filter((e) => e.current && (e.current.releaseId === r.id || (e.current.imageTag && tagIds.has(e.current.imageTag.id)) || (e.current.imageRef?.includes('@') && digests.has(e.current.imageRef.split('@')[1])) || (e.current.version && normalizeVersion(e.current.version) === r.version)))
          .map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
        sbom: sbomForRelease(r.id),
      };
    });
    const imageView = imgs.map((i) => ({
      ...i,
      tags: tags.filter((t) => t.imageId === i.id).map((t) => {
        // An environment runs from THIS repository when its current imageRef names it (or, for the built-in registry,
        // its environment repository <build>/<env>). The same digest elsewhere is only a hint.
        const repoOfRef = (ref: string | null | undefined) => (ref ? ref.split('@')[0]!.replace(/:[^/:]+$/, '').toLowerCase() : null);
        const here = (e: (typeof envView)[number]) => { const r = repoOfRef(e.current?.imageRef); return !!r && (r === i.name || r === `${i.name}/${e.slug}`); };
        const sameDigest = (e: (typeof envView)[number]) => !!t.digest && !!e.current?.imageRef?.endsWith(`@${t.digest}`);
        const running = envView.filter((e) => (e.current?.imageTag?.id === t.id && (!e.current?.imageRef || here(e))) || (sameDigest(e) && here(e)));
        const elsewhere = envView.filter((e) => !running.includes(e) && sameDigest(e));
        const warnings: { code: 'unaccepted_tag' | 'rebuilt_commit'; message: string }[] = []; // always an array (the CLI/MCP read the same view)
        // (1) Registry ≠ Matelot: a tag named like an environment whose digest is NOT what that environment currently runs
        //     (the deployment was rejected by policy, or the push happened without a deployment). Nothing stops a cluster
        //     pulling `…:preprod`, so say so.
        const envForTag = envView.find((e) => e.slug === t.tag);
        if (envForTag && t.digest) {
          const cur = envForTag.current?.imageRef ? digestOfRef(envForTag.current.imageRef) : null;
          if (!cur) warnings.push({ code: 'unaccepted_tag', message: `tag ${t.tag} is named after the ${envForTag.name} environment but nothing is deployed there` });
          else if (cur !== t.digest.toLowerCase()) warnings.push({ code: 'unaccepted_tag', message: `tag ${t.tag} points to ${t.digest.slice(0, 19)}… but ${envForTag.name} runs ${cur.slice(0, 19)}… (this digest was never accepted for ${envForTag.name})` });
        }
        // (2) Drift: the same release / commit built twice with different digests: environments can diverge while "on the same version"
        if (InventoryService.isReleaseTag(t.tag) && t.releaseId && t.digest) {
          const siblings = tags.filter((o) => InventoryService.isReleaseTag(o.tag) && o.releaseId === t.releaseId && o.digest && o.digest.toLowerCase() !== t.digest!.toLowerCase());
          if (siblings.length) warnings.push({ code: 'rebuilt_commit', message: `${releaseById.get(t.releaseId)?.version ?? 'this release'} was built more than once: ${[...new Set(siblings.map((o) => o.digest!.slice(0, 19)))].join(', ')}… also carry it; environments on the same version may run different images` });
        }
        return { ...tagView(t), digestSbom: sbomForTagOrDigest(t), warnings, environments: running.map((e) => ({ id: e.id, name: e.name, kind: e.kind })), alsoRunningIn: elsewhere.map((e) => ({ id: e.id, name: e.name, kind: e.kind, imageRef: e.current?.imageRef ?? null })) };
      }),
    }));
    return { environments: envView, releases: releaseView, images: imageView };
  }

  // ---------------------------------------------------------------- deployments

  /** Current deployment per environment of the service, plus recent history. */
  async deploymentsOfService(serviceId: string) {
    const envs = await this.db.select().from(environments).where(and(eq(environments.serviceId, serviceId), isNull(environments.archivedAt)));
    const rows = await this.db
      .select({ deployment: deployments, releaseVersion: releases.version, environmentName: environments.name, environmentKind: environments.kind })
      .from(deployments)
      .leftJoin(releases, eq(deployments.releaseId, releases.id))
      .innerJoin(environments, eq(deployments.environmentId, environments.id))
      .where(eq(deployments.serviceId, serviceId))
      .orderBy(desc(deployments.deployedAt))
      .limit(200);
    const history = rows.map((r) => ({ ...r.deployment, releaseVersion: r.releaseVersion, environmentName: r.environmentName, environmentKind: r.environmentKind }));
    return { environments: envs.map((e) => ({ ...e, current: history.find((d) => d.environmentId === e.id && !d.supersededAt) ?? null })), history };
  }

  async recordDeployment(user: AuthenticatedUser | null, chain: ScopeChain, dto: RecordDeploymentDto, source: typeof deployments.$inferInsert.source = dto.source ?? 'api', options: { registerImage?: boolean; imageLookupName?: string } = {}) {
    const environmentId = chain.environmentId!;
    const serviceId = chain.serviceId!;
    // A digest reference must be a real digest — a typo here would poison what the platform believes is running.
    if (dto.imageRef?.includes('@') && !/@sha256:[0-9a-f]{64}$/i.test(dto.imageRef)) throw new BadRequestException(`Invalid image reference "${dto.imageRef}": after "@" expect sha256:<64 hex characters>; use "<image>:<tag>" to reference a tag`);
    // Policies with "enforce on deploy": a failing gate rejects the deployment before anything is recorded.
    if (this.policies && source !== 'kubernetes') await this.policies.enforceOnDeploy(chain, environmentId, { imageRef: dto.imageRef, version: dto.version }, user ? (user.token ? `token ${user.token.name}` : user.email) : source, (dto.waitCorrelation ?? 0) * 1000);
    let releaseId = dto.releaseId ?? null;
    let version = dto.version ? normalizeVersion(dto.version) : null;
    if (!releaseId && version) {
      const [rel] = await this.db.select({ id: releases.id }).from(releases).where(and(eq(releases.serviceId, serviceId), eq(releases.version, version))).limit(1);
      releaseId = rel?.id ?? null;
      // A deployment that names a version is authoritative: the release exists from this moment on, whatever
      // git/webhook sync does later (it enriches the same row: commit, URL, notes). Only version-like names count.
      if (!releaseId && /^\d+(\.\d+)+([-+.][0-9A-Za-z.-]+)?$/.test(version)) {
        const [created] = await this.db
          .insert(releases)
          .values({ organizationId: chain.organizationId, serviceId, version, tag: dto.version ?? version, commitSha: dto.commitSha ?? null, source: 'api', releasedAt: new Date() })
          .onConflictDoNothing()
          .returning({ id: releases.id });
        releaseId = created?.id ?? (await this.db.select({ id: releases.id }).from(releases).where(and(eq(releases.serviceId, serviceId), eq(releases.version, version))).limit(1))[0]?.id ?? null;
        if (created) await this.audit.record({ organizationId: chain.organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'release.created', resourceType: 'release', resourceId: created.id, after: { version, commitSha: dto.commitSha ?? null, from: 'deployment' } });
      }
    }
    // A release created first by `promote` (no commit) gets its commit from the first deployment that carries one.
    const warnings: string[] = [];
    if (releaseId && dto.commitSha) {
      const [rel] = await this.db.select({ commitSha: releases.commitSha, version: releases.version }).from(releases).where(eq(releases.id, releaseId)).limit(1);
      if (rel && !rel.commitSha) await this.db.update(releases).set({ commitSha: dto.commitSha }).where(eq(releases.id, releaseId));
      else if (rel?.commitSha && !rel.commitSha.toLowerCase().startsWith(dto.commitSha.toLowerCase()) && !dto.commitSha.toLowerCase().startsWith(rel.commitSha.toLowerCase())) warnings.push(`release ${rel.version} is recorded for commit ${rel.commitSha.slice(0, 12)}, this deployment says ${dto.commitSha.slice(0, 12)}; kept the recorded one`);
    }
    if (releaseId && !version) {
      const [rel] = await this.db.select({ version: releases.version }).from(releases).where(eq(releases.id, releaseId)).limit(1);
      version = rel?.version ?? null;
    }
    let imageTagId: string | null = null;
    if (dto.imageRef) {
      const [refName, tagOrDigest] = dto.imageRef.includes('@') ? dto.imageRef.split('@') : dto.imageRef.split(/:(?=[^/]+$)/);
      const name = options.imageLookupName ?? refName;
      let [img] = await this.db.select({ id: containerImages.id }).from(containerImages).where(and(eq(containerImages.serviceId, serviceId), eq(containerImages.name, name.toLowerCase()))).limit(1);
      if (!img && options.registerImage !== false) {
        // First time this image is reported: register it (registry connection picked by host when one is on the project's path).
        const registry = await this.registryFor(chain, name.toLowerCase());
        [img] = await this.db.insert(containerImages).values({ organizationId: chain.organizationId, serviceId, integrationId: registry?.id ?? null, name: name.toLowerCase(), createdById: userIdOrNull(user) }).onConflictDoNothing().returning({ id: containerImages.id });
        if (img) {
          await this.audit.record({ organizationId: chain.organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'image.discovered', resourceType: 'container_image', resourceId: img.id, after: { name: name.toLowerCase(), from: 'deployment' } });
          await this.syncImage(img.id, name.startsWith('localhost')).catch(() => undefined);
        }
      }
      if (img && tagOrDigest) {
        let [t] = await this.db.select({ id: imageTags.id, releaseId: imageTags.releaseId }).from(imageTags).where(and(eq(imageTags.imageId, img.id), dto.imageRef.includes('@') ? eq(imageTags.digest, tagOrDigest) : eq(imageTags.tag, tagOrDigest))).limit(1);
        if (!t && dto.imageRef.includes('@')) {
          // A digest we have not seen: the image was pushed after the last sync — read the registry now and look again.
          await this.syncImage(img.id, name.startsWith('localhost')).catch(() => undefined);
          [t] = await this.db.select({ id: imageTags.id, releaseId: imageTags.releaseId }).from(imageTags).where(and(eq(imageTags.imageId, img.id), eq(imageTags.digest, tagOrDigest))).limit(1);
          // Still unknown (digest not synced yet, or the registry reports a different manifest digest for a multi-arch image):
          // create the tag row in THIS registry's image — never borrow a same-digest row of another registry
          // (preprod/ACR once pointed at Docker Hub's `test` row). Tag name from the ref when it has one, else a digest name.
          if (!t) {
            const tagInRef = refName.includes(':') && !refName.includes('/') ? null : (/:([^/:]+)$/.exec(refName)?.[1] ?? null);
            [t] = await this.db.insert(imageTags).values({ imageId: img.id, tag: tagInRef ?? `sha256-${tagOrDigest.replace(/^sha256:/, '').slice(0, 12)}`, digest: tagOrDigest }).onConflictDoNothing().returning({ id: imageTags.id, releaseId: imageTags.releaseId });
            if (!t) [t] = await this.db.select({ id: imageTags.id, releaseId: imageTags.releaseId }).from(imageTags).where(and(eq(imageTags.imageId, img.id), eq(imageTags.digest, tagOrDigest))).limit(1);
          }
        }
        if (!t && !dto.imageRef.includes('@')) {
          // The registry has not been read yet (or the tag is brand new): record the tag now, digest arrives with the next sync.
          [t] = await this.db.insert(imageTags).values({ imageId: img.id, tag: tagOrDigest }).onConflictDoNothing().returning({ id: imageTags.id, releaseId: imageTags.releaseId });
        }
        imageTagId = t?.id ?? null;
        if (!releaseId && t?.releaseId) releaseId = t.releaseId;
        // Rule 2: a deployment that names both a version and an image links the image tag to that release, whatever the tag is called.
        if (t && releaseId && !t.releaseId) await this.db.update(imageTags).set({ releaseId }).where(eq(imageTags.id, t.id));
        // ...and every other tag of the service with the same digest (the same image copied to other registries is the same release).
        if (t && releaseId) {
          const [d] = await this.db.select({ digest: imageTags.digest }).from(imageTags).where(eq(imageTags.id, t.id)).limit(1);
          if (d?.digest) {
            const imgIds = (await this.db.select({ id: containerImages.id }).from(containerImages).where(eq(containerImages.serviceId, serviceId))).map((r) => r.id);
            if (imgIds.length) await this.db.update(imageTags).set({ releaseId }).where(and(inArray(imageTags.imageId, imgIds), eq(imageTags.digest, d.digest), isNull(imageTags.releaseId), sql`${imageTags.tag} ~ '^v?[0-9]+(\\.[0-9]+)+' or ${imageTags.tag} ~* '^(sha-)?[0-9a-f]{7,40}([-_.][a-z0-9-]+)?$'`));
          }
        }
        // What runs gets scanned: an image SBOM for the deployed tag, unless one exists already.
        if (t && !dto.imageRef.includes('@')) await this.queueImageSbom(serviceId, name.toLowerCase(), tagOrDigest, t.id);
        else if (t && dto.imageRef.includes('@')) {
          const [tagRow] = await this.db.select({ tag: imageTags.tag }).from(imageTags).where(eq(imageTags.id, t.id)).limit(1);
          if (tagRow) await this.queueImageSbom(serviceId, name.toLowerCase(), tagRow.tag, t.id);
        }
      }
    }
    if (releaseId && !version) {
      const [rel] = await this.db.select({ version: releases.version }).from(releases).where(eq(releases.id, releaseId)).limit(1);
      version = rel?.version ?? null;
    }
    if (!version && !releaseId && !dto.imageRef) throw new BadRequestException('Give a version, a releaseId or an imageRef');
    const now = dto.deployedAt ? new Date(dto.deployedAt) : new Date();
    const [deployment] = await this.db.transaction(async (tx) => {
      await tx.update(deployments).set({ supersededAt: now }).where(and(eq(deployments.environmentId, environmentId), isNull(deployments.supersededAt)));
      return tx.insert(deployments).values({ organizationId: chain.organizationId, serviceId, environmentId, releaseId, imageTagId, version, imageRef: dto.imageRef ?? null, source, metadata: dto.metadata ?? {}, deployedAt: now, deployedById: userIdOrNull(user) }).returning();
    });
    if (this.notifications) {
      const [envRow] = await this.db.select({ name: environments.name, kind: environments.kind, internetFacing: environments.internetFacing }).from(environments).where(eq(environments.id, environmentId)).limit(1);
      if (envRow?.kind === 'production') { const [svc] = await this.db.select({ name: services.name }).from(services).where(eq(services.id, serviceId)).limit(1); void this.notifications.notify({ event: 'deployment.production', organizationId: chain.organizationId, projectId: chain.projectId, severity: 'info', title: `Deployed to production · ${svc?.name ?? 'service'}`, text: `${version ?? 'a build'} is now running in ${envRow.name}${envRow.internetFacing ? ' (internet-facing)' : ''}.`, fields: { version, image: dto.imageRef ?? undefined, source, by: user ? (user.token ? `token ${user.token.name}` : user.email) : source } }); }
    }
    await this.audit.record({ organizationId: chain.organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'deployment.recorded', resourceType: 'environment', resourceId: environmentId, after: { version, imageRef: dto.imageRef ?? null, source, environmentName: (await this.db.select({ name: environments.name }).from(environments).where(eq(environments.id, environmentId)).limit(1))[0]?.name ?? null } });
    return warnings.length ? { ...deployment, warnings } : deployment;
  }

  /** Result of a `kubernetes_inventory` job: workloads → deployments of the environment. */
  async applyKubernetesInventory(chain: ScopeChain, result: { namespace: string; workloads: { name: string; kind: string; replicas?: number; images: string[] }[] }) {
    const environmentId = chain.environmentId!;
    const serviceId = chain.serviceId!;
    const images = await this.db.select().from(containerImages).where(eq(containerImages.serviceId, serviceId));
    const names = new Set(images.map((i) => i.name));
    let recorded = 0;
    for (const w of result.workloads) {
      for (const ref of w.images) {
        const name = (ref.includes('@') ? ref.split('@')[0] : ref.split(/:(?=[^/]+$)/)[0]).toLowerCase();
        // Only images that belong to this service (registered) are deployments of it; others are noise.
        if (!names.has(name) && !names.has(parseImageName(name).repository)) continue;
        const [current] = await this.db.select().from(deployments).where(and(eq(deployments.environmentId, environmentId), isNull(deployments.supersededAt))).limit(1);
        if (current?.imageRef === ref) continue;
        await this.recordDeployment(null, chain, { imageRef: ref, metadata: { namespace: result.namespace, workload: w.name, kind: w.kind, replicas: w.replicas ?? null } }, 'kubernetes');
        recorded++;
      }
    }
    return { recorded, workloads: result.workloads.length };
  }

  /** Organization-wide: what runs where (for dashboards and the graph). */
  async currentDeployments(organizationId: string) {
    return this.db
      .select({ deployment: deployments, environment: environments, serviceName: services.name, releaseVersion: releases.version })
      .from(deployments)
      .innerJoin(environments, eq(deployments.environmentId, environments.id))
      .innerJoin(services, eq(deployments.serviceId, services.id))
      .leftJoin(releases, eq(deployments.releaseId, releases.id))
      .where(and(eq(deployments.organizationId, organizationId), isNull(deployments.supersededAt)))
      .orderBy(desc(deployments.deployedAt));
  }

  async projectSummary(projectId: string) {
    const svc = await this.db.select({ id: services.id }).from(services).where(and(eq(services.projectId, projectId), isNull(services.archivedAt)));
    const ids = svc.map((s) => s.id);
    if (!ids.length) return { releases: 0, images: 0, deployments: 0 };
    const [[r], [i], [d]] = await Promise.all([
      this.db.select({ n: sql<number>`count(*)` }).from(releases).where(inArray(releases.serviceId, ids)),
      this.db.select({ n: sql<number>`count(*)` }).from(containerImages).where(inArray(containerImages.serviceId, ids)),
      this.db.select({ n: sql<number>`count(*)` }).from(deployments).where(and(inArray(deployments.serviceId, ids), isNull(deployments.supersededAt))),
    ]);
    return { releases: Number(r.n), images: Number(i.n), deployments: Number(d.n) };
  }
}
