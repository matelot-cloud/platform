import { EventEmitter } from 'node:events';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { JobsService } from './jobs.service';
import { RunnerController } from './runner.controller';
import type { RunnerPrincipal } from './runner-auth';

/**
 * Pipelines #47 / #48 (2026-10-08): (1) a requeued job stayed bound to the pool of the runner that abandoned it, so an
 * idle managed runner never took it; (2) a job was assigned to a runner that had already gone away (its long-poll
 * claim was still open on the server) and sat "assigned" until the lease expired.
 */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('job assignment: requeue binding and runners that went away', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const audit = { record: async () => undefined };
  const jobsService = Object.create(JobsService.prototype) as JobsService;
  Object.assign(jobsService, { db, audit, pipelines: { advance: async () => undefined }, logger: { log: () => undefined, warn: () => undefined } });
  const controller = Object.create(RunnerController.prototype) as RunnerController;
  Object.assign(controller, { db, jobs: jobsService });

  afterAll(async () => { for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  /** An organization with a project, two pools (P: the "test" pool, Q: another eligible pool) and a runner in each. */
  async function setup() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `ja-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const mkPool = async (slug: string) => (await db.insert(schema.runnerPools).values({ organizationId: org!.id, scopeId: org!.id, slug, name: slug } as typeof schema.runnerPools.$inferInsert).returning())[0]!;
    const mkRunner = async (poolRow: typeof schema.runnerPools.$inferSelect, name: string): Promise<RunnerPrincipal> => {
      const [r] = await db.insert(schema.runners).values({ poolId: poolRow.id, name, tokenHash: randomUUID(), status: 'online', lastHeartbeatAt: new Date() } as typeof schema.runners.$inferInsert).returning();
      return { runner: r!, pool: poolRow };
    };
    const P = await mkPool('test');
    const Q = await mkPool('other');
    const a = await mkRunner(P, 'demo-runner');
    const b = await mkRunner(Q, 'managed-0');
    const job = async (requestedPoolId: string | null = null) => (await db.insert(schema.jobs).values({ organizationId: org!.id, projectId: proj!.id, type: 'secrets', name: 'secrets', status: 'queued', payload: {}, poolId: requestedPoolId, requestedPoolId, priority: 900 } as typeof schema.jobs.$inferInsert).returning())[0]!;
    return { P, Q, a, b, job };
  }
  const row = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
  const fresh = async (p: RunnerPrincipal): Promise<RunnerPrincipal> => ({ ...p, runner: (await db.select().from(schema.runners).where(eq(schema.runners.id, p.runner.id)))[0]! });
  const expireLease = (id: string) => db.update(schema.jobs).set({ leaseExpiresAt: new Date(Date.now() - 1000), startedAt: new Date(Date.now() - 5000) }).where(eq(schema.jobs.id, id));

  it('#47: after the lease expires a job that requested no pool is taken by a runner of another pool', async () => {
    const { a, b, job } = await setup();
    const j = await job(null);
    expect((await jobsService.claim(a))?.id).toBe(j.id); // demo-runner (pool "test") takes it, then dies
    expect((await row(j.id)).poolId).toBe(a.pool.id); // where it ran (UI / usage) …
    expect((await row(j.id)).requestedPoolId).toBeNull(); // … is not a constraint
    await expireLease(j.id);
    await jobsService.sweep();
    const requeued = await row(j.id);
    expect(requeued).toMatchObject({ status: 'queued', runnerId: null, poolId: null });
    expect((await jobsService.claim(await fresh(b)))?.id).toBe(j.id); // the idle runner of the other pool takes it
  });

  it('a pool requested at creation still binds after a requeue', async () => {
    const { a, b, P, job } = await setup();
    const j = await job(P.id);
    expect((await jobsService.claim(a))?.id).toBe(j.id);
    await expireLease(j.id);
    await jobsService.sweep();
    expect(await row(j.id)).toMatchObject({ status: 'queued', poolId: P.id, requestedPoolId: P.id });
    expect(await jobsService.claim(await fresh(b))).toBeNull();
    expect((await jobsService.claim(await fresh(a)))?.id).toBe(j.id);
  });

  it('an assignment never started within 30 s goes back to the queue quickly (attempt not counted)', async () => {
    const { a, b, job } = await setup();
    const j = await job(null);
    expect((await jobsService.claim(a))?.id).toBe(j.id);
    await db.update(schema.jobs).set({ assignedAt: new Date(Date.now() - 40_000) }).where(eq(schema.jobs.id, j.id)); // lease still valid
    await jobsService.sweep();
    expect(await row(j.id)).toMatchObject({ status: 'queued', runnerId: null, poolId: null, attempts: 0 });
    expect((await fresh(a)).runner).toMatchObject({ currentJobId: null });
    expect((await jobsService.claim(await fresh(b)))?.id).toBe(j.id);
  });

  /** A Response stand-in: emits 'close' like Express when the client goes away; writableFinished once delivered. */
  const fakeRes = () => Object.assign(new EventEmitter(), { writableFinished: false, status(this: { code?: number }, c: number) { this.code = c; return this; } });

  it('#48: a claim whose client disconnected is dropped; a job enqueued afterwards stays queued for the next runner', async () => {
    const { a, b, job } = await setup();
    const res = fakeRes();
    const pending = (controller as unknown as { claim: (p: RunnerPrincipal, d: { waitSeconds: number }, r: unknown) => Promise<unknown> }).claim(a, { waitSeconds: 10 }, res);
    await new Promise((r) => setTimeout(r, 300));
    res.emit('close'); // demo-runner container stopped while its long-poll was open
    const started = Date.now();
    expect(await pending).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2500); // the server stopped polling for it
    const j = await job(null); // pipeline started 5 s later
    await new Promise((r) => setTimeout(r, 1800)); // longer than one poll interval of the dropped claim
    expect(await row(j.id)).toMatchObject({ status: 'queued', runnerId: null });
    expect((await jobsService.claim(await fresh(b)))?.id).toBe(j.id);
  });

  it('a job whose response never reached the runner goes back to the queue; a delivered one stays assigned', async () => {
    const { a, b, job } = await setup();
    const claim = (p: RunnerPrincipal, r: unknown) => (controller as unknown as { claim: (p: RunnerPrincipal, d: { waitSeconds: number }, r: unknown) => Promise<{ id: string } | undefined> }).claim(p, { waitSeconds: 1 }, r);
    const j1 = await job(null);
    const lost = fakeRes();
    expect((await claim(a, lost))?.id).toBe(j1.id);
    lost.emit('close'); // connection gone before the response was written
    await new Promise((r) => setTimeout(r, 200));
    expect(await row(j1.id)).toMatchObject({ status: 'queued', runnerId: null, attempts: 0 });
    const logs = await db.select().from(schema.jobLogChunks).where(eq(schema.jobLogChunks.jobId, j1.id));
    expect(logs.map((l) => l.content).join('')).toMatch(/went away before receiving the job; back in the queue/);

    const delivered = fakeRes();
    expect((await claim(await fresh(b), delivered))?.id).toBe(j1.id);
    delivered.writableFinished = true;
    delivered.emit('close'); // normal end of a delivered response
    await new Promise((r) => setTimeout(r, 200));
    expect(await row(j1.id)).toMatchObject({ status: 'assigned', runnerId: b.runner.id });
  });
});
