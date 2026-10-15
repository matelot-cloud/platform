import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Membership, memberships, Role, ScopeType, User, users } from '../database/schema';
import { assertFeature, featureEnabled } from '../features/features';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ROLE_PERMISSIONS } from '../rbac/permissions';
import { MEMBER_SCOPES, MemberScope, roleAddsNothing, roleInfo, rolesForScope, ROLE_ORDER } from '../rbac/role-catalog';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor, ScopeRef } from '../rbac/scope.types';
import { InvitesService } from './invites.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { ScopeNamesService, ScopeSummary } from './scope-names.service';
import { normalizeEmail } from './users.service';

export interface MemberRow {
  membershipId: string;
  user: { id: string; email: string; displayName: string | null; kind: string; lastLoginAt: Date | null; disabled: boolean };
  role: Role;
  roleLabel: string;
  source: 'direct' | 'inherited';
  /** Where an inherited row is granted (link target in the UI); null for direct rows. */
  inheritedFrom: ScopeSummary | null;
  grantedBy: { id: string; email: string } | null;
  grantedAt: Date;
  expiresAt: Date | null;
  expired: boolean;
  /** The caller may change or remove this row here (direct rows only, and only what they could grant). */
  canEdit: boolean;
}

export interface AddMembersInput {
  scopeType: ScopeType;
  scopeId: string;
  role: Role;
  userIds?: string[];
  emails?: string[];
  expiresAt?: string | null;
  reason?: string;
}

const isMemberScope = (t: ScopeType): t is MemberScope => (MEMBER_SCOPES as readonly ScopeType[]).includes(t);
const live = (m: { expiresAt: Date | null }) => !m.expiresAt || m.expiresAt.getTime() > Date.now();

/**
 * Members, GitLab-style: one direct membership per person per scope (organization, workspace, team, project); roles
 * granted above apply below and are listed there as inherited (read-only, with where they come from). Rules:
 *   - managing members needs membership:write at the scope (so a write-scoped token cannot: sudo or the web session);
 *   - nobody grants a role whose permissions exceed their own at that scope (platform admins excepted);
 *   - a direct role must add something to what the person inherits: raise, never lower;
 *   - only roles that make sense at the scope are offered (role-catalog.ts);
 *   - service accounts can only be members of the scope that owns them and below;
 *   - an organization keeps at least one live ORG_ADMIN.
 */
