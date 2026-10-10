import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { apportionTenths, monthOf, monthRange, UsageService } from './usage.service';

const url = process.env.TEST_DATABASE_URL;

describe('usage month helpers', () => {
  it('month ranges are UTC calendar months; bad input is a 400', () => {
    expect(monthRange('2026-10')).toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') });
    expect(monthRange('2026-12').to).toEqual(new Date('2027-01-01T00:00:00Z'));
    expect(monthOf(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(() => monthRange('2026-13')).toThrow(/YYYY-MM/);
  });
});

(url ? describe : describe.skip)('usage metering (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgs: string[] = [];
  const users: string[] = [];
  const usage = Object.create(UsageService.prototype) as UsageService;
  Object.assign(usage, { db, seen: new Set<string>(), logger: { warn: () => undefined } });
  afterAll(async () => {
    for (const id of orgs) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined);
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users)).catch(() => undefined);
    await pool.end();
  });

  async function fixture() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `u-${s}`, name: s }).returning();
    const [other] = await db.insert(schema.organizations).values({ slug: `uo-${s}`, name: `o${s}` }).returning();
    orgs.push(org!.id, other!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    await db.insert(schema.projects).values({ teamId: team!.id, slug: 'old', name: 'old', archivedAt: new Date() });
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'api', name: 'api' }).returning();
    await db.insert(schema.services).values({ projectId: proj!.id, slug: 'web', name: 'web' });
    await db.insert(schema.environments).values({ serviceId: svc!.id, slug: 'prod', name: 'prod', kind: 'production' } as typeof schema.environments.$inferInsert);
    const mkUser = async (tag: string, disabled = false) => {
      const [u] = await db.insert(schema.users).values({ email: `${tag}-${s}@acme.local`, externalId: randomUUID(), platformRole: 'user', disabledAt: disabled ? new Date() : null } as typeof schema.users.$inferInsert).returning();
      users.push(u!.id);
      return u!;
    };
    const admin = await mkUser('admin'); // org-level member, active
    const dev = await mkUser('dev'); // project member, active
    const idle = await mkUser('idle'); // team member, never active this month
    const gone = await mkUser('gone', true); // disabled member: not a seat
    const outsider = await mkUser('out'); // member of another organization, active
    await db.insert(schema.memberships).values([
      { userId: admin.id, role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: org!.id },
      { userId: dev.id, role: 'DEVELOPER', scopeType: 'PROJECT', scopeId: proj!.id },
      { userId: dev.id, role: 'DEVELOPER', scopeType: 'TEAM', scopeId: team!.id }, // two memberships, one seat
      { userId: idle.id, role: 'DEVELOPER', scopeType: 'TEAM', scopeId: team!.id },
      { userId: gone.id, role: 'DEVELOPER', scopeType: 'WORKSPACE', scopeId: ws!.id },
      { userId: outsider.id, role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: other!.id },
    ] as (typeof schema.memberships.$inferInsert)[]);
    return { org: org!, other: other!, proj: proj!, svc: svc!, admin, dev, idle, outsider };
  }

  it('computes seats, inventory, pipelines, jobs, runner minutes and SBOMs for a month; other months and organizations do not leak in', async () => {
    const f = await fixture();
    const month = '2026-09';
    const inMonth = new Date('2026-09-15T10:00:00Z');
    for (const u of [f.admin, f.dev, f.outsider]) await usage.markActive(u.id, inMonth);
    await usage.markActive(f.idle.id, new Date('2026-08-20T10:00:00Z')); // active in another month only
    await usage.markActive(f.admin.id, inMonth); // idempotent

    const [rp] = await db.insert(schema.runnerPools).values({ organizationId: f.org.id, scopeId: f.org.id, slug: `p-${randomUUID().slice(0, 6)}`, name: 'pool' } as typeof schema.runnerPools.$inferInsert).returning();
    const [runner] = await db.insert(schema.runners).values({ poolId: rp!.id, name: 'r', tokenHash: randomUUID() } as typeof schema.runners.$inferInsert).returning();
    const [pipe] = await db.insert(schema.pipelines).values({ organizationId: f.org.id, projectId: f.proj.id, number: 1, name: 'Security', stages: [], createdAt: inMonth } as typeof schema.pipelines.$inferInsert).returning();
    await db.insert(schema.pipelines).values({ organizationId: f.org.id, projectId: f.proj.id, number: 2, name: 'Security', stages: [], createdAt: new Date('2026-10-02T00:00:00Z') } as typeof schema.pipelines.$inferInsert);
    const job = (type: string, start: string, end: string, runnerId: string | null) => ({ organizationId: f.org.id, projectId: f.proj.id, pipelineId: pipe!.id, type, name: type, status: 'succeeded', payload: {}, runnerId, startedAt: new Date(start), finishedAt: new Date(end) }) as typeof schema.jobs.$inferInsert;
    await db.insert(schema.jobs).values([
      job('sbom', '2026-09-15T10:00:00Z', '2026-09-15T10:03:00Z', runner!.id), // 3 min
      job('sast', '2026-09-15T10:00:00Z', '2026-09-15T10:01:30Z', runner!.id), // 1.5 min
      job('policy_eval', '2026-09-15T10:00:00Z', '2026-09-15T10:00:05Z', null), // platform job: counted, no runner minutes
      job('sbom', '2026-08-31T23:50:00Z', '2026-09-01T00:10:00Z', runner!.id), // finished in September: 20 min
      job('sbom', '2026-10-01T00:00:00Z', '2026-10-01T00:30:00Z', runner!.id), // October: excluded
    ]);
    await db.insert(schema.sboms).values({ organizationId: f.org.id, serviceId: f.svc.id, source: 'runner', target: 'source', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from(''), createdAt: inMonth } as typeof schema.sboms.$inferInsert);

    const m = await usage.compute(f.org.id, month);
    expect(m.seats).toEqual({ active: 2, members: 3 }); // admin + dev active; idle counted as member; disabled and outsider excluded
    expect([m.projects, m.services, m.environments]).toEqual([1, 2, 1]); // archived project excluded
    expect([m.pipelines, m.jobs, m.sboms]).toEqual([1, 4, 1]);
    expect(m.runnerMinutes).toBe(24.5);
    expect(m.runnerMinutesByType).toEqual({ sbom: 23, sast: 1.5 });

    const other = await usage.compute(f.other.id, month);
    expect(other.seats).toEqual({ active: 1, members: 1 });
    expect(other.pipelines + other.jobs + other.runnerMinutes).toBe(0);

    // seats: a month that ended before this cell tracked a single active user has no figure, not 0 (idle's first
    // activity, the earliest in the table, is in August; July ended before it; September counts normally)
    expect((await usage.compute(f.org.id, '2026-07')).seats).toEqual({ active: null, members: 3 });
    expect((await usage.compute(f.org.id, '2026-08')).seats.active).toBe(1);
    // the per-type minutes add up to the total exactly, whatever the rounding of each part
    await db.insert(schema.jobs).values(['sast', 'sca', 'secrets', 'iac', 'repository_check', 'sbom'].map((t, i) =>
      job(t, '2026-11-01T10:00:00Z', `2026-11-01T10:00:${String(15 + i * 7).padStart(2, '0')}Z`, runner!.id))); // 15,22,29,36,43,50 s → 195 s = 3.25 min
    const nov = await usage.compute(f.org.id, '2026-11');
    expect(nov.runnerMinutes).toBe(3.3);
    expect(Math.round(Object.values(nov.runnerMinutesByType).reduce((a, b) => a + b, 0) * 10) / 10).toBe(nov.runnerMinutes);
    expect(nov.runnerMinutesByType).toEqual({ sast: 0.3, sca: 0.4, secrets: 0.5, iac: 0.6, repository_check: 0.7, sbom: 0.8 });
  }, 30_000);

  it('apportions tenths of a minute so the parts sum to the rounded total', () => {
    // 0.9+0.8+0.5+0.4+0.3+0.3 would be 3.2 with independent rounding; the total of the raw seconds is 3.1
    const raw: [string, number][] = [['sast', 8.6], ['sca', 7.8], ['sbom', 4.6], ['iac', 3.7], ['repository_check', 3.2], ['secrets', 3.4]]; // tenths, sum 31.3 → total 3.1 min
    const parts = apportionTenths(raw, 31);
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBeCloseTo(3.1, 10);
    expect(parts).toEqual({ sast: 0.9, sca: 0.8, sbom: 0.4, iac: 0.4, repository_check: 0.3, secrets: 0.3 });
    expect(apportionTenths([], 0)).toEqual({});
    expect(apportionTenths([['sbom', 0.4]], 0)).toEqual({ sbom: 0 });
  });

  it('snapshots: current month live, past months from (final) snapshots, history and CSV', async () => {
    const f = await fixture();
    const now = new Date('2026-10-07T12:00:00Z');
    await usage.markActive(f.admin.id, new Date('2026-09-10T00:00:00Z'));
    await usage.markActive(f.dev.id, new Date('2026-10-03T00:00:00Z'));

    const first = await usage.snapshotAll(now);
    expect(first.finalised).toBeGreaterThanOrEqual(1);
    const [sep] = await db.select().from(schema.usageSnapshots).where(eq(schema.usageSnapshots.organizationId, f.org.id)).orderBy(schema.usageSnapshots.month);
    expect(sep).toMatchObject({ month: '2026-09', final: true });
    expect(sep!.metrics.seats.active).toBe(1);
    // an old snapshot that stored 0 seats for a month before tracking existed reads back as unknown
    const [orgOnly] = await db.insert(schema.organizations).values({ slug: `us-${randomUUID().slice(0, 8)}`, name: 'u' }).returning(); orgs.push(orgOnly!.id);
    await db.insert(schema.usageSnapshots).values({ organizationId: orgOnly!.id, month: '2026-06', final: true, metrics: { ...sep!.metrics, seats: { active: 0, members: 2 } } });
    const old = await usage.report(orgOnly!.id, '2026-06', now);
    expect(old.metrics.seats).toEqual({ active: null, members: 2 });
    expect(old.history.find((h) => h.month === '2026-06')!.metrics.seats.active).toBeNull();
    // a second pass does not rewrite the finalised month
    await db.update(schema.usageSnapshots).set({ metrics: { ...sep!.metrics, sboms: 99 } }).where(and(eq(schema.usageSnapshots.organizationId, f.org.id), eq(schema.usageSnapshots.month, '2026-09')));
    await usage.snapshotAll(now);

    const past = await usage.report(f.org.id, '2026-09', now);
    expect(past.live).toBe(false);
    expect(past.metrics.sboms).toBe(99); // served from the stored final snapshot
    const current = await usage.report(f.org.id, undefined, now);
    expect(current).toMatchObject({ month: '2026-10', live: true });
    expect(current.metrics.seats.active).toBe(1);
    expect(current.history.map((h) => h.month)).toEqual(['2026-10', '2026-09']);

    const csv = usage.toCsv(current.history);
    expect(csv.split('\n')[0]).toBe('month,seats_active,seats_members,projects,services,environments,pipelines,jobs,runner_minutes,runner_minutes_managed,sboms');
    expect(csv.split('\n')[1]).toMatch(/^2026-10,1,3,1,2,1,/);
  }, 30_000);
});
