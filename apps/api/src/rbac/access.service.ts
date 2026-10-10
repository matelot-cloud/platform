import { currentRequestContext } from '../common/request-context';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { apiTokens, environments, Membership, memberships, organizations, projects, Role, ScopeType, services, teams, users, workspaces } from '../database/schema';
import { ScopeRef } from './scope.types';

export type MembershipLike = Pick<Membership, 'scopeType' | 'scopeId' | 'role'> & Partial<Membership>;

const key = (ref: ScopeRef) => `${ref.type}:${ref.id}`;

/**
 * Everything RBAC needs to know about one user, loaded once per request:
 * their memberships, plus the ancestors of every membership so that a user with access to
 * a single project can still navigate to (see) its team, workspace and organization.
 */
export class AccessContext {
  private readonly rolesByScope = new Map<string, Role[]>();

  readonly visibleOrganizationIds = new Set<string>();
  readonly visibleWorkspaceIds = new Set<string>();
  readonly visibleTeamIds = new Set<string>();
  readonly visibleProjectIds = new Set<string>();
  readonly visibleServiceIds = new Set<string>();
  readonly visibleEnvironmentIds = new Set<string>();

  constructor(
    readonly userId: string,
    readonly memberships: MembershipLike[],
    /** Cell administrator: every permission at every scope (GitLab admin mode). */
    readonly isPlatformAdmin = false,
    /** CI/API token: a fixed permission set at one scope (and below), no roles. */
    readonly tokenGrant?: { scopeType: ScopeType; scopeId: string; permissions: ReadonlySet<string> },
  ) {
    for (const m of memberships) {
      const k = key({ type: m.scopeType, id: m.scopeId });
      const roles = this.rolesByScope.get(k) ?? [];
      roles.push(m.role);
      this.rolesByScope.set(k, roles);
    }
  }

  rolesAt(ref: ScopeRef): Role[] {
    return this.rolesByScope.get(key(ref)) ?? [];
  }

  get hasAnyMembership(): boolean {
    return this.memberships.length > 0;
  }
}

