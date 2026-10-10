import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth()
@Controller()
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('organizations/:organizationId/projects')
  @RequirePermission('organization:read')
  listForOrganization(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.projects.listForOrganization(user, chain);
  }

  @Get('teams/:teamId/projects')
  @RequirePermission('team:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.projects.list(user, chain);
  }

  @Post('teams/:teamId/projects')
  @RequirePermission('project:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, chain, dto);
  }

  @Get('projects/:projectId')
  @RequirePermission('project:read')
  get(@Scope() chain: ScopeChain) {
    return this.projects.get(chain);
  }

  @Patch('projects/:projectId')
  @RequirePermission('project:write')
  update(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UpdateProjectDto) {
    return this.projects.update(user, chain, dto);
  }

  @Delete('projects/:projectId')
  @RequirePermission('project:write')
  archive(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.projects.archive(user, chain);
  }
}