@Injectable()
export class MembersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    private readonly audit: AuditService,
    private readonly keycloak: KeycloakAdminService,
    private readonly invites: InvitesService,
    private readonly names: ScopeNamesService,
  ) {}

  async chainOf(scopeType: ScopeType, scopeId: string): Promise<ScopeChain> {
    if (!isMemberScope(scopeType)) throw new BadRequestException('Members exist on organizations, workspaces, teams and projects');
    return this.resolver.resolveChain(scopeParamsFor(scopeType, scopeId));
  }

  /** Member refs of a chain (no services / environments), root first; the last one is the scope itself. */
  private memberRefs(chain: ScopeChain): ScopeRef[] {
    return chain.refs.filter((r) => isMemberScope(r.type));
  }

  private async actorPermissions(actor: AuthenticatedUser, chain: ScopeChain) {
    const ctx = await this.access.forUser(actor.id);
    return { ctx, perms: this.authz.permissionsFor(ctx, chain) };
  }

  /** Roles offered at a scope, in order, with whether the caller may grant each one. */
  async roles(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string) {
    const chain = await this.chainOf(scopeType, scopeId);
    const { ctx, perms } = await this.actorPermissions(actor, chain);
    this.authz.assert(ctx, 'membership:read', chain);
    const canManage = perms.has('membership:write');
    return rolesForScope(scopeType).map((r) => ({ ...r, scopes: [...r.scopes], grantable: canManage && (ctx.isPlatformAdmin && !ctx.tokenScope ? true : roleAddsNothing(r.role, perms)) }));
  }

  async list(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string): Promise<{ scope: ScopeSummary; canManage: boolean; members: MemberRow[] }> {
    const chain = await this.chainOf(scopeType, scopeId);
    const { ctx, perms } = await this.actorPermissions(actor, chain);
    this.authz.assert(ctx, 'membership:read', chain);
    const refs = this.memberRefs(chain);
    const inherited = featureEnabled('inherited_members');
    const wanted = inherited ? refs : refs.slice(-1);
    const grantor = alias(users, 'grantor');
    const rows = await this.db
      .select({ m: memberships, u: users, g: { id: grantor.id, email: grantor.email } })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .leftJoin(grantor, eq(memberships.grantedById, grantor.id))
      .where(or(...wanted.map((r) => and(eq(memberships.scopeType, r.type), eq(memberships.scopeId, r.id))))!);
    const names = await this.describe(wanted);
    const canManage = perms.has('membership:write');
    const self = chain.target;
    const out: MemberRow[] = rows.map(({ m, u, g }) => {
      const direct = m.scopeType === self.type && m.scopeId === self.id;
      return {
        membershipId: m.id,
        user: { id: u.id, email: u.email, displayName: u.displayName, kind: u.kind, lastLoginAt: u.lastLoginAt, disabled: !!u.disabledAt },
        role: m.role,
        roleLabel: roleInfo(m.role)?.label ?? m.role,
        source: direct ? 'direct' : 'inherited',
        inheritedFrom: direct ? null : (names.get(`${m.scopeType}:${m.scopeId}`) ?? null),
        grantedBy: g?.id ? { id: g.id, email: g.email } : null,
        grantedAt: m.createdAt,
        expiresAt: m.expiresAt,
        expired: !live(m),
        canEdit: direct && canManage && (ctx.isPlatformAdmin && !ctx.tokenScope ? true : roleAddsNothing(m.role, perms)),
      };
    });
    const depth = new Map(refs.map((r, i) => [`${r.type}:${r.id}`, i]));
    out.sort((a, b) => a.user.email.localeCompare(b.user.email) || (a.source === b.source ? 0 : a.source === 'direct' ? -1 : 1) || (depth.get(b.inheritedFrom ? `${b.inheritedFrom.type}:${b.inheritedFrom.id}` : '') ?? 0) - (depth.get(a.inheritedFrom ? `${a.inheritedFrom.type}:${a.inheritedFrom.id}` : '') ?? 0) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    return { scope: names.get(`${self.type}:${self.id}`)!, canManage, members: out };
  }

  /** People the caller can add here: humans (not disabled) and the service accounts owned on this chain; not yet direct members. */
  async candidates(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string, q: string) {
    const chain = await this.chainOf(scopeType, scopeId);
    const { ctx } = await this.actorPermissions(actor, chain);
    this.authz.assert(ctx, 'membership:write', chain);
    const refs = this.memberRefs(chain);
    const term = `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const direct = this.db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.scopeType, chain.target.type), eq(memberships.scopeId, chain.target.id)));
    const rows = await this.db
      .select({ id: users.id, email: users.email, displayName: users.displayName, kind: users.kind })
      .from(users)
      .where(and(
        isNull(users.disabledAt),
        or(ilike(users.email, term), ilike(users.displayName, term)),
        or(eq(users.kind, 'human'), and(eq(users.kind, 'service_account'), or(...refs.map((r) => and(eq(users.ownerScopeType, r.type), eq(users.ownerScopeId, r.id)))))),
        sql`${users.id} not in (${direct})`,
      ))
      .orderBy(users.email)
      .limit(20);
    return rows;
  }

  /** Adds people by id and/or e-mail (bulk). Unknown e-mails become invited users (Keycloak user + setup link). */
  async add(actor: AuthenticatedUser, input: AddMembersInput) {
    const chain = await this.chainOf(input.scopeType, input.scopeId);
    const { ctx, perms } = await this.actorPermissions(actor, chain);
    this.authz.assert(ctx, 'membership:write', chain);
    this.assertRoleAt(input.role, input.scopeType);
    this.assertGrantable(ctx, perms, input.role);
    const expiresAt = this.parseExpiry(input.expiresAt);
    const emails = [...new Set((input.emails ?? []).map(normalizeEmail).filter(Boolean))];
    const ids = [...new Set(input.userIds ?? [])];
    if (!emails.length && !ids.length) throw new BadRequestException('Name at least one person (userIds or emails)');
    if (emails.length + ids.length > 1) assertFeature('bulk_invite');
    for (const e of emails) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new BadRequestException(`Not an e-mail address: ${e}`);

    const targets: { user: User; invited: boolean }[] = [];
    if (ids.length) {
      const found = await this.db.select().from(users).where(inArray(users.id, ids));
      for (const id of ids) { const u = found.find((x) => x.id === id); if (!u) throw new NotFoundException(`User ${id} not found`); targets.push({ user: u, invited: false }); }
    }
    for (const email of emails) {
      const [existing] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing) { targets.push({ user: existing, invited: false }); continue; }
      targets.push({ user: await this.inviteUser(actor, email, chain), invited: true });
    }

    const added: { membershipId: string; email: string; role: Role; updated: boolean }[] = [];
    const skipped: { email: string; reason: string }[] = [];
    const invited: { email: string; setupLink: string | null; emailed: boolean; viaIdentityProvider: boolean }[] = [];
    for (const { user, invited: isNew } of targets) {
      try {
        const r = await this.upsert(actor, chain, user, input.role, expiresAt, input.reason);
        added.push({ membershipId: r.id, email: user.email, role: input.role, updated: r.updated });
        if (isNew) {
          if (this.keycloak.available && featureEnabled('invite_links')) {
            const link = await this.invites.issue(user.id, 'invite', userActor(actor), { invitedTo: `${chain.target.type.toLowerCase()}`, organizationId: chain.organizationId });
            invited.push({ email: user.email, setupLink: link.setupLink, emailed: link.emailed, viaIdentityProvider: false });
          } else invited.push({ email: user.email, setupLink: null, emailed: false, viaIdentityProvider: true });
        }
      } catch (e) {
        if (targets.length === 1) throw e;
        skipped.push({ email: user.email, reason: (e as Error).message });
      }
    }
    return { added, skipped, invited };
  }

  /** Changes the role and/or expiry of a direct membership. */
  async update(actor: AuthenticatedUser, membershipId: string, patch: { role?: Role; expiresAt?: string | null; reason?: string }) {
    const m = await this.membership(membershipId);
    const chain = await this.chainOf(m.scopeType, m.scopeId);
    const { ctx, perms } = await this.actorPermissions(actor, chain);
    this.authz.assert(ctx, 'membership:write', chain);
    this.assertGrantable(ctx, perms, m.role);             // may not touch a membership above their own
    const role = patch.role ?? m.role;
    if (patch.role) { this.assertRoleAt(role, m.scopeType); this.assertGrantable(ctx, perms, role); }
    const expiresAt = patch.expiresAt === undefined ? m.expiresAt : this.parseExpiry(patch.expiresAt);
    const [user] = await this.db.select().from(users).where(eq(users.id, m.userId)).limit(1);
    if (role !== m.role) await this.assertAddsAccess(chain, user!, role);
    if (m.role === 'ORG_ADMIN' && (role !== 'ORG_ADMIN' || (expiresAt && !m.expiresAt))) await this.assertNotLastAdmin(m);
    const [after] = await this.db.update(memberships).set({ role, expiresAt, updatedAt: new Date() }).where(eq(memberships.id, m.id)).returning();
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'membership.updated', resourceType: 'membership', resourceId: m.id, before: { email: user!.email, role: m.role, expiresAt: m.expiresAt }, after: { email: user!.email, role, expiresAt }, reason: patch.reason });
    return after;
  }

  async remove(actor: AuthenticatedUser, membershipId: string, reason?: string): Promise<void> {
    const m = await this.membership(membershipId);
    const chain = await this.chainOf(m.scopeType, m.scopeId);
    const { ctx, perms } = await this.actorPermissions(actor, chain);
    const self = m.userId === actor.id;
    // leaving: anyone may remove their own direct membership (GitLab "leave group"), except the last organization admin
    if (!self) { this.authz.assert(ctx, 'membership:write', chain); this.assertGrantable(ctx, perms, m.role); }
    if (m.role === 'ORG_ADMIN') await this.assertNotLastAdmin(m);
    await this.db.delete(memberships).where(eq(memberships.id, m.id));
    const [user] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, m.userId)).limit(1);
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: self ? 'membership.left' : 'membership.revoked', resourceType: 'membership', resourceId: m.id, before: { email: user?.email, userId: m.userId, role: m.role, scopeType: m.scopeType, scopeId: m.scopeId, expiresAt: m.expiresAt }, reason });
  }

  // ---- internals -----------------------------------------------------------------------------

  /** One direct membership per person per scope: adding someone who is already a direct member changes their role. */
  async upsert(actor: AuthenticatedUser, chain: ScopeChain, user: User, role: Role, expiresAt: Date | null, reason?: string): Promise<{ id: string; updated: boolean }> {
    if (user.kind === 'service_account') {
      const owned = chain.refs.some((r) => r.type === user.ownerScopeType && r.id === user.ownerScopeId);
      if (!owned) throw new ConflictException(`${user.displayName ?? user.email} is a service account of another scope; it can only be a member where it belongs and below`);
    }
    await this.assertAddsAccess(chain, user, role);
    const target = chain.target;
    const existing = await this.db.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.scopeType, target.type), eq(memberships.scopeId, target.id)));
    if (existing.length) {
      const keep = existing[0]!;
      if (keep.role === 'ORG_ADMIN' && role !== 'ORG_ADMIN') await this.assertNotLastAdmin(keep);
      const [after] = await this.db.update(memberships).set({ role, expiresAt, updatedAt: new Date(), grantedById: actor.token ? keep.grantedById : actor.id }).where(eq(memberships.id, keep.id)).returning();
      if (existing.length > 1) await this.db.delete(memberships).where(inArray(memberships.id, existing.slice(1).map((x) => x.id)));
      await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'membership.updated', resourceType: 'membership', resourceId: keep.id, before: { email: user.email, roles: existing.map((x) => x.role), expiresAt: keep.expiresAt }, after: { email: user.email, role, expiresAt }, reason });
      return { id: after!.id, updated: true };
    }
    const [created] = await this.db.insert(memberships).values({ userId: user.id, scopeType: target.type, scopeId: target.id, role, expiresAt, grantedById: actor.token ? null : actor.id }).returning();
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'membership.granted', resourceType: 'membership', resourceId: created!.id, after: { email: user.email, kind: user.kind, role, scopeType: target.type, scopeId: target.id, expiresAt }, reason });
    return { id: created!.id, updated: false };
  }

  private async inviteUser(actor: AuthenticatedUser, email: string, chain: ScopeChain): Promise<User> {
    let externalId: string | null = null;
    if (this.keycloak.available && featureEnabled('invite_links')) externalId = (await this.keycloak.ensureUser({ email })).id;
    const [created] = await this.db.insert(users).values({ email, externalId, createdById: actor.token ? null : actor.id }).onConflictDoNothing().returning();
    const user = created ?? (await this.db.select().from(users).where(eq(users.email, email)).limit(1))[0]!;
    if (created) await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'user.invited', resourceType: 'user', resourceId: user.id, after: { email, keycloak: !!externalId } });
    return user;
  }

  private async membership(id: string): Promise<Membership> {
    const [m] = await this.db.select().from(memberships).where(eq(memberships.id, id)).limit(1);
    if (!m) throw new NotFoundException('Membership not found');
    return m;
  }

  private assertRoleAt(role: Role, scopeType: ScopeType) {
    if (!rolesForScope(scopeType).some((r) => r.role === role)) throw new BadRequestException(`${roleInfo(role)?.label ?? role} is not a role for a ${scopeType.toLowerCase()} (offered: ${rolesForScope(scopeType).map((r) => r.role).join(', ')})`);
  }

  /** Nobody grants (or changes, or removes) a role with permissions they do not hold here. */
  private assertGrantable(ctx: { isPlatformAdmin: boolean; tokenScope?: string }, perms: Set<string>, role: Role) {
    if (ctx.isPlatformAdmin && !ctx.tokenScope) return;
    if (!roleAddsNothing(role, perms)) {
      const missing = [...ROLE_PERMISSIONS[role]].filter((p) => !perms.has(p));
      throw new ForbiddenException(`You cannot grant ${roleInfo(role)?.label ?? role}: it includes permissions you do not have here (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''})`);
    }
  }

  /** Raise, never lower: a direct role must add something to what the person already inherits from above. */
  private async assertAddsAccess(chain: ScopeChain, user: User, role: Role) {
    const above = this.memberRefs(chain).slice(0, -1);
    if (!above.length) return;
    const rows = await this.db.select().from(memberships).where(and(eq(memberships.userId, user.id), or(...above.map((r) => and(eq(memberships.scopeType, r.type), eq(memberships.scopeId, r.id))))!));
    const inherited = rows.filter(live);
    if (!inherited.length) return;
    const held = new Set(inherited.flatMap((m) => [...ROLE_PERMISSIONS[m.role]]));
    if (roleAddsNothing(role, held)) {
      const names = await this.describe(inherited.map((m) => ({ type: m.scopeType, id: m.scopeId })));
      const best = [...inherited].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))[0]!;
      const from = names.get(`${best.scopeType}:${best.scopeId}`);
      throw new ConflictException(`${user.displayName ?? user.email} already has ${roleInfo(best.role)?.label ?? best.role} here, inherited from ${best.scopeType.toLowerCase()} ${from?.name ?? best.scopeId}; a direct role can raise that access, never lower it — pick a role that adds permissions, or change it where it is granted`);
    }
  }

  private async assertNotLastAdmin(m: Membership) {
    if (m.scopeType !== 'ORGANIZATION') return;
    const admins = await this.db.select().from(memberships).where(and(eq(memberships.scopeType, 'ORGANIZATION'), eq(memberships.scopeId, m.scopeId), eq(memberships.role, 'ORG_ADMIN')));
    if (admins.filter((a) => a.id !== m.id && live(a)).length === 0) throw new ConflictException('An organization must keep at least one organization admin');
  }

  private parseExpiry(value?: string | null): Date | null {
    if (value === undefined || value === null || value === '') return null;
    assertFeature('member_expiry');
    const d = new Date(value.length === 10 ? `${value}T23:59:59Z` : value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('expiresAt must be a date (YYYY-MM-DD) or an ISO timestamp');
    if (d.getTime() <= Date.now()) throw new BadRequestException('expiresAt must be in the future');
    return d;
  }

  private describe(refs: { type: ScopeType; id: string }[]): Promise<Map<string, ScopeSummary>> {
    return this.names.describeScopes(refs.map((r) => ({ scopeType: r.type, scopeId: r.id })));
  }
}
