import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Team, teams, workspaces } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { buildChain, ScopeChain } from '../rbac/scope.types';
import { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';

@Injectable()
export class TeamsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthenticatedUser, wsChain: ScopeChain): Promise<Team[]> {
    const rows = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.workspaceId, wsChain.workspaceId!), isNull(teams.archivedAt)))
      .orderBy(asc(teams.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'team:read', wsChain)) return rows;
    return rows.filter((t) => ctx.visibleTeamIds.has(t.id));
  }

  /** Every team in the organization the user may see, with its workspace, in one query. */
  async listForOrganization(user: AuthenticatedUser, orgChain: ScopeChain) {
    const rows = await this.db
      .select({
        id: teams.id,
        slug: teams.slug,
        name: teams.name,
        description: teams.description,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        workspaceId: workspaces.id,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.name,
      })
      .from(teams)
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(and(eq(workspaces.organizationId, orgChain.organizationId), isNull(teams.archivedAt), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.name), asc(teams.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'team:read', orgChain)) return rows;
    return rows.filter((t) =>
      this.authz.can(
        ctx,
        'team:read',
        buildChain(
          { organizationId: orgChain.organizationId, workspaceId: t.workspaceId, teamId: t.id },
          orgChain.organizationAncestorIds,
        ),
      ),
    );
  }

  async create(user: AuthenticatedUser, wsChain: ScopeChain, dto: CreateTeamDto): Promise<Team> {
    const [team] = await this.db
      .insert(teams)
      .values({ workspaceId: wsChain.workspaceId!, slug: dto.slug, name: dto.name, description: dto.description })
      .returning();
    await this.audit.record({
      organizationId: wsChain.organizationId,
      actor: userActor(user),
      action: 'team.created',
      resourceType: 'team',
      resourceId: team.id,
      after: team,
    });
    return team;
  }

  async get(chain: ScopeChain): Promise<Team> {
    const [team] = await this.db.select().from(teams).where(eq(teams.id, chain.teamId!)).limit(1);
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  async update(user: AuthenticatedUser, chain: ScopeChain, dto: UpdateTeamDto): Promise<Team> {
    const before = await this.get(chain);
    const [after] = await this.db
      .update(teams)
      .set({ name: dto.name ?? before.name, description: dto.description ?? before.description })
      .where(eq(teams.id, before.id))
      .returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'team.updated',
      resourceType: 'team',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }

  async archive(user: AuthenticatedUser, chain: ScopeChain): Promise<Team> {
    const before = await this.get(chain);
    const [after] = await this.db.update(teams).set({ archivedAt: new Date() }).where(eq(teams.id, before.id)).returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'team.archived',
      resourceType: 'team',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }
}
