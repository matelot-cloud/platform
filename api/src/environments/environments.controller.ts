import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateEnvironmentDto, UpdateEnvironmentDto } from './dto/environment.dto';
import { EnvironmentsService } from './environments.service';

@ApiTags('environments')
@ApiBearerAuth()
@Controller()
export class EnvironmentsController {
  constructor(private readonly environments: EnvironmentsService) {}

  @Get('services/:serviceId/environments')
  @RequirePermission('service:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.environments.list(user, chain);
  }

  @Post('services/:serviceId/environments')
  @RequirePermission('environment:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateEnvironmentDto) {
    return this.environments.create(user, chain, dto);
  }

  @Get('environments/:environmentId')
  @RequirePermission('environment:read')
  get(@Scope() chain: ScopeChain) {
    return this.environments.get(chain);
  }

  @Patch('environments/:environmentId')
  @RequirePermission('environment:write')
  update(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UpdateEnvironmentDto) {
    return this.environments.update(user, chain, dto);
  }

  @Delete('environments/:environmentId')
  @RequirePermission('environment:write')
  archive(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.environments.archive(user, chain);
  }
}
