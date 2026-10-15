import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { IamController } from './iam.controller';
import { InvitesService } from './invites.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { InvitesController } from './invites.controller';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MembershipsService } from './memberships.service';
import { ScopeNamesService } from './scope-names.service';
import { ServiceAccountsService } from './service-accounts.service';
import { UserAdminService } from './user-admin.service';
import { UsersService } from './users.service';

@Module({
  controllers: [IamController, MembersController, InvitesController],
  providers: [UsersService, MembershipsService, BootstrapService, ScopeNamesService, KeycloakAdminService, InvitesService, MembersService, ServiceAccountsService, UserAdminService],
  exports: [UsersService, BootstrapService, UserAdminService, KeycloakAdminService],
})
export class IamModule {}
