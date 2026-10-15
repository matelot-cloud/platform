/**
 * User administration and one-time setup links against a real database and a fake Keycloak admin API: create a user
 * (Keycloak user + setup link, shown because no SMTP), the link sets a final password once, reset with a temporary
 * password, disable (Keycloak too, sessions ended), delete (Keycloak user, memberships, tokens; a sole org admin is
 * refused), and who may do it. Needs TEST_DATABASE_URL.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { createServer, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { InvitesService } from './invites.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { ScopeNamesService } from './scope-names.service';
import { UserAdminService } from './user-admin.service';

interface KcUser { id: string; username: string; email: string; enabled: boolean; firstName?: string; lastName?: string; password?: { value: string; temporary: boolean } }

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('user administration + setup links (database, fake Keycloak)', () => {
  const kc: { users: KcUser[]; logouts: string[]; deleted: string[] } = { users: [], logouts: [], deleted: [] };
  let server: Server;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as never as import('../database/database.module').Database;
  const s = randomUUID().slice(0, 8);
  const env: Record<string, unknown> = { KEYCLOAK_ISSUER: 'http://kc.test/realms/platform', WEB_BASE_URL: 'https://cell.test/', BOOTSTRAP_ORG_SLUG: `ua-${s}`, KC_BOOTSTRAP_ADMIN_USERNAME: 'admin', KC_BOOTSTRAP_ADMIN_PASSWORD: 'kc-secret' };
  let svc: UserAdminService; let invites: InvitesService;
  const ids: { users: string[]; org?: string } = { users: [] };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const u = new URL(req.url!, 'http://x');
        const json = (code: number, b?: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(b === undefined ? '' : JSON.stringify(b)); };
        if (u.pathname === '/realms/master/protocol/openid-connect/token') return json(200, body.includes('password=kc-secret') ? { access_token: 'adm', expires_in: 60 } : {});
        if (req.headers.authorization !== 'Bearer adm') return json(401, {});
        const base = '/admin/realms/platform/users';
        if (u.pathname === base && req.method === 'GET') return json(200, kc.users.filter((x) => x.email === u.searchParams.get('email')));
        if (u.pathname === base && req.method === 'POST') { const b = JSON.parse(body); const id = randomUUID(); kc.users.push({ id, ...b }); return json(201, undefined, { location: `http://x${base}/${id}` }); }
        const m = /^\/admin\/realms\/platform\/users\/([^/]+)(\/.*)?$/.exec(u.pathname);
        const user = m && kc.users.find((x) => x.id === m[1]);
        if (!m || !user) return json(404, {});
        if (m[2] === '/reset-password') { const b = JSON.parse(body); if (String(b.value).includes('weak')) return json(400, { error: 'invalidPasswordMinLengthMessage', errorMessage: 'Invalid password: minimum length 14.' }); user.password = { value: b.value, temporary: b.temporary }; return json(204); }
        if (m[2] === '/logout') { kc.logouts.push(user.id); return json(204); }
        if (!m[2] && req.method === 'PUT') { Object.assign(user, JSON.parse(body)); return json(204); }
        if (!m[2] && req.method === 'DELETE') { kc.users = kc.users.filter((x) => x !== user); kc.deleted.push(user.id); return json(204); }
        return json(404, {});
      });
    });
    await new Promise<void>((d) => server.listen(0, '127.0.0.1', d));
    env.KEYCLOAK_ADMIN_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = { get: (k: string) => env[k] } as never;
    const audit = new AuditService(db); const resolver = new ScopeResolverService(db);
    const keycloak = new KeycloakAdminService(config);
    invites = new InvitesService(db, config, keycloak, audit);
    svc = new UserAdminService(db, config, keycloak, invites, new PersonalTokensService(db, audit, resolver), new AccessService(db), new AuthorizationService(), resolver, new ScopeNamesService(db), audit);
    const [o] = await db.insert(schema.organizations).values({ slug: `ua-${s}`, name: `Root ${s}` }).returning(); ids.org = o!.id;
  });
  afterAll(async () => {
    for (const id of ids.users) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => undefined);
    if (ids.org) await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)).catch(() => undefined);
    await pool.end(); server.close();
  });

  const mk = async (tag: string, platformRole: 'admin' | 'user' = 'user') => { const [u] = await db.insert(schema.users).values({ email: `${tag}-${s}@acme.test`, externalId: null, platformRole }).returning(); ids.users.push(u!.id); return u!; };
  const as = (u: typeof schema.users.$inferSelect): AuthenticatedUser => ({ id: u.id, email: u.email, displayName: u.displayName, externalId: u.id, platformRole: u.platformRole });

  it('create → setup link (no SMTP: returned once) → the person sets a final password → the link is gone', async () => {
    const cellAdmin = await mk('celladmin', 'admin');
    const r = await svc.create(as(cellAdmin), { email: `Jane.Doe-${s}@Acme.test`, firstName: 'Jane', lastName: 'Doe' });
    ids.users.push(r.user.id);
    expect(r).toEqual(expect.objectContaining({ temporaryPassword: false, emailed: false, setupLink: expect.stringMatching(/^https:\/\/cell\.test\/invite\/[A-Za-z0-9_-]{43}$/) }));
    expect(r.user).toEqual(expect.objectContaining({ email: `jane.doe-${s}@acme.test`, displayName: 'Jane Doe', signInReady: true }));
    const kcUser = kc.users.find((x) => x.email === `jane.doe-${s}@acme.test`)!;
    expect(kcUser).toEqual(expect.objectContaining({ username: `jane.doe-${s}@acme.test`, firstName: 'Jane', lastName: 'Doe', enabled: true }));
    const token = r.setupLink!.split('/').pop()!;
    await expect(invites.describe(token)).resolves.toEqual(expect.objectContaining({ email: `jane.doe-${s}@acme.test`, purpose: 'invite', minLength: 12 }));
    await expect(invites.complete(token, 'short')).rejects.toThrow(/at least 12 characters/);
    await expect(invites.complete(token, 'weak-but-long-enough')).rejects.toThrow(/minimum length 14/);   // Keycloak's policy speaks
    await expect(invites.complete(token, 'correct horse battery')).resolves.toEqual({ email: `jane.doe-${s}@acme.test`, signInUrl: 'https://cell.test/' });
    expect(kcUser.password).toEqual({ value: 'correct horse battery', temporary: false });
    await expect(invites.describe(token)).rejects.toThrow(/already used/);
  }, 20_000);

  it('reset with a temporary password; disable ends the Keycloak sessions; delete removes everything but a sole org admin', async () => {
    const cellAdmin = await mk('celladmin2', 'admin');
    const r = await svc.create(as(cellAdmin), { email: `bob-${s}@acme.test`, temporaryPassword: 'first-login-pass' });
    ids.users.push(r.user.id);
    const kcUser = kc.users.find((x) => x.email === `bob-${s}@acme.test`)!;
    expect(kcUser.password).toEqual({ value: 'first-login-pass', temporary: true });
    await svc.resetPassword(as(cellAdmin), r.user.id, { temporaryPassword: 'another-temp-pass' });
    expect(kcUser.password).toEqual({ value: 'another-temp-pass', temporary: true });
    const link = await svc.resetPassword(as(cellAdmin), r.user.id, {});
    expect(link.setupLink).toMatch(/\/invite\//);
    await svc.update(as(cellAdmin), r.user.id, { enabled: false });
    expect(kcUser.enabled).toBe(false); expect(kc.logouts).toContain(kcUser.id);
    await svc.update(as(cellAdmin), r.user.id, { enabled: true });
    expect(kcUser.enabled).toBe(true);
    await db.insert(schema.memberships).values({ userId: r.user.id, scopeType: 'ORGANIZATION', scopeId: ids.org!, role: 'ORG_ADMIN' });
    await expect(svc.remove(as(cellAdmin), r.user.id)).rejects.toThrow(/only organization admin of Root/);
    await db.insert(schema.memberships).values({ userId: cellAdmin.id, scopeType: 'ORGANIZATION', scopeId: ids.org!, role: 'ORG_ADMIN' });
    await expect(svc.remove(as(cellAdmin), r.user.id)).resolves.toEqual(expect.objectContaining({ deleted: true, memberships: 1, tokens: 0 }));
    expect(kc.deleted).toContain(kcUser.id);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, r.user.id))).toEqual([]);
    const detail = await svc.detail(as(cellAdmin), cellAdmin.id);
    expect(detail.memberships).toEqual([expect.objectContaining({ role: 'ORG_ADMIN', scope: expect.objectContaining({ name: `Root ${s}` }) })]);
  }, 20_000);

  it('who: cell admins and root-organization admins; nobody else; only cell admins change the cell role', async () => {
    const plain = await mk('plain');
    await expect(svc.list(as(plain))).rejects.toThrow(/cell administrators and administrators of the root organization/);
    const orgAdmin = await mk('orgadmin');
    await db.insert(schema.memberships).values({ userId: orgAdmin.id, scopeType: 'ORGANIZATION', scopeId: ids.org!, role: 'ORG_ADMIN' });
    await expect(svc.capabilities(as(orgAdmin))).resolves.toEqual({ keycloak: true, email: false, canChangeCellRole: false });
    await expect(svc.update(as(orgAdmin), plain.id, { platformRole: 'admin' })).rejects.toThrow(/Only cell administrators change the cell role/);
    await expect(svc.update(as(orgAdmin), plain.id, { enabled: false })).resolves.toEqual(expect.objectContaining({ disabledAt: expect.any(Date) }));
  }, 20_000);
});
