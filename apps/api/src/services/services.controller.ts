import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateServiceDto, UpdateServiceDto } from './dto/service.dto';
import { ServicesService } from './services.service';

@ApiTags('services')
@ApiBearerAuth()
@Controller()
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get('organizations/:organizationId/services')
  @RequirePermission('organization:read')
  listForOrganization(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.services.listForOrganization(user, chain);
  }

  @Get('projects/:projectId/services')
  @RequirePermission('project:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.services.list(user, chain);
  }

  @Post('projects/:projectId/services')
  @RequirePermission('service:write')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateServiceDto) {
    return this.services.create(user, chain, dto);
  }

  @Get('services/:serviceId')
  @RequirePermission('service:read')
  get(@Scope() chain: ScopeChain) {
    return this.services.get(chain);
  }

  /** The service with its latest pipeline, open finding counts and newest SBOM — one call instead of four. */
  @Get('services/:serviceId/summary')
  @RequirePermission('vulnerability:read')
  summary(@Scope() chain: ScopeChain) {
    return this.services.summary(chain);
  }

  @Patch('services/:serviceId')
  @RequirePermission('service:write')
  update(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UpdateServiceDto) {
    return this.services.update(user, chain, dto);
  }

  @Delete('services/:serviceId')
  @RequirePermission('service:write')
  archive(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.services.archive(user, chain);
  }
}
