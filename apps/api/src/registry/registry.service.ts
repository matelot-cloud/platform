import { forwardRef, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { CryptoService } from '../common/crypto.service';
import { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { apiTokens, containerImages, environments, imageTags, projects, services, teams, workspaces, releases } from '../database/schema';
import { InventoryService } from '../inventory/inventory.service';
import { RegistryClient } from '../inventory/registry.client';
import { JobsService } from '../execution/jobs.service';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { issueRegistryToken, loadRegistryKey, RegistryAccess, verifyRegistryToken } from './registry-token';

export interface RegistryEvent {
  action: string;
  target: { mediaType?: string; repository: string; tag?: string; digest?: string; size?: number };
  actor?: { name?: string };
  timestamp?: string;
}

/**
 * The built-in registry: Docker Distribution inside the cell, auth delegated here.
 * Naming convention: <project-slug>/<service-slug>[/<anything>]. A project CI token may push and
 * pull under its project's path; organization-level tokens anywhere in the organization.
 */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);
  readonly host?: string;
  /** Base URL the API uses to talk to the built-in registry (REGISTRY_INTERNAL_URL), else derived from the public host. */
  readonly internalUrl?: string;
  readonly issuer: string;
  readonly service: string;
  private readonly key?: ReturnType<typeof loadRegistryKey>;
  private readonly eventsSecret?: string;

  constructor(
    @Inject(ConfigService) config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => JobsService)) private readonly jobs: JobsService,
    private readonly resolver: ScopeResolverService,
    private readonly personalTokens: PersonalTokensService,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    @Inject(forwardRef(() => InventoryService)) private readonly inventory: InventoryService,
  ) {
    this.host = config.get('REGISTRY_HOST', { infer: true });
    this.internalUrl = config.get('REGISTRY_INTERNAL_URL', { infer: true });
    this.issuer = config.get('REGISTRY_ISSUER', { infer: true });
    this.service = config.get('REGISTRY_SERVICE', { infer: true });
    this.eventsSecret = config.get('REGISTRY_EVENTS_SECRET', { infer: true });
    const keyPath = config.get('REGISTRY_TOKEN_KEY_PATH', { infer: true });
    if (this.host && keyPath) {
      try {
        this.key = loadRegistryKey(readFileSync(keyPath, 'utf8'));
        this.logger.log(`Built-in registry ${this.host} enabled (kid ${this.key.kid.slice(0, 9)}…)`);
      } catch (error) {
        this.logger.error(`REGISTRY_TOKEN_KEY_PATH unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  get available(): boolean {
    return !!this.host && !!this.key;
  }

  info() {
    return {
      available: this.available,
      host: this.host ?? null,
      convention: '<workspace>/<team>/<project>/<service>:<tag> for builds · <workspace>/<team>/<project>/<service>/<environment>:<tag> = deployed to that environment',
      login: this.host ? `docker login ${this.host} -u <CI token key id> -p <CI token secret>` : null,
      // what a push must look like, and why a free-form repository name is refused by the token endpoint
      pathRule: 'Repositories are the slugs of the service path (lower case): `matelot registry path --service <serviceId>` prints the full pushable reference (host included); `--env <environmentId>` the environment variant. A push to any other name is refused by the registry with "insufficient_scope: authorization failed" — the token endpoint only grants what the service path and the token\'s scope allow.',
      pathCommand: 'matelot registry path --service <serviceId> [--env <environmentId>]',
    };
  }

  /** Docker's token endpoint: Basic auth = CI token (keyId:secret) → JWT limited to what that token may do. */
  async token(basic: string | undefined, scopes: RegistryAccess[]): Promise<{ token: string; access_token: string; expires_in: number; issued_at: string }> {
    if (!this.key) throw new UnauthorizedException('Built-in registry is not enabled on this cell');
    const decoded = basic?.startsWith('Basic ') ? Buffer.from(basic.slice(6), 'base64').toString('utf8') : '';
    const [keyId, secret] = decoded.includes(':') ? [decoded.slice(0, decoded.indexOf(':')), decoded.slice(decoded.indexOf(':') + 1)] : ['', ''];
    if (!keyId || !secret) {
      // Anonymous: no access at all (private registry).
      const t = issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: 'anonymous', access: [] });
      return { token: t.token, access_token: t.token, expires_in: t.expiresIn, issued_at: t.issuedAt };
    }
    if (keyId === 'platform') {
      // The platform (inventory sync, runners scanning images) authenticates with a token it issued itself.
      const presented = verifyRegistryToken(this.key.publicKey, secret);
      if (!presented || presented.sub !== 'platform') throw new UnauthorizedException('Invalid platform registry token');
      const allowed = scopes.filter((s) => presented.access.some((a) => a.type === s.type && a.name === s.name)).map((s) => ({ ...s, actions: s.actions.filter((x) => presented.access.find((a) => a.name === s.name)!.actions.includes(x)) })).filter((s) => s.actions.length);
      const t = issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: 'platform', access: allowed });
      return { token: t.token, access_token: t.token, expires_in: t.expiresIn, issued_at: t.issuedAt };
    }
    // Personal access token (`docker login -u token -p spt_…`, what `matelot registry login` does with MATELOT_TOKEN):
    // access follows the user's RBAC on each repository's service (registry:pull / registry:push), the username is a label.
    if (secret.startsWith('spt_')) {
      const found = await this.personalTokens.authenticate(secret);
      if (!found) throw new UnauthorizedException('Invalid, expired or revoked personal access token');
      const ctx = await this.access.forUser(found.user.id);
      const granted: RegistryAccess[] = [];
      for (const sc of scopes) {
        if (sc.type !== 'repository') continue;
        const target = await this.resolvePath(sc.name);
        if (!target) continue;
        const chain = await this.resolver.resolveChain({ serviceId: target.serviceId });
        const can = (perm: 'registry:pull' | 'registry:push') => found.user.platformRole === 'admin' && found.scope === 'sudo' ? true : this.authorization.hasPermission(ctx, perm, chain);
        let actions = sc.actions.filter((a) => (a === 'pull' && found.scope !== undefined && can('registry:pull')) || (a === 'push' && found.scope !== 'read' && can('registry:push')));
        if (actions.includes('push') && target.environment?.protected && found.scope !== 'sudo') actions = actions.filter((a) => a !== 'push'); // protected environments: CI tokens with an allowance, or sudo
        if (actions.length) granted.push({ type: 'repository', name: sc.name, actions });
      }
      const t = issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: `user:${found.user.email}`, access: granted });
      return { token: t.token, access_token: t.token, expires_in: t.expiresIn, issued_at: t.issuedAt };
    }
    const [token] = await this.db.select().from(apiTokens).where(eq(apiTokens.keyId, keyId)).limit(1);
    if (!token || token.revokedAt || (token.expiresAt && token.expiresAt < new Date())) throw new UnauthorizedException('Unknown, expired or revoked token');
    const stored = Buffer.from(this.crypto.decrypt(Buffer.from(token.secretEncrypted)));
    const given = Buffer.from(secret);
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) throw new UnauthorizedException('Invalid credentials');

    const prefix = await this.pathPrefixFor(token.scopeType, token.scopeId);
    const granted: RegistryAccess[] = [];
    for (const s of scopes) {
      if (s.type !== 'repository') continue;
      if (prefix !== null && !(s.name === prefix || s.name.startsWith(`${prefix}/`))) continue;
      let actions = s.actions.filter((a) => (a === 'pull' && token.permissions.includes('registry:pull')) || (a === 'push' && token.permissions.includes('registry:push')));
      // Pushing into an environment repository deploys there: protected environments need an explicit allowance on the token.
      if (actions.includes('push')) {
        const target = await this.resolvePath(s.name);
        if (target?.environment && target.environment.protected && !token.environments.includes(target.environment.slug)) actions = actions.filter((a) => a !== 'push');
      }
      if (actions.length) granted.push({ type: 'repository', name: s.name, actions });
    }
    await this.db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, token.id));
    const t = issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: token.keyId, access: granted });
    return { token: t.token, access_token: t.token, expires_in: t.expiresIn, issued_at: t.issuedAt };
  }

  /** Repository prefix a token may use: the namespace path of its scope (organization → any). */
  private async pathPrefixFor(scopeType: string, scopeId: string): Promise<string | null> {
    if (scopeType === 'PROJECT') {
      const [p] = await this.db.select({ ws: workspaces.slug, team: teams.slug, project: projects.slug }).from(projects).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(projects.id, scopeId)).limit(1);
      return p ? `${p.ws}/${p.team}/${p.project}` : null;
    }
    if (scopeType === 'TEAM') {
      const [t] = await this.db.select({ ws: workspaces.slug, team: teams.slug }).from(teams).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(teams.id, scopeId)).limit(1);
      return t ? `${t.ws}/${t.team}` : null;
    }
    if (scopeType === 'WORKSPACE') {
      const [w] = await this.db.select({ ws: workspaces.slug }).from(workspaces).where(eq(workspaces.id, scopeId)).limit(1);
      return w?.ws ?? null;
    }
    return null;
  }

  /** <ws>/<team>/<project>/<service>[/<env>] → service (+ environment). */
  async resolvePath(path: string): Promise<{ serviceId: string; organizationId: string; buildName: string; environment?: { id: string; slug: string; protected: boolean } } | null> {
    const parts = path.split('/');
    if (parts.length < 4 || parts.length > 5) return null;
    const [ws, team, project, service, envSlug] = parts;
    const [row] = await this.db
      .select({ serviceId: services.id, organizationId: workspaces.organizationId })
      .from(services)
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(and(eq(workspaces.slug, ws), eq(teams.slug, team), eq(projects.slug, project), eq(services.slug, service), isNull(services.archivedAt)))
      .limit(1);
    if (!row) return null;
    const buildName = `${this.host}/${ws}/${team}/${project}/${service}`.toLowerCase();
    if (!envSlug) return { ...row, buildName };
    const [env] = await this.db.select().from(environments).where(and(eq(environments.serviceId, row.serviceId), eq(environments.slug, envSlug), isNull(environments.archivedAt))).limit(1);
    return { ...row, buildName, environment: env ? { id: env.id, slug: env.slug, protected: env.settings.protected === true } : undefined };
  }

  /**
   * Worker: reconcile the inventory with the registry's own state (catalog + tags). Covers pushes whose
   * notification never arrived (proxies, restarts, dev networking): new build tags are registered and
   * scanned, environment repositories become deployments.
   */
  /** Promote, the registry notification and the reconcile pass can all report the same environment at once: serialise per environment. */
  private readonly envLocks = new Map<string, Promise<unknown>>();
  private async withEnvLock<T>(environmentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.envLocks.get(environmentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.envLocks.set(environmentId, run);
    try {
      return await run;
    } finally {
      if (this.envLocks.get(environmentId) === run) this.envLocks.delete(environmentId);
    }
  }

  async reconcile(): Promise<{ repositories: number; newTags: number }> {
    if (!this.host || !this.key) return { repositories: 0, newTags: 0 };
    const insecure = !this.host.includes('.') || this.host.startsWith('localhost');
    const catalogToken = issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: 'platform', access: [{ type: 'registry', name: 'catalog', actions: ['*'] }] }).token;
    const repos = await new RegistryClient({ registry: this.host, repository: '_catalog' }, { type: 'none' }, insecure, catalogToken, this.internalUrl).catalog();
    let newTags = 0;
    for (const repo of repos) {
      const match = await this.resolvePath(repo).catch(() => null);
      if (!match) continue;
      const client = new RegistryClient({ registry: this.host, repository: repo }, { type: 'none' }, insecure, this.internalToken(repo)!, this.internalUrl);
      const tags = await client.tags().catch(() => [] as string[]);
      if (!tags.length) continue;
      const [img] = await this.db.insert(containerImages).values({ organizationId: match.organizationId, serviceId: match.serviceId, integrationId: null, name: match.buildName }).onConflictDoUpdate({ target: [containerImages.serviceId, containerImages.name], set: { lastSyncedAt: new Date(), lastError: null } }).returning();
      const known = new Map((await this.db.select({ tag: imageTags.tag, digest: imageTags.digest }).from(imageTags).where(eq(imageTags.imageId, img.id))).map((t) => [t.tag, t.digest]));
      for (const tag of tags) {
        const digest = await client.digest(tag).catch(() => null);
        if (!digest) continue;
        const isNew = !known.has(tag) || known.get(tag) !== digest;
        if (isNew) newTags++;
        await this.handleEvents([{ action: 'push', target: { mediaType: 'application/vnd.docker.distribution.manifest.v2+json', repository: repo, tag, digest }, actor: { name: 'reconcile' } }]).catch((e: Error) => this.logger.warn(`reconcile ${repo}:${tag}: ${e.message}`));
        if (!isNew) continue;
      }
    }
    return { repositories: repos.length, newTags };
  }

  /** A token the platform uses to read its own registry (inventory sync). */
  internalToken(repository: string, actions: string[] = ['pull']): string | null {
    if (!this.key) return null;
    return issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: 'platform', access: [{ type: 'repository', name: repository, actions }] }).token;
  }

  /** Pull credentials for a built-in registry image (runner side): a short-lived token as the password. */
  async internalCredentialsFor(imageName: string): Promise<{ kind: 'registry'; host: string; username: string; secret: string } | null> {
    if (!this.host || !this.key || !imageName.startsWith(`${this.host.toLowerCase()}/`)) return null;
    const repository = imageName.slice(this.host.length + 1);
    return { kind: 'registry', host: this.host, username: 'platform', secret: this.internalToken(repository)! };
  }

  isEventsSecretValid(header: string | undefined): boolean {
    if (!this.eventsSecret) return false;
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = Buffer.from(this.eventsSecret);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Push notifications from the registry: register the image on the matching service, record the tag, queue an SBOM. */
  async handleEvents(events: RegistryEvent[]): Promise<{ recorded: number; ignored: number }> {
    let recorded = 0;
    let ignored = 0;
    for (const e of events) {
      // manifests, manifest lists and OCI image indexes (BuildKit pushes indexes when attestations are on)
      if (e.action !== 'push' || !e.target?.tag || !e.target.digest || !/manifest|index/.test(e.target.mediaType ?? '')) {
        ignored++;
        continue;
      }
      const match = await this.resolvePath(e.target.repository);
      if (!match) {
        this.logger.warn(`push to ${e.target.repository} does not match <workspace>/<team>/<project>/<service>[/<environment>]; ignored`);
        ignored++;
        continue;
      }
      const envSlug = e.target.repository.split('/')[4];
      const buildName = match.buildName;
      const name = `${this.host}/${e.target.repository}`.toLowerCase();
      const actor = { type: 'SYSTEM' as const, id: 'registry', label: `registry push by ${e.actor?.name ?? 'unknown'}` };
      // Build images live under <project>/<service>; environment repositories under <project>/<service>/<env>.
      const [img] = await this.db.insert(containerImages).values({ organizationId: match.organizationId, serviceId: match.serviceId, integrationId: null, name: envSlug ? buildName : name }).onConflictDoUpdate({ target: [containerImages.serviceId, containerImages.name], set: { lastSyncedAt: new Date(), lastError: null } }).returning();
      // The tag is recorded on the build repository so one digest has one SBOM, wherever it is promoted.
      const [existingTag] = await this.db.select({ id: imageTags.id, digest: imageTags.digest }).from(imageTags).where(and(eq(imageTags.imageId, img.id), eq(imageTags.tag, e.target.tag))).limit(1);
      let alreadyKnown = existingTag?.digest === e.target.digest;
      let builtAt: Date | null | undefined;
      let tag: typeof imageTags.$inferSelect;
      if (envSlug && existingTag && existingTag.digest !== e.target.digest) {
        // Environment repository holds this tag name with ANOTHER digest than the build repository (the build was
        // re-pushed under the same tag after the promotion). The environment runs what it holds: resolve the build
        // tag by digest instead of overwriting the build tag's digest — never let the two flip-flop.
        const [byDigest] = await this.db.select().from(imageTags).where(and(eq(imageTags.imageId, img.id), eq(imageTags.digest, e.target.digest))).limit(1);
        if (byDigest) {
          tag = byDigest;
          alreadyKnown = true;
        } else {
          const insecure = !this.host!.includes('.') || this.host!.startsWith('localhost');
          builtAt = await new RegistryClient({ registry: this.host!, repository: e.target.repository }, { type: 'none' }, insecure, this.internalToken(e.target.repository)!).builtAt(e.target.digest);
          [tag] = await this.db.insert(imageTags).values({ imageId: img.id, tag: `${envSlug}/${e.target.tag}`, digest: e.target.digest, builtAt: builtAt ?? null }).onConflictDoUpdate({ target: [imageTags.imageId, imageTags.tag], set: { digest: e.target.digest, lastSeenAt: new Date(), ...(builtAt ? { builtAt } : {}) } }).returning();
          alreadyKnown = false;
        }
      } else {
        if (!alreadyKnown || !existingTag) {
          const insecure = !this.host!.includes('.') || this.host!.startsWith('localhost');
          builtAt = await new RegistryClient({ registry: this.host!, repository: e.target.repository }, { type: 'none' }, insecure, this.internalToken(e.target.repository)!).builtAt(e.target.digest);
        }
        [tag] = await this.db.insert(imageTags).values({ imageId: img.id, tag: e.target.tag, digest: e.target.digest, builtAt: builtAt ?? null }).onConflictDoUpdate({ target: [imageTags.imageId, imageTags.tag], set: { digest: e.target.digest, lastSeenAt: new Date(), ...(builtAt ? { builtAt } : {}) } }).returning();
      }
      if (!alreadyKnown) {
        await this.audit.record({ organizationId: match.organizationId, actor, action: 'image.pushed', resourceType: 'container_image', resourceId: img.id, after: { repository: e.target.repository, tag: e.target.tag, digest: e.target.digest } });
        await this.inventory.matchTagsToReleases(match.serviceId).catch(() => 0);
      }

      if (envSlug) {
        // Push into an environment repository = deployment to that environment.
        const env = match.environment;
        if (!env) {
          this.logger.warn(`push to ${e.target.repository}: environment "${envSlug}" does not exist on the service; recorded as a build only`);
        } else await this.withEnvLock(env.id, async () => {
          const chain = await this.resolver.resolveChain({ environmentId: env.id });
          const current = await this.inventory.currentDeploymentOf(env.id);
          const reconcile = e.actor?.name === 'reconcile';
          // The reconcile pass replays every tag of the environment repository. It must never overwrite what is
          // already recorded (by promote, a real push, `secops deploy` from another registry, Kubernetes…): it only
          // fills an empty environment, or records a tag that was built after the current deployment (a push we missed).
          const newerThanCurrent = !!current && !!tag.builtAt && tag.builtAt.getTime() > new Date(current.deployedAt).getTime() + 60_000;
          if (current?.imageRef === `${name}@${e.target.digest}` || (current && (current.imageTagId === tag.id || (tag.digest && current.imageRef?.endsWith(`@${tag.digest}`))))) {
            // already recorded
          } else if (reconcile && current && !newerThanCurrent) {
            // an older tag lying in the environment repository: leave the current deployment alone
          } else {
            // The environment path is what runs; the tag/digest is looked up on the build image so nothing is duplicated.
            await this.inventory.recordDeployment(null, chain, { imageRef: `${name}@${e.target.digest}`, version: tag.releaseId ? undefined : e.target.tag, metadata: { repository: e.target.repository, tag: e.target.tag, pushedBy: e.actor?.name ?? null } }, 'registry', { registerImage: false, imageLookupName: buildName });
          }
        });
      }
      // One SBOM per digest: scan build images; environment repositories reuse the build's SBOM (queueImageSbom dedups and backs off after failures).
      if (!envSlug && !alreadyKnown) await this.inventory.queueImageSbomFor(match.serviceId, name, e.target.tag, tag.id);
      recorded++;
    }
    return { recorded, ignored };
  }

  /** Build repository of a service plus its environment repositories. */
  async serviceRepository(serviceId: string): Promise<{ host: string; repository: string; environments: { id: string; slug: string; name: string; repository: string; protected: boolean }[] } | null> {
    if (!this.host) return null;
    const [row] = await this.db.select({ ws: workspaces.slug, team: teams.slug, project: projects.slug, service: services.slug }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(services.id, serviceId)).limit(1);
    if (!row) return null;
    const repository = `${row.ws}/${row.team}/${row.project}/${row.service}`;
    const envs = await this.db.select().from(environments).where(and(eq(environments.serviceId, serviceId), isNull(environments.archivedAt)));
    return { host: this.host, repository, environments: envs.map((e) => ({ id: e.id, slug: e.slug, name: e.name, repository: `${repository}/${e.slug}`, protected: e.settings.protected === true })) };
  }

  /** Environment repository path for pulls/pushes: <project>/<service>/<env>. */
  async environmentRepository(environmentId: string): Promise<{ host: string; repository: string; build: string; protected: boolean } | null> {
    if (!this.host) return null;
    const [row] = await this.db.select({ ws: workspaces.slug, team: teams.slug, project: projects.slug, service: services.slug, env: environments.slug, protectedFlag: environments.settings }).from(environments).innerJoin(services, eq(environments.serviceId, services.id)).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(environments.id, environmentId)).limit(1);
    return row ? { host: this.host, repository: `${row.ws}/${row.team}/${row.project}/${row.service}/${row.env}`, build: `${row.ws}/${row.team}/${row.project}/${row.service}`, protected: row.protectedFlag.protected === true } : null;
  }

  /** Server-side promotion: copies build image <project>/<service>:<tag> into the environment repository (blob mounts, no re-upload). The registry then reports the push, which records the deployment. */
  /** Fill the commit of the release a promoted tag belongs to (by version = tag, or by the tag's release link), if unset. */
  async recordReleaseCommit(serviceId: string, tag: string, digest: string | null, commit: string): Promise<void> {
    const version = tag.replace(/^v(?=\d)/, '');
    const byVersion = await this.db.select({ id: releases.id }).from(releases).where(and(eq(releases.serviceId, serviceId), eq(releases.version, version), isNull(releases.commitSha)));
    const byDigest = digest ? await this.db.select({ id: imageTags.releaseId }).from(imageTags).innerJoin(containerImages, eq(imageTags.imageId, containerImages.id)).where(and(eq(containerImages.serviceId, serviceId), eq(imageTags.digest, digest))) : [];
    const ids = [...new Set([...byVersion.map((r) => r.id), ...byDigest.map((r) => r.id)].filter((x): x is string => !!x))];
    if (ids.length) await this.db.update(releases).set({ commitSha: commit }).where(and(inArray(releases.id, ids), isNull(releases.commitSha)));
  }

  async promote(serviceId: string, tag: string, environmentId: string): Promise<{ from: string; to: string; digest: string | null }> {
    if (!this.host || !this.key) throw new Error('Built-in registry is not enabled');
    const target = await this.environmentRepository(environmentId);
    if (!target) throw new Error('Environment not found');
    const source = target.build;
    void serviceId;
    const insecure = !this.host.includes('.') || this.host.startsWith('localhost');
    const src = new RegistryClient({ registry: this.host, repository: source }, { type: 'none' }, insecure, this.internalToken(source, ['pull']) ?? undefined);
    const dst = new RegistryClient({ registry: this.host, repository: target.repository }, { type: 'none' }, insecure, issueRegistryToken(this.key, { issuer: this.issuer, service: this.service, subject: 'platform', access: [{ type: 'repository', name: target.repository, actions: ['pull', 'push'] }, { type: 'repository', name: source, actions: ['pull'] }] }).token);
    const manifest = await src.manifest(tag);
    const parsed = JSON.parse(manifest.body.toString('utf8')) as { config?: { digest: string }; layers?: { digest: string }[]; manifests?: { digest: string }[] };
    if (parsed.manifests) {
      // Image index: copy each platform manifest first.
      for (const m of parsed.manifests) {
        const sub = await src.manifest(m.digest);
        const subParsed = JSON.parse(sub.body.toString('utf8')) as { config?: { digest: string }; layers?: { digest: string }[] };
        for (const blob of [subParsed.config, ...(subParsed.layers ?? [])]) if (blob) await dst.mountBlob(blob.digest, source);
        await dst.putManifest(m.digest, sub.body, sub.mediaType);
      }
    } else {
      for (const blob of [parsed.config, ...(parsed.layers ?? [])]) if (blob) await dst.mountBlob(blob.digest, source);
    }
    const digest = await dst.putManifest(tag, manifest.body, manifest.mediaType);
    // Record the tag and the deployment now; the registry notification / reconcile then find it already recorded.
    if (digest) await this.handleEvents([{ action: 'push', target: { mediaType: manifest.mediaType, repository: target.repository, tag, digest }, actor: { name: 'promote' } }]).catch((e: Error) => this.logger.warn(`promote ${target.repository}:${tag}: recording failed: ${e.message}`));
    return { from: `${this.host}/${source}:${tag}`, to: `${this.host}/${target.repository}:${tag}`, digest };
  }

}
