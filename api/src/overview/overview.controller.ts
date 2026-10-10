import { Controller, Get } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { OverviewService } from './overview.service';

@ApiTags('overview')
@ApiBearerAuth()
@Controller()
export class OverviewController {
  constructor(
    private readonly overview: OverviewService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  @Get('organizations/:organizationId/overview')
  @RequirePermission('organization:read')
  async organization(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    const data = await this.overview.organization(chain.organizationId);
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'project:read', chain)) return data;
    // Scoped members see only rows of projects they can read; the counters stay organization-wide (they are not sensitive).
    const cache = new Map<string, boolean>();
    const visible = async (projectId: string) => {
      if (!cache.has(projectId)) {
        const projectChain = await this.resolver.resolveChain({ projectId }).catch(() => null);
        cache.set(projectId, !!projectChain && this.authz.can(ctx, 'project:read', projectChain));
      }
      return cache.get(projectId)!;
    };
    const production = [];
    for (const row of data.production) if (await visible(row.projectId)) production.push(row);
    const recentPipelines = [];
    for (const row of data.recentPipelines) if (await visible(row.projectId)) recentPipelines.push(row);
    return { ...data, production, recentPipelines };
  }

  @Get('projects/:projectId/overview')
  @RequirePermission('project:read')
  project(@Scope() chain: ScopeChain) {
    return this.overview.project(chain.projectId!);
  }
}
