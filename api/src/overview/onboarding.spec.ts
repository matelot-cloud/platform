import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { OnboardingService } from './onboarding.service';

const url = process.env.TEST_DATABASE_URL;

/** The "Get started" checklist is computed from what exists: each step flips as the organization is set up. */
(url ? describe : describe.skip)('onboarding checklist (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const audits: string[] = [];
  const svc = Object.create(OnboardingService.prototype) as OnboardingService;
  Object.assign(svc, { db, audit: { record: async (e: { action: string }) => { audits.push(e.action); } } });
  const memberCtx = { forUser: async () => ({}) };
  afterAll(async () => {
    for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined);
    for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => undefined);
    await pool.end();
  });

  it('organization setup is only organization-level steps; complete once, forward-only', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `ob-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const state = async () => { const r = await svc.status(org!.id); return { r, done: Object.fromEntries(r.steps.map((x) => [x.id, x.done])) as Record<string, boolean> }; };

    let { r, done } = await state();
    expect(r.steps.map((x) => x.id)).toEqual(['connect_source', 'runner_online', 'notifications', 'invite_team']); // no per-service steps
    expect(r.steps.filter((x) => !x.optional).map((x) => x.id)).toEqual(['connect_source', 'runner_online']);
    expect([r.total, r.completed, r.visible, r.complete]).toEqual([4, 0, true, false]);
    expect(r.next?.id).toBe('connect_source');
    // open steps say what was found too, and the next command carries the real organization id
    expect(r.steps.map((x) => x.detail)).toEqual(['0 source connections', '0 online, no jobs run yet', '0 channels', '0 members']);
    expect(r.next?.cli).toBe(`matelot connection create --org ${org!.id} --body …`);
    expect(r.steps.every((x) => !x.cli?.includes('<org>'))).toBe(true);

    // 1. source connection (a registry or Jira connection is not source code)
    await db.insert(schema.integrations).values({ organizationId: org!.id, scopeType: 'ORGANIZATION', scopeId: org!.id, provider: 'registry', authType: 'none', name: 'hub', status: 'connected', externalAccountId: `r-${s}`, settings: {} });
    expect((await state()).done.connect_source).toBe(false);
    await db.insert(schema.integrations).values({ organizationId: org!.id, scopeType: 'ORGANIZATION', scopeId: org!.id, provider: 'git', authType: 'none', name: 'git', status: 'connected', externalAccountId: `g-${s}`, settings: {} });
    ({ r, done } = await state());
    expect([done.connect_source, r.next?.id]).toEqual([true, 'runner_online']);

    // 2. a runner online in a pool of the organization: every required step done → complete, remembered, hidden
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [rp] = await db.insert(schema.runnerPools).values({ organizationId: org!.id, scopeId: org!.id, slug: 'own', name: 'own' } as typeof schema.runnerPools.$inferInsert).returning();
    await db.insert(schema.runners).values({ poolId: rp!.id, name: 'r1', tokenHash: randomUUID(), status: 'online', lastHeartbeatAt: new Date() } as typeof schema.runners.$inferInsert);
    ({ r, done } = await state());
    expect([done.runner_online, r.complete, r.requiredRemaining, r.visible]).toEqual([true, true, 0, false]);
    expect(r.completedAt).not.toBeNull();
    expect([done.notifications, done.invite_team]).toEqual([false, false]); // optional ones stay listed as open

    // forward-only: runners going offline after running a job keeps the step done
    await db.insert(schema.jobs).values({ organizationId: org!.id, projectId: proj!.id, type: 'sbom', name: 'sbom', status: 'succeeded', payload: {}, poolId: rp!.id, finishedAt: new Date() } as typeof schema.jobs.$inferInsert);
    await db.update(schema.runners).set({ status: 'offline' }).where(eq(schema.runners.poolId, rp!.id));
    ({ r, done } = await state());
    expect(done.runner_online).toBe(true);
    expect(r.steps.find((x) => x.id === 'runner_online')!.detail).toBe('1 job run by runners');
    // even if a required step regresses (source disconnected), the remembered completion keeps the card away
    await db.update(schema.integrations).set({ status: 'disconnected' }).where(eq(schema.integrations.organizationId, org!.id));
    ({ r, done } = await state());
    expect([done.connect_source, r.complete, r.visible]).toEqual([false, false, false]);

    // invite: one member is not a team; two are
    const mkUser = async (t: string) => { const [u] = await db.insert(schema.users).values({ email: `${t}-${s}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning(); userIds.push(u!.id); return u!; };
    const a = await mkUser('a'); const b = await mkUser('b');
    await db.insert(schema.memberships).values({ userId: a.id, role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: org!.id } as typeof schema.memberships.$inferInsert);
    expect((await state()).done.invite_team).toBe(false);
    await db.insert(schema.memberships).values({ userId: b.id, role: 'DEVELOPER', scopeType: 'PROJECT', scopeId: proj!.id } as typeof schema.memberships.$inferInsert);
    expect((await state()).done.invite_team).toBe(true);
  });

  it('only people who can change the organization see the card (canManage)', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `oc-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const chain = { organizationId: org!.id, organizationAncestorIds: [], refs: [{ type: 'ORGANIZATION', id: org!.id }], target: { type: 'ORGANIZATION', id: org!.id } } as never;
    const withAuthz = (allowed: boolean): OnboardingService => { const o = Object.create(OnboardingService.prototype) as OnboardingService; Object.assign(o, { db, audit: { record: async () => undefined }, access: memberCtx, authz: { can: (_c: unknown, perm: string) => allowed && perm === 'organization:write' } }); return o; };
    expect(await withAuthz(false).canManage({ id: 'u', platformRole: 'user' } as never, chain)).toBe(false); // a developer
    expect(await withAuthz(true).canManage({ id: 'u', platformRole: 'user' } as never, chain)).toBe(true); // an organization admin
    expect(await withAuthz(false).canManage({ id: 'u', platformRole: 'admin' } as never, chain)).toBe(true); // platform admin
    expect((await withAuthz(false).status(org!.id, { canManage: false })).canManage).toBe(false);
  });

  it('an administrator can hide the checklist for everyone and show it again (audited)', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `od-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const user = { id: randomUUID() } as never;
    const hidden = await svc.setDismissed(user, org!.id, true);
    expect(hidden.visible).toBe(false);
    expect(hidden.dismissedAt).not.toBeNull();
    expect(hidden.complete).toBe(false); // still incomplete, just hidden
    const shown = await svc.setDismissed(user, org!.id, false);
    expect(shown).toMatchObject({ visible: true, dismissedAt: null });
    expect(audits).toEqual(expect.arrayContaining(['onboarding.dismissed', 'onboarding.restored']));
  });
});