@Injectable()
export class AccessService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Context for a CI/API token: visibility of exactly its scope subtree, permissions from the token. */
  async forToken(token: { id: string; scopeType: ScopeType; scopeId: string; permissions: string[] }): Promise<AccessContext> {
    const pseudo = [{ id: token.id, userId: `token:${token.id}`, scopeType: token.scopeType, scopeId: token.scopeId, role: 'READ_ONLY' as Role }];
    const ctx = new AccessContext(`token:${token.id}`, [], false, { scopeType: token.scopeType, scopeId: token.scopeId, permissions: new Set(token.permissions) });
    await this.hydrateVisibility(ctx, pseudo as unknown as Membership[]);
    return ctx;
  }

  async forUser(userId: string): Promise<AccessContext> {
    if (userId.startsWith('token:')) {
      const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.id, userId.slice(6))).limit(1);
      if (!row) return new AccessContext(userId, []);
      return this.forToken({ id: row.id, scopeType: row.scopeType, scopeId: row.scopeId, permissions: row.permissions });
    }
    const [rows, [user]] = await Promise.all([
      this.db.select().from(memberships).where(eq(memberships.userId, userId)),
      this.db.select({ platformRole: users.platformRole }).from(users).where(eq(users.id, userId)).limit(1),
    ]);
    // Personal / OAuth token without sudo: the user keeps the SAME visibility (every scope they are a member of) but
    // administrative roles are downgraded — read → AUDITOR (reads everywhere they can see), write → PRODUCT_SECURITY_ENGINEER
    // (decisions, remediations, policies; no membership / token / connection administration). Dropping admin memberships
    // entirely made a `write` token of an ORG_ADMIN useless (403 on findings the same user reads in the UI).
    const pat = currentRequestContext()?.personalToken;
    const restricted = !!pat && pat.userId === userId && pat.scope !== 'sudo';
    const downgrade = pat?.scope === 'read' ? 'AUDITOR' : 'PRODUCT_SECURITY_ENGINEER';
    const effective = restricted ? rows.map((r) => (r.role === 'ORG_ADMIN' || r.role === 'SECURITY_ADMIN' ? { ...r, role: downgrade as typeof r.role } : r)) : rows;
    // A cell administrator without memberships: a non-sudo token still sees every organization of the cell, downgraded the same way.
    if (restricted && user?.platformRole === 'admin' && !effective.length) {
      const orgs = await this.db.select({ id: organizations.id }).from(organizations);
      effective.push(...orgs.map((o) => ({ id: `admin:${o.id}`, userId, role: downgrade, scopeType: 'ORGANIZATION', scopeId: o.id } as unknown as typeof rows[number])));
    }
    const ctx = new AccessContext(userId, effective, !restricted && user?.platformRole === 'admin');
    await this.hydrateVisibility(ctx, effective);
    return ctx;
  }

  /** Per-request cache so guards and services share one context. */
  async forRequest(req: { accessContext?: AccessContext }, userId: string): Promise<AccessContext> {
    if (req.accessContext?.userId === userId) return req.accessContext;
    const ctx = await this.forUser(userId);
    req.accessContext = ctx;
    return ctx;
  }

  private async hydrateVisibility(ctx: AccessContext, rows: Membership[]): Promise<void> {
    const byType = (type: Membership['scopeType']) => rows.filter((r) => r.scopeType === type).map((r) => r.scopeId);

    for (const id of byType('ORGANIZATION')) ctx.visibleOrganizationIds.add(id);

    const workspaceIds = byType('WORKSPACE');
    if (workspaceIds.length) {
      const found = await this.db
        .select({ id: workspaces.id, organizationId: workspaces.organizationId })
        .from(workspaces)
        .where(inArray(workspaces.id, workspaceIds));
      for (const w of found) {
        ctx.visibleWorkspaceIds.add(w.id);
        ctx.visibleOrganizationIds.add(w.organizationId);
      }
    }

    const teamIds = byType('TEAM');
    if (teamIds.length) {
      const found = await this.db
        .select({ id: teams.id, workspaceId: teams.workspaceId, organizationId: workspaces.organizationId })
        .from(teams)
        .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
        .where(inArray(teams.id, teamIds));
      for (const t of found) {
        ctx.visibleTeamIds.add(t.id);
        ctx.visibleWorkspaceIds.add(t.workspaceId);
        ctx.visibleOrganizationIds.add(t.organizationId);
      }
    }

    const projectIds = byType('PROJECT');
    if (projectIds.length) {
      const found = await this.db
        .select({
          id: projects.id,
          teamId: projects.teamId,
          workspaceId: teams.workspaceId,
          organizationId: workspaces.organizationId,
        })
        .from(projects)
        .innerJoin(teams, eq(projects.teamId, teams.id))
        .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
        .where(inArray(projects.id, projectIds));
      for (const p of found) {
        ctx.visibleProjectIds.add(p.id);
        ctx.visibleTeamIds.add(p.teamId);
        ctx.visibleWorkspaceIds.add(p.workspaceId);
        ctx.visibleOrganizationIds.add(p.organizationId);
      }
    }

    const serviceIds = byType('SERVICE');
    const environmentIds = byType('ENVIRONMENT');
    if (serviceIds.length || environmentIds.length) {
      if (environmentIds.length) {
        const found = await this.db
          .select({ id: environments.id, serviceId: environments.serviceId })
          .from(environments)
          .where(inArray(environments.id, environmentIds));
        for (const e of found) {
          ctx.visibleEnvironmentIds.add(e.id);
          serviceIds.push(e.serviceId);
        }
      }
      if (serviceIds.length) {
        const found = await this.db
          .select({
            id: services.id,
            projectId: services.projectId,
            teamId: projects.teamId,
            workspaceId: teams.workspaceId,
            organizationId: workspaces.organizationId,
          })
          .from(services)
          .innerJoin(projects, eq(services.projectId, projects.id))
          .innerJoin(teams, eq(projects.teamId, teams.id))
          .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
          .where(inArray(services.id, [...new Set(serviceIds)]));
        for (const s of found) {
          ctx.visibleServiceIds.add(s.id);
          ctx.visibleProjectIds.add(s.projectId);
          ctx.visibleTeamIds.add(s.teamId);
          ctx.visibleWorkspaceIds.add(s.workspaceId);
          ctx.visibleOrganizationIds.add(s.organizationId);
        }
      }
    }
  }
}
