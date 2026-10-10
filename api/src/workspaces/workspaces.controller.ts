import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateWorkspaceDto, UpdateWorkspaceDto } from './dto/workspace.dto';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller()
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('organizations/:organizationId/workspaces')
  @RequirePermission('organization:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.workspaces.list(user, chain);
  }

  @Post('organizations/:organizationId/workspaces')
  @RequirePermission('workspace:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(user, chain, dto);
  }

  @Get('workspaces/:workspaceId')
  @RequirePermission('workspace:read')
  get(@Scope() chain: ScopeChain) {
    return this.workspaces.get(chain);
  }

  @Patch('workspaces/:workspaceId')
  @RequirePermission('workspace:write')
  update(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UpdateWorkspaceDto) {
    return this.workspaces.update(user, chain, dto);
  }

  @Delete('workspaces/:workspaceId')
  @RequirePermission('workspace:write')
  archive(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.workspaces.archive(user, chain);
  }
}
