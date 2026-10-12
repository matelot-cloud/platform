import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { runWithRequestContext } from '../common/request-context';
import { AccessService } from './access.service';
import { AuthorizationService } from './authorization.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('personal / OAuth tokens of an administrator: masked by scope, not powerless (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('ORG_ADMIN with a write token reads findings and acts on them, but cannot administer; read token is read-only', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `ta-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [user] = await db.insert(schema.users).values({ email: `admin-${s}@acme.local`, externalId: randomUUID(), platformRole: 'admin' } as typeof schema.users.$inferInsert).returning();
    await db.insert(schema.memberships).values({ userId: user!.id, role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: org!.id } as typeof schema.memberships.$inferInsert);
    const access = new AccessService(db as never);
    const authz = new AuthorizationService();
    const chain = { organizationId: org!.id, workspaceId: ws!.id, teamId: team!.id, projectId: proj!.id, refs: [{ type: 'ORGANIZATION', id: org!.id }, { type: 'WORKSPACE', id: ws!.id }, { type: 'TEAM', id: team!.id }, { type: 'PROJECT', id: proj!.id }] } as never;
    const perms = (scope: 'read' | 'write' | 'sudo') => runWithRequestContext({ personalToken: { id: 't', userId: user!.id, scope } } as never, async () => {
      const ctx = await access.forUser(user!.id);
      return { read: authz.hasPermission(ctx, 'vulnerability:read', chain), decide: authz.hasPermission(ctx, 'vulnerability:write', chain), admin: authz.hasPermission(ctx, 'membership:write', chain) };
    });
    expect(await perms('write')).toEqual({ read: true, decide: true, admin: false });   // was 403 on vulnerability:read before
    expect(await perms('read')).toEqual({ read: true, decide: false, admin: false });
    expect(await perms('sudo')).toEqual({ read: true, decide: true, admin: true });
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
  }, 20_000);
});
