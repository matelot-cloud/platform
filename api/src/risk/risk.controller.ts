import { Inject, Query, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { projectIdsForChain } from '../rbac/scope-projects';
import { DATABASE, Database } from '../database/database.module';
import { ScopeChain } from '../rbac/scope.types';
import { GraphService } from './graph.service';
import { LineageService } from './lineage.service';
import { RiskService } from './risk.service';

@ApiTags('risk')
@ApiBearerAuth()
@Controller()
export class RiskController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly risk: RiskService,
    private readonly graph: GraphService,
    private readonly lineage: LineageService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** Services ranked by risk (visibility-filtered for scoped members). */
  @Get('organizations/:organizationId/risk')
  @RequirePermission('risk:read')
  async ranking(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    const rows = await this.risk.ranking(chain.organizationId);
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'risk:read', chain)) return rows;
    const visible = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (!visible.has(r.projectId)) {
        const pc = await this.resolver.resolveChain({ projectId: r.projectId }).catch(() => null);
        visible.set(r.projectId, !!pc && this.authz.can(ctx, 'risk:read', pc));
      }
      if (visible.get(r.projectId)) out.push(r);
    }
    return out;
  }

  @Get('projects/:projectId/risk')
  @RequirePermission('risk:read')
  projectRanking(@Scope() chain: ScopeChain) {
    return this.risk.ranking(chain.organizationId, chain.projectId!);
  }

  @Get('services/:serviceId/risk')
  @RequirePermission('risk:read')
  detail(@Scope() chain: ScopeChain) {
    return this.risk.detail(chain.serviceId!);
  }

  /** The project's Product Security Graph. */
  /** Environment lineage: released (version → registries) vs running (digest → registries), with drift. */
  @Get('environments/:environmentId/lineage')
  @RequirePermission('service:read')
  environmentLineage(@Scope() chain: ScopeChain) {
    return this.lineage.forEnvironment(chain.environmentId!);
  }

  @Get(['workspaces/:workspaceId/risk', 'teams/:teamId/risk'])
  @RequirePermission('service:read')
  async scopedRisk(@Scope() chain: ScopeChain, @Query('team') team?: string) {
    return this.risk.ranking(chain.organizationId, await projectIdsForChain(this.db, team ? ({ ...chain, teamId: team, projectId: undefined } as ScopeChain) : chain));
  }

  @Get('projects/:projectId/graph')
  @RequirePermission('risk:read')
  projectGraph(@Scope() chain: ScopeChain) {
    return this.graph.project(chain.projectId!);
  }

  /** Recompute now (org or project). */
  @Post('organizations/:organizationId/risk/recompute')
  @RequirePermission('risk:read')
  async recompute(@Scope() chain: ScopeChain) {
    return { services: await this.risk.computeAll(chain.organizationId) };
  }

  @Post('projects/:projectId/risk/recompute')
  @RequirePermission('risk:read')
  async recomputeProject(@Scope() chain: ScopeChain) {
    return { services: await this.risk.computeAll(chain.organizationId, chain.projectId!) };
  }
}
