import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../database/errors';
import { organizations, projects, RunnerPool, runnerPools, runnerRegistrationTokens, runners, ScopeType, teams, workspaces } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor } from '../rbac/scope.types';
import { CreatePoolDto } from './dto/execution.dto';
import { hashToken, newToken } from './runner-auth';

/** Runner pools live at a level and serve everything below it (same model as connections). */
@Injectable()
export class PoolsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  private chainOf(pool: RunnerPool): Promise<ScopeChain | null> {
    return this.resolver.resolveChain(scopeParamsFor(pool.scopeType, pool.scopeId)).catch(() => null);
  }

  private async describeScope(scopeType: ScopeType, scopeId: string): Promise<{ type: ScopeType; id: string; name: string }> {
    const table = { ORGANIZATION: organizations, WORKSPACE: workspaces, TEAM: teams, PROJECT: projects, SERVICE: null, ENVIRONMENT: null }[scopeType];
    if (!table) return { type: scopeType, id: scopeId, name: scopeType.toLowerCase() };
    const [row] = await this.db.select({ name: table.name }).from(table).where(eq(table.id, scopeId)).limit(1);
    return { type: scopeType, id: scopeId, name: row?.name ?? scopeType.toLowerCase() };
  }

  async list(user: AuthenticatedUser, orgChain: ScopeChain) {
    const ctx = await this.access.forUser(user.id);
    // the cell's managed pool serves every organization: listed (read-only) wherever runners are listed
    const pools = await this.db.select().from(runnerPools).where(or(eq(runnerPools.organizationId, orgChain.organizationId), eq(runnerPools.managed, true))).orderBy(desc(runnerPools.managed), asc(runnerPools.createdAt));
    const out = [];
    for (const pool of pools) {
      const chain = pool.managed ? orgChain : await this.chainOf(pool);
      if (!chain || !this.authz.can(ctx, 'runner:read', chain)) continue;
      const members = await this.db.select().from(runners).where(eq(runners.poolId, pool.id)).orderBy(desc(runners.lastHeartbeatAt));
      out.push({ ...pool, scope: await this.describeScope(pool.scopeType, pool.scopeId), runners: members.map(({ tokenHash: _t, ...r }) => r) });
    }
    return out;
  }

  /** Pools a project can use: on its path (organization → workspace → team → project). */
  async listForChain(chain: ScopeChain) {
    const pools = await this.db.select().from(runnerPools).where(or(eq(runnerPools.organizationId, chain.organizationId), eq(runnerPools.managed, true)));
    const refs = new Set(chain.refs.map((r) => `${r.type}:${r.id}`));
    return pools.filter((p) => p.managed || refs.has(`${p.scopeType}:${p.scopeId}`));
  }

  async create(user: AuthenticatedUser, orgChain: ScopeChain, dto: CreatePoolDto) {
    let chain = orgChain;
    if (dto.scopeType && dto.scopeType !== 'ORGANIZATION') {
      if (!dto.scopeId) throw new BadRequestException('scopeId is required for a non-organization scope');
      chain = await this.resolver.resolveChain(scopeParamsFor(dto.scopeType, dto.scopeId));
      if (chain.organizationId !== orgChain.organizationId) throw new BadRequestException('Scope belongs to another organization');
    }
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'runner:write', chain);
    try {
      const [pool] = await this.db
        .insert(runnerPools)
        .values({ organizationId: orgChain.organizationId, scopeType: chain.target.type, scopeId: chain.target.id, slug: dto.slug, name: dto.name, description: dto.description, tags: dto.tags ?? [], createdById: user.id })
        .returning();
      await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'runner_pool.created', resourceType: 'runner_pool', resourceId: pool.id, after: pool });
      return { ...pool, scope: await this.describeScope(pool.scopeType, pool.scopeId), runners: [] };
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new ConflictException(`A pool with slug "${dto.slug}" already exists at this level`);
      throw error;
    }
  }

  async get(poolId: string): Promise<RunnerPool> {
    const [pool] = await this.db.select().from(runnerPools).where(eq(runnerPools.id, poolId)).limit(1);
    if (!pool) throw new NotFoundException('Runner pool not found');
    return pool;
  }

  private async assertOnPool(user: AuthenticatedUser, pool: RunnerPool, permission: 'runner:read' | 'runner:write') {
    const chain = await this.chainOf(pool);
    if (!chain) throw new NotFoundException('Runner pool not found');
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }

  /** One-time registration token (valid 24 h) and the command to run. */
  async createRegistrationToken(user: AuthenticatedUser, poolId: string, apiUrl: string, image: string, apiPort: number, registryHost?: string) {
    const pool = await this.get(poolId);
    if (pool.managed) throw new BadRequestException('The managed pool is fed by the cell itself (Helm chart, MANAGED_RUNNER_SECRET); create a pool of your own for self-hosted runners');
    await this.assertOnPool(user, pool, 'runner:write');
    const token = newToken('rrt');
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
    await this.db.insert(runnerRegistrationTokens).values({ poolId: pool.id, tokenHash: hashToken(token), expiresAt, createdById: user.id });
    await this.audit.record({ organizationId: pool.organizationId, actor: userActor(user), action: 'runner_pool.registration_token_created', resourceType: 'runner_pool', resourceId: pool.id, after: { expiresAt } });
    // Inside a container "localhost" is the container: point local setups at the Docker host instead.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(apiUrl);
    // Local: containers reach the API directly on its port (the Vite dev server on the web port is not for machines).
    const dockerUrl = local ? `http://host.docker.internal:${apiPort}/api/v1` : apiUrl;
    const localUrl = local ? `http://localhost:${apiPort}/api/v1` : apiUrl;
    const buildHint = local ? `# local development: build the image first with: make runner-image\n` : '';
    // Local built-in registry: inside the container "localhost:5000" must be reached as host.docker.internal:5000.
    const aliasEnv = local && registryHost && /^(localhost|127\.0\.0\.1)/.test(registryHost) ? ` -e REGISTRY_HOST_ALIASES=${registryHost}=host.docker.internal:${registryHost.split(':')[1] ?? '5000'}` : '';
    const aliasCompose = aliasEnv ? `\n      REGISTRY_HOST_ALIASES: ${registryHost}=host.docker.internal:${registryHost!.split(':')[1] ?? '5000'}` : '';
    return {
      token,
      expiresAt,
      docker: `${buildHint}docker run -d --name secops-runner --restart unless-stopped -e RUNNER_URL=${dockerUrl} -e RUNNER_REGISTRATION_TOKEN=${token} -e RUNNER_NAME=docker-runner${aliasEnv} -v secops-runner:/data ${image}`,
      compose: `services:\n  runner:\n    image: ${image}\n    restart: unless-stopped\n    environment:\n      RUNNER_URL: ${dockerUrl}\n      RUNNER_REGISTRATION_TOKEN: ${token}\n      RUNNER_NAME: my-runner${aliasCompose}\n    volumes:\n      - secops-runner:/data\nvolumes:\n  secops-runner: {}`,
      local: `RUNNER_URL=${localUrl} RUNNER_REGISTRATION_TOKEN=${token} make runner`,
      kubernetes: `# kubectl apply -f runner.yaml   (namespace of your choice; the runner needs outbound HTTPS to the platform only)
apiVersion: v1
kind: Secret
metadata:
  name: secops-runner-registration
type: Opaque
stringData:
  RUNNER_REGISTRATION_TOKEN: ${token}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secops-runner
spec:
  replicas: 1
  selector:
    matchLabels: { app: secops-runner }
  template:
    metadata:
      labels: { app: secops-runner }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 10001, fsGroup: 10001 }
      containers:
        - name: runner
          image: ${image}
          env:
            - { name: RUNNER_URL, value: ${apiUrl} }
            - { name: RUNNER_NAME, valueFrom: { fieldRef: { fieldPath: metadata.name } } }
            - { name: RUNNER_TAGS, value: kubernetes }
          envFrom:
            - secretRef: { name: secops-runner-registration }
          volumeMounts:
            - { name: data, mountPath: /data }
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits: { cpu: "2", memory: 2Gi }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: secops-runner-data }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: secops-runner-data
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }`,
    };
  }

  async delete(user: AuthenticatedUser, poolId: string): Promise<void> {
    const pool = await this.get(poolId);
    if (pool.managed) throw new BadRequestException('The managed pool belongs to the cell and cannot be deleted; scale the managed runners in the Helm chart (managedRunners.replicas: 0 to stop them)');
    await this.assertOnPool(user, pool, 'runner:write');
    await this.db.delete(runnerPools).where(eq(runnerPools.id, pool.id));
    await this.audit.record({ organizationId: pool.organizationId, actor: userActor(user), action: 'runner_pool.deleted', resourceType: 'runner_pool', resourceId: pool.id, before: pool });
  }

  async removeRunner(user: AuthenticatedUser, runnerId: string): Promise<void> {
    const [runner] = await this.db.select().from(runners).where(eq(runners.id, runnerId)).limit(1);
    if (!runner) throw new NotFoundException('Runner not found');
    const pool = await this.get(runner.poolId);
    await this.assertOnPool(user, pool, 'runner:write');
    await this.db.delete(runners).where(eq(runners.id, runner.id));
    await this.audit.record({ organizationId: pool.organizationId, actor: userActor(user), action: 'runner.removed', resourceType: 'runner', resourceId: runner.id, before: { name: runner.name, pool: pool.slug } });
  }

  /** Runner side: exchange a registration token for a runner identity. */
  async register(dto: { registrationToken?: string; managedSecret?: string; name: string; tags?: string[]; version?: string; metadata?: Record<string, unknown> }) {
    if (dto.managedSecret !== undefined) return this.registerManaged(dto as typeof dto & { managedSecret: string });
    if (!dto.registrationToken) throw new UnauthorizedException('registrationToken is required');
    const [reg] = await this.db.select().from(runnerRegistrationTokens).where(eq(runnerRegistrationTokens.tokenHash, hashToken(dto.registrationToken))).limit(1);
    // 401 (not 400): a wrong registration token is a failed authentication and counts toward the per-address limit
    if (!reg || reg.expiresAt < new Date()) throw new UnauthorizedException('Registration token is invalid or expired');
    const pool = await this.get(reg.poolId);
    const runnerToken = newToken('rt');
    const [runner] = await this.db
      .insert(runners)
      .values({ poolId: pool.id, name: dto.name, tags: dto.tags ?? [], version: dto.version, status: 'online', tokenHash: hashToken(runnerToken), lastHeartbeatAt: new Date(), metadata: dto.metadata ?? {} })
      .returning();
    await this.db.update(runnerRegistrationTokens).set({ usedAt: new Date() }).where(eq(runnerRegistrationTokens.id, reg.id));
    await this.audit.record({ organizationId: pool.organizationId, actor: { type: 'SYSTEM', id: 'runner' }, action: 'runner.registered', resourceType: 'runner', resourceId: runner.id, after: { name: runner.name, pool: pool.slug, tags: runner.tags } });
    return { runnerId: runner.id, runnerToken, pool: { id: pool.id, slug: pool.slug, name: pool.name, tags: pool.tags } };
  }

  /**
   * The cell's own runners (Helm chart) register with MANAGED_RUNNER_SECRET into the one managed pool, created on first
   * use under the root organization. A runner re-registering under the same name (pod restart, StatefulSet ordinal)
   * replaces its previous record instead of piling up offline duplicates. A wrong secret is a 401 (counted as an
   * authentication failure of the address).
   */
  async registerManaged(dto: { managedSecret: string; name: string; tags?: string[]; version?: string; metadata?: Record<string, unknown> }) {
    const expected = this.config.get('MANAGED_RUNNER_SECRET', { infer: true });
    const given = Buffer.from(dto.managedSecret);
    if (!expected || given.length !== Buffer.byteLength(expected) || !timingSafeEqual(given, Buffer.from(expected))) {
      throw new UnauthorizedException(expected ? 'Invalid managed runner secret' : 'Managed runners are not enabled on this cell (MANAGED_RUNNER_SECRET is not set)');
    }
    const pool = await this.ensureManagedPool();
    const runnerToken = newToken('rt');
    const runner = await this.db.transaction(async (tx) => {
      const replaced = await tx.delete(runners).where(and(eq(runners.poolId, pool.id), eq(runners.name, dto.name))).returning({ id: runners.id });
      const [row] = await tx.insert(runners).values({ poolId: pool.id, name: dto.name, tags: dto.tags ?? [], version: dto.version, status: 'online', tokenHash: hashToken(runnerToken), lastHeartbeatAt: new Date(), metadata: { ...(dto.metadata ?? {}), managed: true } }).returning();
      return { ...row!, replaced: replaced.length };
    });
    await this.audit.record({ organizationId: pool.organizationId, actor: { type: 'SYSTEM', id: 'runner' }, action: 'runner.registered', resourceType: 'runner', resourceId: runner.id, after: { name: runner.name, pool: pool.slug, managed: true, tags: runner.tags, replaced: runner.replaced } });
    return { runnerId: runner.id, runnerToken, pool: { id: pool.id, slug: pool.slug, name: pool.name, tags: pool.tags } };
  }

  /** The single managed pool (unique index on managed), under the bootstrap organization (else the oldest root one). */
  async ensureManagedPool() {
    const [existing] = await this.db.select().from(runnerPools).where(eq(runnerPools.managed, true)).limit(1);
    if (existing) return existing;
    const slug = this.config.get('BOOTSTRAP_ORG_SLUG', { infer: true });
    const [bySlug] = slug ? await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1) : [];
    const [root] = bySlug ? [bySlug] : await this.db.select({ id: organizations.id }).from(organizations).where(isNull(organizations.parentId)).orderBy(asc(organizations.createdAt)).limit(1);
    if (!root) throw new BadRequestException('No organization exists yet: managed runners register once the cell has its root organization');
    await this.db.insert(runnerPools).values({ organizationId: root.id, scopeType: 'ORGANIZATION', scopeId: root.id, slug: 'managed', name: 'Managed', description: 'Runners operated by the platform in this cell. They serve every organization; add a pool of your own for jobs that need your network.', tags: ['managed'], managed: true }).onConflictDoNothing();
    const [pool] = await this.db.select().from(runnerPools).where(eq(runnerPools.managed, true)).limit(1);
    return pool!;
  }

  /** Managed runners gone for a day (scaled down StatefulSet ordinals, deleted pods): removed, never while busy. */
  async pruneManagedRunners(olderThanMs = 24 * 3600_000): Promise<number> {
    const [pool] = await this.db.select({ id: runnerPools.id }).from(runnerPools).where(eq(runnerPools.managed, true)).limit(1);
    if (!pool) return 0;
    const gone = await this.db.delete(runners).where(and(eq(runners.poolId, pool.id), isNull(runners.currentJobId), lt(runners.lastHeartbeatAt, new Date(Date.now() - olderThanMs)))).returning({ id: runners.id });
    return gone.length;
  }

  poolsById(ids: string[]) {
    return ids.length ? this.db.select().from(runnerPools).where(inArray(runnerPools.id, ids)) : Promise.resolve([]);
  }

  runnersInPool(poolId: string) {
    return this.db.select().from(runners).where(and(eq(runners.poolId, poolId)));
  }
}
