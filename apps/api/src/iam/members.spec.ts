/**
 * Members, GitLab-style, against a real database: inherited rows, "raise, never lower", "never above your own role",
 * roles per scope, expiry, the last organization admin, and service accounts (scope-bound membership, tokens that
 * authenticate with the read/write mask, revocation). Needs TEST_DATABASE_URL (skipped otherwise).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';
import { runWithRequestContext } from '../common/request-context';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { InvitesService } from './invites.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { MembersService } from './members.service';
import { ScopeNamesService } from './scope-names.service';
import { ServiceAccountsService } from './service-accounts.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('members API rules (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as never as import('../database/database.module').Database;
  const env: Record<string, unknown> = { KEYCLOAK_ISSUER: 'http://kc.test/realms/platform', WEB_BASE_URL: 'http://cell.test', SERVICE_ACCOUNT_TOKEN_MAX_DAYS: 90 };
  const config = { get: (k: string) => env[k] } as never;
  const audit = new AuditService(db);
  const access = new AccessService(db);
  const authz = new AuthorizationService();
  const resolver = new ScopeResolverService(db);
  const names = new ScopeNamesService(db);
  const keycloak = new KeycloakAdminService(config);           // no admin URL: invites fall back to "via the identity provider"
  const invites = new InvitesService(db, config, keycloak, audit);
  const members = new MembersService(db, access, authz, resolver, audit, keycloak, invites, names);
  const tokens = new PersonalTokensService(db, audit, resolver);
  const bots = new ServiceAccountsService(db, config, members, tokens, access, authz, audit);
  const orgIds: string[] = []; const userIds: string[] = [];
  afterAll(async () => {
    for (const id of userIds) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => undefined);
    for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined);
    await pool.end();
  });

  const s = randomUUID().slice(0, 8);
  let org: string, ws: string, team: string, proj: string, proj2: string;
  const actor = (u: typeof schema.users.$inferSelect): AuthenticatedUser => ({ id: u.id, email: u.email, displayName: u.displayName, externalId: u.externalId ?? u.id, platformRole: u.platformRole });
  const person = async (tag: string) => { const [u] = await db.insert(schema.users).values({ email: `${tag}-${s}@acme.test`, externalId: randomUUID() }).returning(); userIds.push(u!.id); return u!; };
  const grant = (userId: string, scopeType: schema.ScopeType, scopeId: string, role: schema.Role, expiresAt: Date | null = null) => db.insert(schema.memberships).values({ userId, scopeType, scopeId, role, expiresAt }).returning();
  let admin: typeof schema.users.$inferSelect, lead: typeof schema.users.$inferSelect, dev: typeof schema.users.$inferSelect;

  beforeAll(async () => {
    const [o] = await db.insert(schema.organizations).values({ slug: `mb-${s}`, name: `Acme ${s}` }).returning(); org = o!.id; orgIds.push(org);
    const [w] = await db.insert(schema.workspaces).values({ organizationId: org, slug: 'payments', name: 'Payments' }).returning(); ws = w!.id;
    const [t] = await db.insert(schema.teams).values({ workspaceId: ws, slug: 'backend', name: 'Backend' }).returning(); team = t!.id;
    const [p] = await db.insert(schema.projects).values({ teamId: team, slug: 'api', name: 'Payment API' }).returning(); proj = p!.id;
    const [p2] = await db.insert(schema.projects).values({ teamId: team, slug: 'ledger', name: 'Ledger' }).returning(); proj2 = p2!.id;
    admin = await person('admin'); lead = await person('lead'); dev = await person('dev');
    await grant(admin.id, 'ORGANIZATION', org, 'ORG_ADMIN');
    await grant(lead.id, 'TEAM', team, 'TEAM_LEAD');
    await grant(dev.id, 'WORKSPACE', ws, 'AUDITOR');
  }, 30_000);

  it('lists inherited rows at a project with where they come from; only direct rows are editable', async () => {
    await members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj, role: 'DEVELOPER', userIds: [dev.id] });
    const { members: rows, canManage } = await members.list(actor(admin), 'PROJECT', proj);
    expect(canManage).toBe(true);
    const of = (email: string) => rows.filter((r) => r.user.email === email);
    expect(of(admin.email)).toEqual([expect.objectContaining({ role: 'ORG_ADMIN', source: 'inherited', inheritedFrom: expect.objectContaining({ type: 'ORGANIZATION', name: `Acme ${s}` }), canEdit: false })]);
    expect(of(lead.email)).toEqual([expect.objectContaining({ role: 'TEAM_LEAD', source: 'inherited', inheritedFrom: expect.objectContaining({ type: 'TEAM', name: 'Backend' }) })]);
    expect(of(dev.email).map((r) => [r.source, r.role])).toEqual([['direct', 'DEVELOPER'], ['inherited', 'AUDITOR']]);
    expect(of(dev.email)[0]).toEqual(expect.objectContaining({ canEdit: true, grantedBy: { id: admin.id, email: admin.email } }));
  }, 20_000);

  it('a direct role can raise inherited access but never lower it', async () => {
    // dev is AUDITOR on the workspace (all reads): READ_ONLY on a project would add nothing
    await expect(members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj2, role: 'READ_ONLY', userIds: [dev.id] })).rejects.toThrow(/already has Auditor here, inherited from workspace Payments; a direct role can raise that access, never lower it/);
    // …but DEVELOPER adds pipelines, images, releases: allowed
    await expect(members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj2, role: 'DEVELOPER', userIds: [dev.id] })).resolves.toEqual(expect.objectContaining({ added: [expect.objectContaining({ updated: false })] }));
  }, 20_000);

  it('nobody grants a role with permissions they do not hold; roles are offered per scope', async () => {
    const someone = await person('someone');
    await expect(members.add(actor(lead), { scopeType: 'PROJECT', scopeId: proj, role: 'SECURITY_ADMIN', userIds: [someone.id] })).rejects.toThrow(/You cannot grant Security admin: it includes permissions you do not have here/);
    await expect(members.add(actor(lead), { scopeType: 'PROJECT', scopeId: proj, role: 'DEVELOPER', userIds: [someone.id] })).resolves.toBeTruthy();
    await expect(members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj, role: 'ORG_ADMIN', userIds: [someone.id] })).rejects.toThrow(/Organization admin is not a role for a project/);
    const roles = await members.roles(actor(lead), 'PROJECT', proj);
    expect(roles.map((r) => r.role)).not.toContain('ORG_ADMIN');
    expect(roles.find((r) => r.role === 'DEVELOPER')).toEqual(expect.objectContaining({ grantable: true, gitlab: 'Developer' }));
    expect(roles.find((r) => r.role === 'SECURITY_ADMIN')).toEqual(expect.objectContaining({ grantable: false }));
    // the lead cannot change or remove what they could not grant: the inherited org admin is not editable anyway, and a
    // direct SECURITY_ADMIN granted by the org admin stays out of reach
    const sec = await person('sec');
    const r = await members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj, role: 'SECURITY_ADMIN', userIds: [sec.id] });
    await expect(members.remove(actor(lead), r.added[0]!.membershipId)).rejects.toThrow(/You cannot grant Security admin/);
  }, 20_000);

  it('a write-scoped token cannot manage members (membership:write needs sudo or the web session)', async () => {
    const someone = await person('tok');
    await expect(runWithRequestContext({ personalToken: { id: 't', userId: admin.id, scope: 'write' } } as never, () => members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj, role: 'DEVELOPER', userIds: [someone.id] }))).rejects.toThrow(/Missing permission membership:write/);
    await expect(runWithRequestContext({ personalToken: { id: 't', userId: admin.id, scope: 'sudo' } } as never, () => members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj, role: 'DEVELOPER', userIds: [someone.id] }))).resolves.toBeTruthy();
  }, 20_000);

  it('one direct membership per person per scope; expiry stops the role from applying; the last org admin stays', async () => {
    const someone = await person('exp');
    const first = await members.add(actor(admin), { scopeType: 'TEAM', scopeId: team, role: 'DEVELOPER', userIds: [someone.id], expiresAt: '2999-01-01' });
    const again = await members.add(actor(admin), { scopeType: 'TEAM', scopeId: team, role: 'TEAM_LEAD', userIds: [someone.id] });
    expect(again.added[0]).toEqual(expect.objectContaining({ membershipId: first.added[0]!.membershipId, updated: true }));
    await expect(members.add(actor(admin), { scopeType: 'TEAM', scopeId: team, role: 'DEVELOPER', userIds: [someone.id], expiresAt: '2001-01-01' })).rejects.toThrow(/must be in the future/);
    const chain = await resolver.resolveChain({ projectId: proj });
    expect(authz.hasPermission(await access.forUser(someone.id), 'job:create', chain)).toBe(true);
    await db.update(schema.memberships).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.memberships.id, first.added[0]!.membershipId));
    expect(authz.hasPermission(await access.forUser(someone.id), 'job:create', chain)).toBe(false);
    expect((await members.list(actor(admin), 'TEAM', team)).members.find((m) => m.user.id === someone.id)).toEqual(expect.objectContaining({ expired: true }));
    const [adminRow] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, admin.id));
    await expect(members.remove(actor(admin), adminRow!.id)).rejects.toThrow(/at least one organization admin/);
    await expect(members.update(actor(admin), adminRow!.id, { role: 'SECURITY_ADMIN' })).rejects.toThrow(/at least one organization admin/);
  }, 20_000);

  it('service accounts: member only of their scope and below, tokens authenticate with the mask, revoked tokens fail', async () => {
    const bot = await bots.create(actor(admin), { scopeType: 'PROJECT', scopeId: proj, name: 'Jira sync', role: 'DEVELOPER' });
    userIds.push(bot.id);
    expect(bot.username).toMatch(/^bot-jira-sync-[0-9a-f]{8}@project-[0-9a-f]{8}\.bots\.matelot\.invalid$/);
    await expect(members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj2, role: 'DEVELOPER', userIds: [bot.id] })).rejects.toThrow(/service account of another scope/);
    expect((await members.candidates(actor(admin), 'PROJECT', proj2, 'jira')).map((c) => c.id)).not.toContain(bot.id);
    await expect(bots.createToken(actor(admin), bot.id, { name: 'ci', scope: 'write', expiresInDays: 400 })).rejects.toThrow(/between 1 and 90/);
    const t = await bots.createToken(actor(admin), bot.id, { name: 'ci', scope: 'read', expiresInDays: 30 });
    expect(t.token).toMatch(/^spt_/);
    const auth = await tokens.authenticate(t.token);
    expect(auth).toEqual(expect.objectContaining({ scope: 'read', user: expect.objectContaining({ id: bot.id, platformRole: 'user' }) }));
    const chain = await resolver.resolveChain({ projectId: proj });
    const ctx = await runWithRequestContext({ personalToken: { id: auth!.tokenId, userId: bot.id, scope: 'read' } } as never, () => access.forUser(bot.id));
    expect(authz.hasPermission(ctx, 'project:read', chain)).toBe(true);
    expect(authz.hasPermission(ctx, 'job:create', chain)).toBe(false);          // read mask over DEVELOPER
    expect(authz.hasPermission(ctx, 'project:read', await resolver.resolveChain({ projectId: proj2 }))).toBe(false);
    const rotated = await bots.rotateToken(actor(admin), bot.id, t.id);
    expect(await tokens.authenticate(t.token)).toBeNull();
    expect(await tokens.authenticate(rotated.token)).not.toBeNull();
    await bots.revokeToken(actor(admin), bot.id, rotated.id);
    expect(await tokens.authenticate(rotated.token)).toBeNull();
    const sat = await bots.createScopeAccessToken(actor(admin), { scopeType: 'PROJECT', scopeId: proj, name: 'Renovate', role: 'DEVELOPER', scope: 'write', expiresInDays: 7 });
    userIds.push(sat.serviceAccount.id);
    expect(sat.serviceAccount.membershipId).toBeTruthy();
    expect((await members.list(actor(admin), 'PROJECT', proj)).members.find((m) => m.user.id === sat.serviceAccount.id)).toEqual(expect.objectContaining({ role: 'DEVELOPER', source: 'direct', user: expect.objectContaining({ kind: 'service_account' }) }));
    expect(await bots.remove(actor(admin), sat.serviceAccount.id)).toEqual({ deleted: true, memberships: 1, tokens: 1 });
    expect(await tokens.authenticate(sat.token.token)).toBeNull();
    const events = await db.select({ action: schema.auditEvents.action }).from(schema.auditEvents).where(eq(schema.auditEvents.organizationId, org));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['service_account.created', 'service_account.token_created', 'service_account.token_revoked', 'service_account.deleted', 'membership.granted', 'membership.updated']));
  }, 30_000);

  it('inviting an unknown e-mail without the Keycloak admin API creates the person for their first SSO sign-in', async () => {
    const email = `new-${s}@acme.test`;
    const r = await members.add(actor(admin), { scopeType: 'PROJECT', scopeId: proj, role: 'DEVELOPER', emails: [email, `new2-${s}@acme.test`] });
    expect(r.invited).toEqual([{ email, setupLink: null, emailed: false, viaIdentityProvider: true }, expect.objectContaining({ viaIdentityProvider: true })]);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    userIds.push(u!.id);
    const [u2] = await db.select().from(schema.users).where(eq(schema.users.email, `new2-${s}@acme.test`));
    userIds.push(u2!.id);
    expect(u!.externalId).toBeNull();
  }, 20_000);
});
