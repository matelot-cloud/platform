import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { environments, organizations, projects, services, teams, workspaces } from '../database/schema';
import { buildChain, ResolvedIds, ScopeChain, ScopeParams } from './scope.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ORG_DEPTH = 16;

/** Turns route parameters into a full ScopeChain, verifying that nested ids belong together. */
@Injectable()
export class ScopeResolverService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async resolveChain(params: ScopeParams): Promise<ScopeChain> {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && !UUID_RE.test(value)) throw new NotFoundException(`${key} not found`);
    }

    let ids: ResolvedIds;
    if (params.environmentId) ids = await this.fromEnvironment(params.environmentId);
    else if (params.serviceId) ids = await this.fromService(params.serviceId);
    else if (params.projectId) ids = await this.fromProject(params.projectId);
    else if (params.teamId) ids = await this.fromTeam(params.teamId);
    else if (params.workspaceId) ids = await this.fromWorkspace(params.workspaceId);
    else if (params.organizationId) ids = await this.fromOrganization(params.organizationId);
    else throw new BadRequestException('Request does not identify a scope');

    this.assertConsistent(params, ids);
    const ancestors = await this.organizationAncestors(ids.organizationId);
    return buildChain(ids, ancestors);
  }

  async organizationAncestors(organizationId: string): Promise<string[]> {
    const ancestors: string[] = [];
    let current = organizationId;
    for (let depth = 0; depth < MAX_ORG_DEPTH; depth++) {
      const [row] = await this.db
        .select({ parentId: organizations.parentId })
        .from(organizations)
        .where(eq(organizations.id, current))
        .limit(1);
      if (!row?.parentId || ancestors.includes(row.parentId)) break;
      ancestors.push(row.parentId);
      current = row.parentId;
    }
    return ancestors;
  }

  private async fromEnvironment(environmentId: string): Promise<ResolvedIds> {
    const [row] = await this.db
      .select({
        environmentId: environments.id,
        serviceId: services.id,
        projectId: projects.id,
        teamId: teams.id,
        workspaceId: workspaces.id,
        organizationId: workspaces.organizationId,
      })
      .from(environments)
      .innerJoin(services, eq(environments.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(eq(environments.id, environmentId))
      .limit(1);
    if (!row) throw new NotFoundException('Environment not found');
    return row;
  }

  private async fromService(serviceId: string): Promise<ResolvedIds> {
    const [row] = await this.db
      .select({
        serviceId: services.id,
        projectId: projects.id,
        teamId: teams.id,
        workspaceId: workspaces.id,
        organizationId: workspaces.organizationId,
      })
      .from(services)
      .innerJoin(projects, eq(services.projectId, projects.id))
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(eq(services.id, serviceId))
      .limit(1);
    if (!row) throw new NotFoundException('Service not found');
    return row;
  }

  private async fromProject(projectId: string): Promise<ResolvedIds> {
    const [row] = await this.db
      .select({
        projectId: projects.id,
        teamId: teams.id,
        workspaceId: workspaces.id,
        organizationId: workspaces.organizationId,
      })
      .from(projects)
      .innerJoin(teams, eq(projects.teamId, teams.id))
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) throw new NotFoundException('Project not found');
    return row;
  }

  private async fromTeam(teamId: string): Promise<ResolvedIds> {
    const [row] = await this.db
      .select({ teamId: teams.id, workspaceId: workspaces.id, organizationId: workspaces.organizationId })
      .from(teams)
      .innerJoin(workspaces, eq(teams.workspaceId, workspaces.id))
      .where(eq(teams.id, teamId))
      .limit(1);
    if (!row) throw new NotFoundException('Team not found');
    return row;
  }

  private async fromWorkspace(workspaceId: string): Promise<ResolvedIds> {
    const [row] = await this.db
      .select({ workspaceId: workspaces.id, organizationId: workspaces.organizationId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!row) throw new NotFoundException('Workspace not found');
    return row;
  }

  private async fromOrganization(organizationId: string): Promise<ResolvedIds> {
    const [row] = await this.db
      .select({ organizationId: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!row) throw new NotFoundException('Organization not found');
    return row;
  }

  /** /workspaces/A/teams/B must fail if team B is not in workspace A: no cross-scope leakage via URLs. */
  private assertConsistent(params: ScopeParams, ids: ResolvedIds): void {
    const mismatch =
      (params.organizationId && params.organizationId !== ids.organizationId) ||
      (params.workspaceId && params.workspaceId !== ids.workspaceId) ||
      (params.teamId && params.teamId !== ids.teamId) ||
      (params.projectId && params.projectId !== ids.projectId) ||
      (params.serviceId && params.serviceId !== ids.serviceId) ||
      (params.environmentId && params.environmentId !== ids.environmentId);
    if (mismatch) throw new NotFoundException('Resource not found in the requested scope');
  }
}
