import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { Project, projects, teams, workspaces } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { buildChain, ScopeChain } from '../rbac/scope.types';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthenticatedUser, teamChain: ScopeChain): Promise<Project[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.teamId, teamChain.teamId!), isNull(projects.archivedAt)))
      .orderBy(asc(projects.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'project:read', teamChain)) return rows;
    return rows.filter((p) => ctx.visibleProjectIds.has(p.id));
  }

  /** Every project in the organization the user may see, with team and workspace, in one query. */
  async listForOrganization(user: AuthenticatedUser, orgChain: ScopeChain) {
    const rows = await this.db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        description: projects.description,
        criticality: projects.criticality,
        settings: projects.settings,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
        teamId: teams.id,
        teamSlug: teams.slug,
        teamName: teams.name,
        workspaceId: workspaces.id,
        workspaceSlug: workspaces.slug,
        workspaceName: workspaces.name,
      })
      .from(projects)
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.organizationId, orgChain.organizationId),
          isNull(projects.archivedAt),
          isNull(teams.archivedAt),
          isNull(workspaces.archivedAt),
        ),
      )
      .orderBy(asc(workspaces.name), asc(teams.name), asc(projects.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'project:read', orgChain)) return rows;
    return rows.filter((p) =>
      this.authz.can(
        ctx,
        'project:read',
        buildChain(
          { organizationId: orgChain.organizationId, workspaceId: p.workspaceId, teamId: p.teamId, projectId: p.id },
          orgChain.organizationAncestorIds,
        ),
      ),
    );
  }

  async create(user: AuthenticatedUser, teamChain: ScopeChain, dto: CreateProjectDto): Promise<Project> {
    const [project] = await this.db
      .insert(projects)
      .values({
        teamId: teamChain.teamId!,
        slug: dto.slug,
        name: dto.name,
        description: dto.description,
        criticality: dto.criticality ?? 'MEDIUM',
      })
      .returning();
    await this.audit.record({
      organizationId: teamChain.organizationId,
      actor: userActor(user),
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      after: project,
    });
    return project;
  }

  async get(chain: ScopeChain): Promise<Project> {
    const [project] = await this.db.select().from(projects).where(eq(projects.id, chain.projectId!)).limit(1);
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  async update(user: AuthenticatedUser, chain: ScopeChain, dto: UpdateProjectDto): Promise<Project> {
    const before = await this.get(chain);
    const [after] = await this.db
      .update(projects)
      .set({
        name: dto.name ?? before.name,
        description: dto.description ?? before.description,
        criticality: dto.criticality ?? before.criticality,
        settings: dto.automation ? { ...before.settings, automation: { ...((before.settings.automation as Record<string, unknown>) ?? {}), ...dto.automation } } : before.settings,
      })
      .where(eq(projects.id, before.id))
      .returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'project.updated',
      resourceType: 'project',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }

  async archive(user: AuthenticatedUser, chain: ScopeChain): Promise<Project> {
    const before = await this.get(chain);
    const [after] = await this.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, before.id)).returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'project.archived',
      resourceType: 'project',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }
}
