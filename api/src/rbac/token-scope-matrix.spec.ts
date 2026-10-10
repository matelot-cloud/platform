/**
 * Scope × action matrix for personal / OAuth tokens — the consent page copy (apps/web/src/pages/oauth/consent.tsx) and
 * docs/roles.md must say exactly this. An ORG_ADMIN user; the token scope downgrades the role (read → AUDITOR,
 * write → PRODUCT_SECURITY_ENGINEER, sudo → unchanged).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { runWithRequestContext } from '../common/request-context';
import { AccessService } from './access.service';
import { AuthorizationService } from './authorization.service';
import type { Permission } from './permissions';

/** What each action requires — kept in one place so the matrix reads like the consent page. */
export const ACTIONS: Record<string, Permission> = {
  'read findings / gates / evidence': 'vulnerability:read',
  'decide on a finding': 'vulnerability:write',
  'create / update a remediation, open an issue': 'vulnerability:write',
  'request an exception': 'exception:write',
  'approve an exception': 'exception:approve',
  'create a policy': 'policy:write',
  'create a notification channel': 'policy:write',
  'change SLA settings': 'policy:write',
  'run a pipeline': 'job:create',
  'grant a membership': 'membership:write',
};
export const EXPECTED: Record<'read' | 'write' | 'sudo', Record<string, boolean>> = {
  read:  { 'read findings / gates / evidence': true, 'decide on a finding': false, 'create / update a remediation, open an issue': false, 'request an exception': false, 'approve an exception': false, 'create a policy': false, 'create a notification channel': false, 'change SLA settings': false, 'run a pipeline': false, 'grant a membership': false },
  write: { 'read findings / gates / evidence': true, 'decide on a finding': true, 'create / update a remediation, open an issue': true, 'request an exception': true, 'approve an exception': false, 'create a policy': false, 'create a notification channel': false, 'change SLA settings': false, 'run a pipeline': true, 'grant a membership': false },
  sudo:  { 'read findings / gates / evidence': true, 'decide on a finding': true, 'create / update a remediation, open an issue': true, 'request an exception': true, 'approve an exception': true, 'create a policy': true, 'create a notification channel': true, 'change SLA settings': true, 'run a pipeline': true, 'grant a membership': true },
};

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('token scope × action matrix (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('matches the consent page copy', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `mx-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [user] = await db.insert(schema.users).values({ email: `admin-${s}@acme.local`, externalId: randomUUID(), platformRole: 'admin' } as typeof schema.users.$inferInsert).returning();
    await db.insert(schema.memberships).values({ userId: user!.id, role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: org!.id } as typeof schema.memberships.$inferInsert);
    const access = new AccessService(db as never); const authz = new AuthorizationService();
    const chain = { organizationId: org!.id, workspaceId: ws!.id, teamId: team!.id, projectId: proj!.id, serviceId: svc!.id, refs: [{ type: 'ORGANIZATION', id: org!.id }, { type: 'WORKSPACE', id: ws!.id }, { type: 'TEAM', id: team!.id }, { type: 'PROJECT', id: proj!.id }, { type: 'SERVICE', id: svc!.id }] } as never;
    const actual: typeof EXPECTED = { read: {}, write: {}, sudo: {} };
    for (const scope of ['read', 'write', 'sudo'] as const) {
      const ctx = await runWithRequestContext({ personalToken: { id: 't', userId: user!.id, scope } } as never, () => access.forUser(user!.id));
      for (const [action, perm] of Object.entries(ACTIONS)) actual[scope][action] = authz.hasPermission(ctx, perm, chain);
    }
    expect(actual).toEqual(EXPECTED);
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
  }, 20_000);
});
