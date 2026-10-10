import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppConfig } from '../config/env';
import { criticalityEnum, environmentKindEnum, platformRoleEnum, roleEnum, scopeTypeEnum, serviceKindEnum } from '../database/schema';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../rbac/permissions';

/** Static vocabulary the frontend needs (roles, scopes, criticalities) plus cell identity. */
@ApiTags('meta')
@ApiBearerAuth()
@Controller('meta')
export class MetaController {
  constructor(@Inject(ConfigService) private readonly config: AppConfig) {}

  @Get()
  meta() {
    return {
      version: process.env.APP_VERSION ?? '0.1.0',
      rootOrganizationSlug: this.config.get('BOOTSTRAP_ORG_SLUG', { infer: true }) ?? null,
      roles: roleEnum.enumValues,
      platformRoles: platformRoleEnum.enumValues,
      scopeTypes: scopeTypeEnum.enumValues,
      criticalities: criticalityEnum.enumValues,
      serviceKinds: serviceKindEnum.enumValues,
      environmentKinds: environmentKindEnum.enumValues,
      permissions: PERMISSIONS,
      rolePermissions: Object.fromEntries(
        Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role, [...permissions]]),
      ),
    };
  }
}
