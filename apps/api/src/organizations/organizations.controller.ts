import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto/organization.dto';
import { OrganizationsService } from './organizations.service';

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listVisible(user);
  }

  /** Root organizations are created by cell bootstrap; this creates subsidiaries / customer orgs. */
  @Post()
  createChild(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrganizationDto) {
    return this.organizations.createChild(user, dto);
  }

  @Get(':organizationId')
  @RequirePermission('organization:read')
  get(@Scope() chain: ScopeChain) {
    return this.organizations.get(chain);
  }

  @Patch(':organizationId')
  @RequirePermission('organization:write')
  update(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(user, chain, dto);
  }
}
