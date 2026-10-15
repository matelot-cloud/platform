import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';
import { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { memberships, organizations, PlatformRole, User, users } from '../database/schema';
import { assertFeature } from '../features/features';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { InvitesService } from './invites.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { ScopeNamesService } from './scope-names.service';
import { normalizeEmail } from './users.service';

export interface CreateUserInput { email: string; firstName?: string; lastName?: string; temporaryPassword?: string; reason?: string }

/**
 * Administration → Users: everything about a person in one place — create (Keycloak user + a temporary password or a
 * one-time setup link), disable / enable (Keycloak too, sessions ended), reset the password, delete, and their roles
 * and tokens across scopes. Allowed to cell administrators and to whoever holds organization:write on the root
 * organization (its admins) — with a token, that means sudo. Changing the cell role (platform admin) stays with cell
 * administrators.
 */
@Injectable()
export class UserAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly keycloak: KeycloakAdminService,
    private readonly invites: InvitesService,
    private readonly tokens: PersonalTokensService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    private readonly names: ScopeNamesService,
    private readonly audit: AuditService,
  ) {}

  private async rootOrganizationId(): Promise<string | null> {
    const slug = this.config.get('BOOTSTRAP_ORG_SLUG', { infer: true });
    const [row] = slug
      ? await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1)
      : await this.db.select({ id: organizations.id }).from(organizations).where(isNull(organizations.parentId)).orderBy(asc(organizations.createdAt)).limit(1);
    return row?.id ?? null;
  }

  async assertUserAdmin(actor: AuthenticatedUser): Promise<{ platformAdmin: boolean; organizationId: string | null }> {
    const organizationId = await this.rootOrganizationId();
    if (actor.platformRole === 'admin') return { platformAdmin: true, organizationId };
    if (organizationId) {
      const ctx = await this.access.forUser(actor.id);
      const chain = await this.resolver.resolveChain({ organizationId });
      if (this.authz.hasPermission(ctx, 'organization:write', chain)) return { platformAdmin: false, organizationId };
    }
    throw new ForbiddenException('User administration is for cell administrators and administrators of the root organization');
  }

  private publicView(u: User) {
    return { id: u.id, email: u.email, displayName: u.displayName, kind: u.kind, platformRole: u.platformRole, disabledAt: u.disabledAt, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, signInReady: !!u.externalId };
  }

  async capabilities(actor: AuthenticatedUser) {
    const who = await this.assertUserAdmin(actor);
    return { keycloak: this.keycloak.available, email: !!this.invites.smtp(), canChangeCellRole: who.platformAdmin };
  }

  async list(actor: AuthenticatedUser, kind?: string) {
    await this.assertUserAdmin(actor);
    const rows = await this.db
      .select({
        id: users.id, email: users.email, displayName: users.displayName, kind: users.kind, platformRole: users.platformRole, disabledAt: users.disabledAt,
        lastLoginAt: users.lastLoginAt, createdAt: users.createdAt, signInReady: sql<boolean>`${users.externalId} is not null`, membershipCount: count(memberships.id),
      })
      .from(users)
      .leftJoin(memberships, eq(memberships.userId, users.id))
      .where(kind ? eq(users.kind, kind) : undefined)
      .groupBy(users.id)
      .orderBy(asc(users.email));
    return rows.map((r) => ({ ...r, membershipCount: Number(r.membershipCount) }));
  }

  async detail(actor: AuthenticatedUser, id: string) {
    await this.assertUserAdmin(actor);
    const user = await this.load(id);
    const rows = await this.db.select().from(memberships).where(eq(memberships.userId, id));
    const names = await this.names.describeScopes(rows);
    return {
      user: { ...this.publicView(user), ownerScopeType: user.ownerScopeType, ownerScopeId: user.ownerScopeId, description: user.description },
      memberships: rows.map((m) => ({ id: m.id, role: m.role, scopeType: m.scopeType, scopeId: m.scopeId, scope: names.get(`${m.scopeType}:${m.scopeId}`) ?? null, expiresAt: m.expiresAt, expired: !!m.expiresAt && m.expiresAt.getTime() <= Date.now(), grantedAt: m.createdAt })),
      tokens: await this.tokens.listFor(id),
    };
  }

  async create(actor: AuthenticatedUser, input: CreateUserInput) {
    assertFeature('user_admin');
    const who = await this.assertUserAdmin(actor);
    const email = normalizeEmail(input.email ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('A valid e-mail address is required');
    if (input.temporaryPassword !== undefined && input.temporaryPassword.length < 12) throw new BadRequestException('A temporary password needs at least 12 characters');
    const [existing] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing && existing.externalId) throw new ConflictException(`${email} already exists`);
    const kc = await this.keycloak.ensureUser({ email, firstName: input.firstName?.trim() || undefined, lastName: input.lastName?.trim() || undefined });
    const displayName = [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(' ') || null;
    const [user] = existing
      ? await this.db.update(users).set({ externalId: kc.id, displayName: existing.displayName ?? displayName }).where(eq(users.id, existing.id)).returning()
      : await this.db.insert(users).values({ email, externalId: kc.id, displayName, createdById: actor.token ? null : actor.id }).returning();
    await this.audit.record({ organizationId: who.organizationId, actor: userActor(actor), action: 'user.created', resourceType: 'user', resourceId: user!.id, after: { email, displayName, keycloakUser: kc.created ? 'created' : 'existing' }, reason: input.reason });
    if (input.temporaryPassword) {
      await this.keycloak.setPassword(kc.id, input.temporaryPassword, true);
      return { user: this.publicView(user!), temporaryPassword: true, setupLink: null, emailed: false };
    }
    assertFeature('invite_links');
    const link = await this.invites.issue(user!.id, 'invite', userActor(actor), { organizationId: who.organizationId });
    return { user: this.publicView(user!), temporaryPassword: false, ...link };
  }

  /** Temporary password (changed at the next login), or a one-time reset link (e-mailed when SMTP is set). */
  async resetPassword(actor: AuthenticatedUser, id: string, input: { temporaryPassword?: string; reason?: string }) {
    const who = await this.assertUserAdmin(actor);
    const user = await this.load(id);
    if (user.kind !== 'human') throw new BadRequestException('Service accounts have no password: rotate their tokens');
    const kcId = await this.keycloakIdOf(user);
    if (input.temporaryPassword !== undefined) {
      if (input.temporaryPassword.length < 12) throw new BadRequestException('A temporary password needs at least 12 characters');
      await this.keycloak.setPassword(kcId, input.temporaryPassword, true);
      await this.audit.record({ organizationId: who.organizationId, actor: userActor(actor), action: 'user.password_reset', resourceType: 'user', resourceId: id, after: { email: user.email, via: 'temporary password' }, reason: input.reason });
      return { temporaryPassword: true, setupLink: null, emailed: false };
    }
    const link = await this.invites.issue(id, 'reset', userActor(actor), { organizationId: who.organizationId });
    return { temporaryPassword: false, ...link };
  }

  async update(actor: AuthenticatedUser, id: string, dto: { platformRole?: PlatformRole; enabled?: boolean; reason?: string }) {
    const who = await this.assertUserAdmin(actor);
    const before = await this.load(id);
    const changes: Partial<typeof users.$inferInsert> = {};
    if (dto.platformRole && dto.platformRole !== before.platformRole) {
      if (!who.platformAdmin) throw new ForbiddenException('Only cell administrators change the cell role');
      if (before.kind !== 'human') throw new BadRequestException('A service account cannot be a cell administrator');
      if (before.id === actor.id && dto.platformRole !== 'admin') throw new ConflictException('You cannot remove your own administrator role');
      if (before.platformRole === 'admin' && dto.platformRole !== 'admin' && (await this.adminCount()) <= 1) throw new ConflictException('The cell must keep at least one administrator');
      changes.platformRole = dto.platformRole;
    }
    if (dto.enabled !== undefined && dto.enabled === !!before.disabledAt) {
      if (!dto.enabled && before.id === actor.id) throw new ConflictException('You cannot disable your own account');
      if (!dto.enabled && before.platformRole === 'admin' && (await this.adminCount()) <= 1) throw new ConflictException('The cell must keep at least one enabled administrator');
      changes.disabledAt = dto.enabled ? null : new Date();
      if (before.kind === 'human' && before.externalId && this.keycloak.available) await this.keycloak.setEnabled(before.externalId, dto.enabled);
    }
    if (!Object.keys(changes).length) return this.publicView(before);
    const [after] = await this.db.update(users).set(changes).where(eq(users.id, id)).returning();
    await this.audit.record({ organizationId: who.organizationId, actor: userActor(actor), action: changes.platformRole ? 'user.platform_role_changed' : dto.enabled ? 'user.enabled' : 'user.disabled', resourceType: 'user', resourceId: id, before: this.publicView(before), after: this.publicView(after!), reason: dto.reason });
    return this.publicView(after!);
  }

  /** Deletes the person: Keycloak user, platform user, their memberships and tokens (audit events keep their e-mail). */
  async remove(actor: AuthenticatedUser, id: string, reason?: string) {
    assertFeature('user_admin');
    const who = await this.assertUserAdmin(actor);
    const user = await this.load(id);
    if (user.id === actor.id) throw new ConflictException('You cannot delete your own account');
    if (user.platformRole === 'admin' && (await this.adminCount()) <= 1) throw new ConflictException('The cell must keep at least one administrator');
    const rows = await this.db.select().from(memberships).where(eq(memberships.userId, id));
    for (const m of rows.filter((r) => r.scopeType === 'ORGANIZATION' && r.role === 'ORG_ADMIN')) {
      const [{ n }] = await this.db.select({ n: count() }).from(memberships).where(and(eq(memberships.scopeType, 'ORGANIZATION'), eq(memberships.scopeId, m.scopeId), eq(memberships.role, 'ORG_ADMIN')));
      if (Number(n) <= 1) {
        const names = await this.names.describeScopes([m]);
        throw new ConflictException(`${user.email} is the only organization admin of ${names.get(`ORGANIZATION:${m.scopeId}`)?.name ?? m.scopeId}: make someone else admin first`);
      }
    }
    const tokenList = await this.tokens.listFor(id);
    if (user.kind === 'human' && user.externalId && this.keycloak.available) await this.keycloak.deleteUser(user.externalId);
    await this.db.delete(users).where(eq(users.id, id));
    const summary = { email: user.email, kind: user.kind, memberships: rows.length, tokens: tokenList.length, activeTokens: tokenList.filter((t) => !t.revokedAt && !t.expired).length };
    await this.audit.record({ organizationId: who.organizationId, actor: userActor(actor), action: 'user.deleted', resourceType: 'user', resourceId: id, before: { ...summary, roles: rows.map((r) => `${r.role}@${r.scopeType.toLowerCase()}:${r.scopeId}`) }, reason });
    return { deleted: true, ...summary };
  }

  /** A strong random temporary password for the UI's "generate" button (never stored). */
  generatePassword(): string {
    return randomBytes(12).toString('base64url');
  }

  private async keycloakIdOf(user: User): Promise<string> {
    if (user.externalId) return user.externalId;
    const kc = await this.keycloak.ensureUser({ email: user.email });
    await this.db.update(users).set({ externalId: kc.id }).where(eq(users.id, user.id));
    return kc.id;
  }

  private async load(id: string): Promise<User> {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!u) throw new NotFoundException('User not found');
    return u;
  }

  private async adminCount(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users).where(and(eq(users.platformRole, 'admin'), isNull(users.disabledAt)));
    return Number(row?.n ?? 0);
  }
}
