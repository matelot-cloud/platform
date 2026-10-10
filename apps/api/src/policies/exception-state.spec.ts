import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { ExceptionsService } from './exceptions.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('exception state machine: pending until approved, then applied (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('non-approver creates → pending, applied 0, finding still open; approver approves → active, applied 1, finding accepted', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `ex-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [comp] = await db.insert(schema.components).values({ purl: `pkg:pypi/pip@25.0.1?t=${s}`, type: 'pypi', name: 'pip', version: '25.0.1' } as typeof schema.components.$inferInsert).returning();
    const adv = `CVE-2026-${String(parseInt(s.replace(/[^0-9]/g, '') || '1', 10) % 90000 + 10000)}`;
    await db.insert(schema.advisories).values({ id: adv, aliases: [], canonicalId: adv, severity: 'high', cvssScore: 7.5, affected: [] } as typeof schema.advisories.$inferInsert);
    const [f] = await db.insert(schema.findings).values({ organizationId: org!.id, serviceId: svc!.id, componentId: comp!.id, advisoryId: adv, canonicalId: adv, severity: 'high', status: 'open', packageKey: 'pypi/pip' } as typeof schema.findings.$inferInsert).returning();
    const [eng] = await db.insert(schema.users).values({ email: `eng-${s}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning();
    const [admin] = await db.insert(schema.users).values({ email: `sec-${s}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning();
    const svcObj = Object.create(ExceptionsService.prototype) as ExceptionsService;
    Object.assign(svcObj, { db, audit: { record: async () => undefined } });
    const chain = { organizationId: org!.id, target: { type: 'SERVICE', id: svc!.id }, serviceId: svc!.id } as never;
    // the controller passes approve=false for users without exception:approve
    const created = await svcObj.create({ id: eng!.id, email: eng!.email } as never, chain, { kind: 'vulnerability', matchId: adv, status: 'accepted', reason: 'test', expiresAt: new Date(Date.now() + 86400_000).toISOString(), approve: false });
    expect(created).toMatchObject({ state: 'pending', applied: 0 });
    expect((await db.select({ st: schema.findings.status }).from(schema.findings).where(eq(schema.findings.id, f!.id)))[0]!.st).toBe('open');
    const listed = await svcObj.list(org!.id, {} as never);
    expect(listed.find((e) => e.id === created.id)?.state).toBe('pending');
    const approved = await svcObj.approve({ id: admin!.id, email: admin!.email } as never, created.id);
    expect(approved).toMatchObject({ state: 'active', applied: 1 });
    expect((await db.select({ st: schema.findings.status }).from(schema.findings).where(eq(schema.findings.id, f!.id)))[0]!.st).toBe('accepted');
    for (const u of [eng, admin]) await db.delete(schema.users).where(eq(schema.users.id, u!.id));
  }, 20_000);
});
