import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { UsageService } from '../usage/usage.service';
import { JobsService } from './jobs.service';
import { PoolsService } from './pools.service';
import { hashToken } from './runner-auth';

/**
 * Managed runners: the cell's own runners (Helm chart) register with MANAGED_RUNNER_SECRET into one managed pool that
 * serves every organization of the cell, so a fresh cell runs pipelines without the customer installing anything.
 */
const url = process.env.TEST_DATABASE_URL;
const SECRET = 'm'.repeat(48);

(url ? describe : describe.skip)('managed runners (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const audit = { record: async () => undefined };
  const env: Record<string, unknown> = { MANAGED_RUNNER_SECRET: SECRET };
  const pools = Object.create(PoolsService.prototype) as PoolsService;
  Object.assign(pools, { db, audit, config: { get: (k: string) => env[k] } });
  const jobsService = Object.create(JobsService.prototype) as JobsService;
  Object.assign(jobsService, { db, audit });
  let managedPoolId: string;

  beforeAll(async () => {
    // start from a cell without a managed pool (other suites may have left one behind)
    await db.delete(schema.runnerPools).where(eq(schema.runnerPools.managed, true));
  });
  afterAll(async () => {
    await db.delete(schema.runnerPools).where(eq(schema.runnerPools.managed, true)).catch(() => undefined);
    for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined);
    await pool.end();
  });

  async function project() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `mr-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    return { org: org!, proj: proj! };
  }

  it('a wrong or missing secret is a 401; managed runners disabled says so', async () => {
    await expect(pools.register({ managedSecret: 'x'.repeat(48), name: 'managed-0' })).rejects.toMatchObject({ status: 401, message: 'Invalid managed runner secret' });
    env.MANAGED_RUNNER_SECRET = undefined;
    await expect(pools.register({ managedSecret: SECRET, name: 'managed-0' })).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/not enabled on this cell/) });
    env.MANAGED_RUNNER_SECRET = SECRET;
  });

  it('registers into the one managed pool (created on first use); the same name replaces its previous record', async () => {
    await project(); // a root organization exists
    const first = await pools.register({ managedSecret: SECRET, name: 'managed-0', tags: ['linux'], version: '0.2.0' });
    const again = await pools.register({ managedSecret: SECRET, name: 'managed-0', tags: ['linux'], version: '0.2.0' }); // pod restarted
    const other = await pools.register({ managedSecret: SECRET, name: 'managed-1' });
    expect(first.pool).toMatchObject({ slug: 'managed', name: 'Managed', tags: ['managed'] });
    expect(again.pool.id).toBe(first.pool.id);
    expect(other.pool.id).toBe(first.pool.id);
    managedPoolId = first.pool.id;
    const members = await db.select().from(schema.runners).where(eq(schema.runners.poolId, managedPoolId));
    expect(members.map((r) => r.name).sort()).toEqual(['managed-0', 'managed-1']); // no offline duplicate of managed-0
    expect(members.find((r) => r.name === 'managed-0')!.tokenHash).toBe(hashToken(again.runnerToken)); // the old token is gone
    expect(await db.select().from(schema.runnerPools).where(eq(schema.runnerPools.managed, true))).toHaveLength(1);
  });

  it('a managed runner claims queued jobs of any organization; a self-hosted pool stays within its own', async () => {
    const a = await project();
    const b = await project();
    // the managed pool claims jobs of ANY organization: in a shared test database other suites' queued jobs are fair game,
    // so these jobs carry a tag only this test's runner has, and top priority
    const tag = `mr-${randomUUID().slice(0, 8)}`;
    const queue = async (o: { org: { id: string }; proj: { id: string } }) => (await db.insert(schema.jobs).values({ organizationId: o.org.id, projectId: o.proj.id, type: 'sbom', name: 'sbom', status: 'queued', payload: {}, priority: 2_000_000_000, requiredTags: [tag] } as typeof schema.jobs.$inferInsert).returning())[0]!;
    const jobA = await queue(a);
    const jobB = await queue(b);
    const [managedPool] = await db.select().from(schema.runnerPools).where(eq(schema.runnerPools.managed, true));
    const [runner] = await db.select().from(schema.runners).where(and(eq(schema.runners.poolId, managedPool!.id), eq(schema.runners.name, 'managed-1')));
    const claimed: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [fresh] = await db.select().from(schema.runners).where(eq(schema.runners.id, runner!.id));
      await db.update(schema.runners).set({ status: 'online', currentJobId: null }).where(eq(schema.runners.id, runner!.id));
      const job = await jobsService.claim({ runner: { ...fresh!, status: 'online', tags: [...fresh!.tags, tag] }, pool: managedPool! });
      if (job) claimed.push(job.id);
    }
    expect(claimed.sort()).toEqual([jobA.id, jobB.id].sort());

    // a self-hosted pool of organization A never takes B's jobs
    const jobB2 = await queue(b);
    const [own] = await db.insert(schema.runnerPools).values({ organizationId: a.org.id, scopeId: a.org.id, slug: 'own', name: 'own' } as typeof schema.runnerPools.$inferInsert).returning();
    const [ownRunner] = await db.insert(schema.runners).values({ poolId: own!.id, name: 'laptop', tokenHash: randomUUID(), status: 'online', tags: [tag] } as typeof schema.runners.$inferInsert).returning();
    const stolen = await jobsService.claim({ runner: ownRunner!, pool: own! });
    expect(stolen?.id).not.toBe(jobB2.id); // never B's job (it may take an untagged job of its own organization A)
    await db.delete(schema.jobs).where(eq(schema.jobs.id, jobB2.id));
  });

  it('the managed pool cannot be deleted or given registration tokens; it is listed in every organization', async () => {
    const user = { id: randomUUID(), platformRole: 'admin' } as never;
    await expect(pools.delete(user, managedPoolId)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/cannot be deleted/) });
    await expect(pools.createRegistrationToken(user, managedPoolId, 'http://x', 'img', 3000)).rejects.toMatchObject({ status: 400 });
    const c = await project();
    const chain = { organizationId: c.org.id, organizationAncestorIds: [], refs: [{ type: 'ORGANIZATION', id: c.org.id }], target: { type: 'ORGANIZATION', id: c.org.id } } as never;
    const forChain = await pools.listForChain(chain);
    expect(forChain.some((p) => p.managed)).toBe(true);
  });

  it('managed runners gone for a day are pruned, never a busy one; usage splits managed runner minutes', async () => {
    const old = new Date(Date.now() - 2 * 24 * 3600_000);
    const [gone] = await db.insert(schema.runners).values({ poolId: managedPoolId, name: 'managed-7', tokenHash: randomUUID(), lastHeartbeatAt: old } as typeof schema.runners.$inferInsert).returning();
    const [busy] = await db.insert(schema.runners).values({ poolId: managedPoolId, name: 'managed-8', tokenHash: randomUUID(), lastHeartbeatAt: old, currentJobId: randomUUID() } as typeof schema.runners.$inferInsert).returning();
    expect(await pools.pruneManagedRunners()).toBe(1);
    expect(await db.select().from(schema.runners).where(eq(schema.runners.id, gone!.id))).toHaveLength(0);
    expect(await db.select().from(schema.runners).where(eq(schema.runners.id, busy!.id))).toHaveLength(1);

    const p = await project();
    const [own] = await db.insert(schema.runnerPools).values({ organizationId: p.org.id, scopeId: p.org.id, slug: 'own', name: 'own' } as typeof schema.runnerPools.$inferInsert).returning();
    const [ownRunner] = await db.insert(schema.runners).values({ poolId: own!.id, name: 'laptop', tokenHash: randomUUID() } as typeof schema.runners.$inferInsert).returning();
    const job = (poolId: string, runnerId: string, minutes: number) => ({ organizationId: p.org.id, projectId: p.proj.id, type: 'sbom', name: 'sbom', status: 'succeeded', payload: {}, poolId, runnerId, startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date(Date.parse('2026-09-10T10:00:00Z') + minutes * 60_000) }) as typeof schema.jobs.$inferInsert;
    await db.insert(schema.jobs).values([job(managedPoolId, busy!.id, 6), job(own!.id, ownRunner!.id, 4)]);
    const usage = Object.create(UsageService.prototype) as UsageService;
    Object.assign(usage, { db });
    const m = await usage.compute(p.org.id, '2026-09');
    expect([m.runnerMinutes, m.runnerMinutesManaged]).toEqual([10, 6]);
  });
});
