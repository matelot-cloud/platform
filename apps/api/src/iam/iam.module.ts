import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { IamController } from './iam.controller';
import { MembershipsService } from './memberships.service';
import { UsersService } from './users.service';

@Module({
  controllers: [IamController],
  providers: [UsersService, MembershipsService, BootstrapService],
  exports: [UsersService, BootstrapService],
})
export class IamModule {}
