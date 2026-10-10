import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateTeamDto, UpdateTeamDto } from './dto/team.dto';
import { TeamsService } from './teams.service';

@ApiTags('teams')
@ApiBearerAuth()
@Controller()
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get('organizations/:organizationId/teams')
  @RequirePermission('organization:read')
  listForOrganization(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.teams.listForOrganization(user, chain);
  }

  @Get('workspaces/:workspaceId/teams')
  @RequirePermission('workspace:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.teams.list(user, chain);
  }

  @Post('workspaces/:workspaceId/teams')
  @RequirePermission('team:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateTeamDto) {
    return this.teams.create(user, chain, dto);
  }

  @Get('teams/:teamId')
  @RequirePermission('team:read')
  get(@Scope() chain: ScopeChain) {
    return this.teams.get(chain);
  }

  @Patch('teams/:teamId')
  @RequirePermission('team:write')
  update(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UpdateTeamDto) {
    return this.teams.update(user, chain, dto);
  }

  @Delete('teams/:teamId')
  @RequirePermission('team:write')
  archive(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.teams.archive(user, chain);
  }
}
