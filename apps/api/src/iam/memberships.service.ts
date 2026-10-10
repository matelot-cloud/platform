import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { memberships, organizations, projects, ScopeType, teams, users, workspaces } from '../database/schema';
import { AccessService, MembershipLike } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { scopeParamsFor } from '../rbac/scope.types';
import { GrantMembershipDto } from './dto/grant-membership.dto';
import { UsersService } from './users.service';

export interface ScopeSummary {
  type: ScopeType;
  id: string;
  slug: string;
  name: string;
}

@Injectable()
export class MembershipsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly users: UsersService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    private readonly audit: AuditService,
  ) {}

  async listForScope(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string) {
    const chain = await this.resolver.resolveChain(scopeParamsFor(scopeType, scopeId));
    const ctx = await this.access.forUser(actor.id);
    this.authz.assert(ctx, 'membership:read', chain);

    return this.db
      .select({
        id: memberships.id,
        role: memberships.role,
        scopeType: memberships.scopeType,
        scopeId: memberships.scopeId,
        createdAt: memberships.createdAt,
        user: { id: users.id, email: users.email, displayName: users.displayName, lastLoginAt: users.lastLoginAt },
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(eq(memberships.scopeType, scopeType), eq(memberships.scopeId, scopeId)))
      .orderBy(users.email);
  }

  async grant(actor: AuthenticatedUser, dto: GrantMembershipDto) {
    const chain = await this.resolver.resolveChain(scopeParamsFor(dto.scopeType, dto.scopeId));
    const ctx = await this.access.forUser(actor.id);
    this.authz.assert(ctx, 'membership:write', chain);

    const target = await this.users.findOrCreateByEmail(dto.email, userActor(actor));
    const [created] = await this.db
      .insert(memberships)
      .values({ userId: target.id, scopeType: dto.scopeType, scopeId: dto.scopeId, role: dto.role, grantedById: actor.id })
      .onConflictDoNothing()
      .returning();

    if (!created) {
      const [existing] = await this.db
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, target.id),
            eq(memberships.scopeType, dto.scopeType),
            eq(memberships.scopeId, dto.scopeId),
            eq(memberships.role, dto.role),
          ),
        )
        .limit(1);
      return { ...existing, user: { id: target.id, email: target.email, displayName: target.displayName } };
    }

    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(actor),
      action: 'membership.granted',
      resourceType: 'membership',
      resourceId: created.id,
      after: { email: target.email, role: dto.role, scopeType: dto.scopeType, scopeId: dto.scopeId },
      reason: dto.reason,
    });
    return { ...created, user: { id: target.id, email: target.email, displayName: target.displayName } };
  }

  async revoke(actor: AuthenticatedUser, membershipId: string): Promise<void> {
    const [membership] = await this.db.select().from(memberships).where(eq(memberships.id, membershipId)).limit(1);
    if (!membership) throw new NotFoundException('Membership not found');

    const chain = await this.resolver.resolveChain(scopeParamsFor(membership.scopeType, membership.scopeId));
    const ctx = await this.access.forUser(actor.id);
    this.authz.assert(ctx, 'membership:write', chain);

    if (membership.scopeType === 'ORGANIZATION' && membership.role === 'ORG_ADMIN') {
      const admins = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.scopeType, 'ORGANIZATION'),
            eq(memberships.scopeId, membership.scopeId),
            eq(memberships.role, 'ORG_ADMIN'),
          ),
        );
      if (admins.length <= 1) throw new ConflictException('An organization must keep at least one ORG_ADMIN');
    }

    await this.db.delete(memberships).where(eq(memberships.id, membershipId));
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(actor),
      action: 'membership.revoked',
      resourceType: 'membership',
      resourceId: membershipId,
      before: { userId: membership.userId, role: membership.role, scopeType: membership.scopeType, scopeId: membership.scopeId },
    });
  }

  /** Resolves slug/name for the scopes in a list of memberships (for GET /me). */
  async describeScopes(items: MembershipLike[]): Promise<Map<string, ScopeSummary>> {
    const result = new Map<string, ScopeSummary>();
    const ids = (type: ScopeType) => [...new Set(items.filter((m) => m.scopeType === type).map((m) => m.scopeId))];

    const add = (type: ScopeType, rows: { id: string; slug: string; name: string }[]) =>
      rows.forEach((r) => result.set(`${type}:${r.id}`, { type, ...r }));

    const orgIds = ids('ORGANIZATION');
    if (orgIds.length) {
      add(
        'ORGANIZATION',
        await this.db
          .select({ id: organizations.id, slug: organizations.slug, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, orgIds)),
      );
    }
    const wsIds = ids('WORKSPACE');
    if (wsIds.length) {
      add(
        'WORKSPACE',
        await this.db
          .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
          .from(workspaces)
          .where(inArray(workspaces.id, wsIds)),
      );
    }
    const teamIds = ids('TEAM');
    if (teamIds.length) {
      add(
        'TEAM',
        await this.db.select({ id: teams.id, slug: teams.slug, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)),
      );
    }
    const projectIds = ids('PROJECT');
    if (projectIds.length) {
      add(
        'PROJECT',
        await this.db
          .select({ id: projects.id, slug: projects.slug, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds)),
      );
    }
    return result;
  }
}
