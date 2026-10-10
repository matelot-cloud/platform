import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import type { ScopeChain } from '../rbac/scope.types';
import { CoverageService } from './coverage.service';

const url = process.env.TEST_DATABASE_URL;

/**
 * Service coverage: per service, not "at least one somewhere in the organization". A covered service, an uncovered one
 * and one scanned 40 days ago (stale with the 30-day default) — the summary counts each of them where it belongs.
 */
(url ? describe : describe.skip)('service coverage (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const make = (authz: { hasPermission: (...a: unknown[]) => boolean; can: (...a: unknown[]) => boolean }): CoverageService => {
    const o = Object.create(CoverageService.prototype) as CoverageService;
    Object.assign(o, { db, access: { forUser: async () => ({}) }, authz });
    return o;
  };
  const svc = make({ hasPermission: () => true, can: () => true });
  afterAll(async () => {
    for (const id of orgIds) {
      await db.delete(schema.policies).where(eq(schema.policies.organizationId, id)).catch(() => undefined);
      await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined);
    }
    await pool.end();
  });

  async function fixture() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `cv-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [p1] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p1', name: 'Payments' }).returning();
    const [p2] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p2', name: 'Search' }).returning();
    const [git] = await db.insert(schema.integrations).values({ organizationId: org!.id, scopeType: 'ORGANIZATION', scopeId: org!.id, provider: 'git', authType: 'none', name: 'git', status: 'connected', externalAccountId: `g-${s}`, settings: {} }).returning();
    const mkService = async (projectId: string, slug: string) => (await db.insert(schema.services).values({ projectId, slug, name: slug }).returning())[0]!;
    const covered = await mkService(p1!.id, 'api');
    const bare = await mkService(p1!.id, 'worker');
    const stale = await mkService(p2!.id, 'indexer');
    // a policy at the workspace: inherited by every service below it
    await db.insert(schema.policies).values({ organizationId: org!.id, scopeType: 'WORKSPACE', scopeId: ws!.id, name: 'baseline', environmentKinds: [], rules: {}, action: 'block' } as unknown as typeof schema.policies.$inferInsert);
    const fullyCover = async (service: typeof covered, projectId: string, finishedDaysAgo: number) => {
      const [repo] = await db.insert(schema.repositories).values({ integrationId: git!.id, externalId: service.slug, fullName: `acme/${service.slug}` } as typeof schema.repositories.$inferInsert).returning();
      await db.insert(schema.serviceRepositories).values({ serviceId: service.id, repositoryId: repo!.id } as typeof schema.serviceRepositories.$inferInsert);
      const finishedAt = new Date(Date.now() - finishedDaysAgo * 86_400_000);
      await db.insert(schema.pipelines).values({ organizationId: org!.id, projectId, serviceId: service.id, number: 1, name: 'Security', stages: [], status: 'succeeded', finishedAt } as typeof schema.pipelines.$inferInsert);
      await db.insert(schema.sboms).values({ organizationId: org!.id, serviceId: service.id, source: 'runner', target: 'source', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from('') } as typeof schema.sboms.$inferInsert);
      const [env] = await db.insert(schema.environments).values({ serviceId: service.id, slug: 'prod', name: 'prod', kind: 'production' } as typeof schema.environments.$inferInsert).returning();
      await db.insert(schema.deployments).values({ organizationId: org!.id, serviceId: service.id, environmentId: env!.id, imageRef: 'x@sha256:1' } as typeof schema.deployments.$inferInsert);
    };
    await fullyCover(covered, p1!.id, 2);
    await fullyCover(stale, p2!.id, 40);
    const orgChain = { organizationId: org!.id, organizationAncestorIds: [], refs: [{ type: 'ORGANIZATION', id: org!.id }], target: { type: 'ORGANIZATION', id: org!.id } } as unknown as ScopeChain;
    return { org: org!, ws: ws!, p1: p1!, p2: p2!, covered, bare, stale, orgChain };
  }

  it('project: one row per service, a check or a gap with the link and CLI command to fix it', async () => {
    const f = await fixture();
    const r = await svc.forProject(f.p1.id);
    expect(r.days).toBe(30);
    expect(r.services.map((x) => x.serviceName)).toEqual(['api', 'worker']);
    const [api, worker] = r.services;
    expect(api!.covered).toBe(true);
    expect(api!.checks.every((c) => c.state === 'ok' && c.href === null && c.cli === null)).toBe(true);
    expect(api!.checks.find((c) => c.id === 'policy')!.detail).toBe('1 policy applies (1 inherited)');
    expect(api!.checks.find((c) => c.id === 'pipeline')!.detail).toBe('last finished 2 days ago');

    expect(worker!.covered).toBe(false);
    expect(worker!.gaps).toEqual(['repository', 'pipeline', 'sbom', 'deployment']); // the inherited workspace policy applies to it too
    const gap = Object.fromEntries(worker!.checks.map((c) => [c.id, c]));
    expect(gap.repository).toMatchObject({ state: 'missing', detail: 'no repository attached', href: `/projects/${f.p1.id}/services`, cli: `matelot repository attach --service ${f.bare.id} --repository-id <id>` });
    expect(gap.pipeline).toMatchObject({ state: 'missing', detail: 'never run', cli: `matelot pipeline --service ${f.bare.id} --template security --wait` });
    expect(gap.deployment).toMatchObject({ state: 'missing', detail: 'no environment', cli: `matelot env create --service ${f.bare.id} --slug production --name Production --kind production` });
    expect(r.summary).toMatchObject({ services: 2, covered: 1 });

    expect((await svc.forProject(f.p1.id, { uncovered: true })).services.map((x) => x.serviceName)).toEqual(['worker']);
  });

  it('a service scanned 40 days ago is stale with the 30-day default, ok with a 60-day window', async () => {
    const f = await fixture();
    const [indexer] = (await svc.forProject(f.p2.id)).services;
    const pipeline = indexer!.checks.find((c) => c.id === 'pipeline')!;
    expect(pipeline).toMatchObject({ state: 'stale', detail: 'last finished 40 days ago (older than 30 days)', href: `/projects/${f.p2.id}/pipelines` });
    expect(indexer!.gaps).toEqual(['pipeline']);
    expect((await svc.forProject(f.p2.id, { days: 60 })).services[0]!.covered).toBe(true);
    expect((await svc.forProject(f.p2.id, { days: 1 })).services[0]!.checks.find((c) => c.id === 'pipeline')!.detail).toBe('last finished 40 days ago (older than 1 day)');
  });

  it('organization: the summary counts every service where it belongs; uncovered list filterable by gap', async () => {
    const f = await fixture();
    const r = await svc.forOrganization({ id: randomUUID(), platformRole: 'user' } as never, f.orgChain);
    expect(r.summary.services).toBe(3);
    expect(r.summary.covered).toBe(1);
    expect(r.summary.checks.repository).toMatchObject({ ok: 2, stale: 0, missing: 1 });
    expect(r.summary.checks.pipeline).toMatchObject({ ok: 1, stale: 1, missing: 1 });
    expect(r.summary.checks.sbom).toMatchObject({ ok: 2, missing: 1 });
    expect(r.summary.checks.policy).toMatchObject({ ok: 3, missing: 0 });
    expect(r.summary.checks.deployment).toMatchObject({ ok: 2, missing: 1 });
    expect(r.uncoveredTotal).toBe(2);
    expect(r.uncovered.map((x) => `${x.projectName}/${x.serviceName}`)).toEqual(['Payments/worker', 'Search/indexer']);

    const stalePipelines = await svc.forOrganization({ id: randomUUID(), platformRole: 'user' } as never, f.orgChain, { gap: 'pipeline' });
    expect(stalePipelines.uncovered.map((x) => x.serviceName)).toEqual(['worker', 'indexer']);
    expect((await svc.forOrganization({ id: randomUUID(), platformRole: 'user' } as never, f.orgChain, { gap: 'repository' })).uncovered.map((x) => x.serviceName)).toEqual(['worker']);
    expect(stalePipelines.summary.services).toBe(3); // the filter narrows the list, never the summary
  });

  it('organization: someone who can read only one project sees only its services', async () => {
    const f = await fixture();
    const onlyPayments = make({ hasPermission: () => false, can: (_ctx, perm, chain) => perm === 'project:read' && (chain as ScopeChain).target.id === f.p1.id });
    const r = await onlyPayments.forOrganization({ id: randomUUID(), platformRole: 'user' } as never, f.orgChain);
    expect(r.summary.services).toBe(2);
    expect(r.uncovered.map((x) => x.serviceName)).toEqual(['worker']);
  });
});
