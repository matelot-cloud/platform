/**
 * Scope × action matrix for personal / OAuth tokens — the consent page copy (apps/web/src/pages/oauth/consent.tsx) and
 * docs/roles.md must say exactly this. The scope is a MASK over the user's own role, never a different role:
 * read = read-only · write = everything the role allows except the administrative permissions (SUDO_ONLY) and DELETE
 * routes · sudo = the full role. Walks the customer's first-run path with a write-scoped ORG_ADMIN / cell-admin token
 * (the default of `matelot login`): create workspace → team → project → run a pipeline → read findings → push to the
 * registry, and asserts that only the destructive / administrative operations need sudo.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { runWithRequestContext } from '../common/request-context';
import { AccessService } from './access.service';
import { AuthorizationService } from './authorization.service';
import { PERMISSIONS, SUDO_ONLY, scopeAllows, type Permission } from './permissions';
import { methodRefusedForScope } from '../auth/personal-tokens/personal-token.guard';

/** What each action requires — kept in one place so the matrix reads like the consent page. */
export const ACTIONS: Record<string, Permission> = {
  // the customer's first-run path with the default `write` login (matelot login): create structure, run, read, push
  'create a workspace': 'workspace:write',
  'create a team': 'team:write',
  'create a project / service / environment': 'project:write',
  'run a pipeline': 'job:create',
  'read findings / gates / evidence': 'vulnerability:read',
  'push to the registry': 'registry:push',
  'pull from the registry': 'registry:pull',
  'evaluate a gate': 'gate:evaluate',
  'record a release / deployment': 'deployment:write',
  'decide on a finding': 'vulnerability:write',
  'create / update a remediation, open an issue': 'vulnerability:write',
  'request an exception': 'exception:write',
  'upload an SBOM': 'sbom:write',
  'see runners (pools, managed runners online)': 'runner:read',
  // administrative: sudo only
  'approve an exception': 'exception:approve',
  'create a policy': 'policy:write',
  'create a notification channel': 'policy:write',
  'change SLA settings': 'policy:write',
  'grant a membership': 'membership:write',
  'connect an integration (credentials)': 'integration:connect',
  'organization settings': 'organization:write',
  'manage runner pools': 'runner:write',
  'accept a risk': 'risk:accept',
};
const DAY_TO_DAY = ['create a workspace', 'create a team', 'create a project / service / environment', 'run a pipeline', 'push to the registry', 'evaluate a gate', 'record a release / deployment', 'decide on a finding', 'create / update a remediation, open an issue', 'request an exception', 'upload an SBOM'];
const READS = ['read findings / gates / evidence', 'pull from the registry', 'evaluate a gate', 'see runners (pools, managed runners online)'];
const ADMIN = ['approve an exception', 'create a policy', 'create a notification channel', 'change SLA settings', 'grant a membership', 'connect an integration (credentials)', 'organization settings', 'manage runner pools', 'accept a risk'];
const row = (allowed: string[]) => Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, allowed.includes(a)]));
/** read = reads only · write = everything but the administrative row · sudo = all. Mirrors the consent page and docs/roles.md. */
export const EXPECTED: Record<'read' | 'write' | 'sudo', Record<string, boolean>> = {
  read: row(READS),
  write: row([...DAY_TO_DAY, ...READS]),
  sudo: row(Object.keys(ACTIONS)),
};
describe('token scope × action matrix (expectations)', () => {
  it('write never includes an administrative action; every action is in exactly one group', () => {
    for (const a of ADMIN) expect(EXPECTED.write[a]).toBe(false);
    for (const a of Object.keys(ACTIONS)) expect(DAY_TO_DAY.includes(a) || READS.includes(a) || ADMIN.includes(a)).toBe(true);
  });
  it('the mask: read = reads only, write = everything but SUDO_ONLY, sudo = all — for every permission', () => {
    for (const p of PERMISSIONS) {
      expect(scopeAllows('sudo', p)).toBe(true);
      expect(scopeAllows('write', p)).toBe(!SUDO_ONLY.has(p));
      if (p.endsWith(':read')) expect(scopeAllows('read', p)).toBe(true);
      if (p.endsWith(':write')) expect(scopeAllows('read', p)).toBe(false);
    }
    // the administrative set is exactly what the docs/roles.md table lists as sudo-only
    expect([...SUDO_ONLY].sort()).toEqual(['compliance:write', 'exception:approve', 'integration:connect', 'integration:write', 'membership:write', 'organization:create_child', 'organization:write', 'policy:exception_approve', 'policy:write', 'risk:accept', 'runner:write']);
  });
  it('the method half: read tokens are safe-method only, write tokens cannot DELETE (archive / remove), sudo can; MCP transport exempt', () => {
    expect(methodRefusedForScope('read', 'GET', false)).toBeNull();
    expect(methodRefusedForScope('read', 'POST', false)).toMatch(/read-only/);
    expect(methodRefusedForScope('write', 'POST', false)).toBeNull();
    expect(methodRefusedForScope('write', 'PATCH', false)).toBeNull();
    expect(methodRefusedForScope('write', 'delete', false)).toMatch(/sudo/);
    expect(methodRefusedForScope('sudo', 'DELETE', false)).toBeNull();
    expect(methodRefusedForScope('read', 'POST', true)).toBeNull();
    expect(methodRefusedForScope('write', 'DELETE', true)).toBeNull();
  });
});

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

  it('a cell administrator without any membership (the Compose first-run admin) walks the same path with a write token', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `mx-${s}`, name: s }).returning(); ids.push(org!.id);
    const [user] = await db.insert(schema.users).values({ email: `root-${s}@acme.local`, externalId: randomUUID(), platformRole: 'admin' } as typeof schema.users.$inferInsert).returning();
    const access = new AccessService(db as never); const authz = new AuthorizationService();
    const chain = { organizationId: org!.id, refs: [{ type: 'ORGANIZATION', id: org!.id }] } as never;
    const ctx = await runWithRequestContext({ personalToken: { id: 't', userId: user!.id, scope: 'write' } } as never, () => access.forUser(user!.id));
    expect(authz.hasPermission(ctx, 'workspace:write', chain)).toBe(true);
    expect(authz.hasPermission(ctx, 'job:create', chain)).toBe(true);
    expect(authz.hasPermission(ctx, 'registry:push', chain)).toBe(true);
    expect(authz.hasPermission(ctx, 'membership:write', chain)).toBe(false);
    expect(authz.hasPermission(ctx, 'organization:write', chain)).toBe(false);
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
  }, 20_000);
});
