import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { WorkerService } from './worker.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('platform job loop: a queued __platform__ job is claimed within one pass (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('claims atomically, evaluates, finishes; overlapping passes do not double-run; heartbeat written', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `pj-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [job] = await db.insert(schema.jobs).values({ organizationId: org!.id, projectId: proj!.id, serviceId: svc!.id, type: 'policy_eval', name: 'evaluate', status: 'queued', requiredTags: ['__platform__'], payload: { environmentId: null } } as typeof schema.jobs.$inferInsert).returning();
    const finished: unknown[] = [];
    const worker = Object.create(WorkerService.prototype) as WorkerService;
    Object.assign(worker, {
      db, logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      resolver: { resolveChain: async () => ({}) },
      policiesService: { evaluateJob: async () => { await new Promise((r) => setTimeout(r, 150)); return { id: 'ev', result: 'pass', policies: [], violations: [] }; } },
      jobs: {
        platformHeartbeat: async () => { await db.insert(schema.platformHeartbeats).values({ name: 'platform-worker', lastSeenAt: new Date() }).onConflictDoUpdate({ target: schema.platformHeartbeats.name, set: { lastSeenAt: new Date() } }); },
        appendSystemLog: async () => undefined,
        finish: async (id: string, status: string) => { finished.push([id, status]); await db.update(schema.jobs).set({ status: status as never, finishedAt: new Date() }).where(eq(schema.jobs.id, id)); },
      },
    });
    const [first, second] = await Promise.all([worker.runPlatformJobsOnce(), worker.runPlatformJobsOnce()]);
    expect(first.claimed + second.claimed).toBe(1);           // the overlap guard / atomic claim: exactly one run
    expect(finished).toEqual([[job!.id, 'succeeded']]);
    expect((await db.select({ st: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, job!.id)))[0]!.st).toBe('succeeded');
    const [hb] = await db.select().from(schema.platformHeartbeats).where(eq(schema.platformHeartbeats.name, 'platform-worker'));
    expect(Date.now() - hb!.lastSeenAt.getTime()).toBeLessThan(10_000);
  }, 20_000);
});
