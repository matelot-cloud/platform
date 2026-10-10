import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { projects, Service, services, teams, workspaces } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { buildChain, ScopeChain } from '../rbac/scope.types';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';

@Injectable()
export class ServicesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthenticatedUser, projectChain: ScopeChain): Promise<Service[]> {
    const rows = await this.db
      .select()
      .from(services)
      .where(and(eq(services.projectId, projectChain.projectId!), isNull(services.archivedAt)))
      .orderBy(asc(services.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'service:read', projectChain)) return rows;
    return rows.filter((s) => ctx.visibleServiceIds.has(s.id));
  }

  /** Every service in the organization the user may see, with its project/team/workspace. */
  async listForOrganization(user: AuthenticatedUser, orgChain: ScopeChain) {
    const rows = await this.db
      .select({
        id: services.id,
        slug: services.slug,
        name: services.name,
        kind: services.kind,
        criticality: services.criticality,
        updatedAt: services.updatedAt,
        projectId: projects.id,
        projectSlug: projects.slug,
        projectName: projects.name,
        projectCriticality: projects.criticality,
        teamId: teams.id,
        teamName: teams.name,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(services)
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(and(eq(workspaces.organizationId, orgChain.organizationId), isNull(services.archivedAt), isNull(projects.archivedAt)))
      .orderBy(asc(workspaces.name), asc(teams.name), asc(projects.name), asc(services.name));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'service:read', orgChain)) return rows;
    return rows.filter((s) =>
      this.authz.can(
        ctx,
        'service:read',
        buildChain(
          { organizationId: orgChain.organizationId, workspaceId: s.workspaceId, teamId: s.teamId, projectId: s.projectId, serviceId: s.id },
          orgChain.organizationAncestorIds,
        ),
      ),
    );
  }

  async create(user: AuthenticatedUser, projectChain: ScopeChain, dto: CreateServiceDto): Promise<Service> {
    const [service] = await this.db
      .insert(services)
      .values({
        projectId: projectChain.projectId!,
        slug: dto.slug,
        name: dto.name,
        description: dto.description,
        kind: dto.kind ?? 'other',
        criticality: dto.criticality ?? null,
      })
      .returning();
    await this.audit.record({
      organizationId: projectChain.organizationId,
      actor: userActor(user),
      action: 'service.created',
      resourceType: 'service',
      resourceId: service.id,
      after: service,
    });
    return service;
  }

  async get(chain: ScopeChain): Promise<Service & { organizationId: string; workspaceId: string | null; teamId: string | null }> {
    const [service] = await this.db.select().from(services).where(eq(services.id, chain.serviceId!)).limit(1);
    if (!service) throw new NotFoundException('Service not found');
    // The chain is what CLIs and the MCP need next (recorrelate --org, scoped routes): expose it with the row.
    return { ...service, organizationId: chain.organizationId, workspaceId: chain.workspaceId ?? null, teamId: chain.teamId ?? null };
  }

  async update(user: AuthenticatedUser, chain: ScopeChain, dto: UpdateServiceDto): Promise<Service> {
    const before = await this.get(chain);
    const [after] = await this.db
      .update(services)
      .set({
        name: dto.name ?? before.name,
        description: dto.description ?? before.description,
        kind: dto.kind ?? before.kind,
        criticality: dto.criticality === undefined ? before.criticality : dto.criticality,
      })
      .where(eq(services.id, before.id))
      .returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'service.updated',
      resourceType: 'service',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }

  async archive(user: AuthenticatedUser, chain: ScopeChain): Promise<Service> {
    const before = await this.get(chain);
    const [after] = await this.db.update(services).set({ archivedAt: new Date() }).where(eq(services.id, before.id)).returning();
    await this.audit.record({
      organizationId: chain.organizationId,
      actor: userActor(user),
      action: 'service.archived',
      resourceType: 'service',
      resourceId: after.id,
      before,
      after,
    });
    return after;
  }
}
