import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AppConfig } from '../config/env';
import { criticalityEnum, environmentKindEnum, platformRoleEnum, roleEnum, scopeTypeEnum, serviceKindEnum } from '../database/schema';
import { featureStates, FEATURES } from '../features/features';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../rbac/permissions';
import { ROLE_CATALOG } from '../rbac/role-catalog';

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
      /** Roles in display order with label, one-line description, closest GitLab role and the scopes they are offered at. */
      roleCatalog: ROLE_CATALOG,
      /** Capabilities and whether they are on (M13 licensing maps these to tiers). */
      features: featureStates(),
      featureCatalog: FEATURES,
      rolePermissions: Object.fromEntries(
        Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role, [...permissions]]),
      ),
    };
  }
}
