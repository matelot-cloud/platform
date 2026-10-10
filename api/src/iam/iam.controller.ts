import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AccessService } from '../rbac/access.service';
import { GrantMembershipDto, ListMembershipsQuery } from './dto/grant-membership.dto';
import { MembershipsService } from './memberships.service';
import { UsersService } from './users.service';

@ApiTags('iam')
@ApiBearerAuth()
@Controller()
export class IamController {
  constructor(
    private readonly users: UsersService,
    private readonly memberships: MembershipsService,
    private readonly access: AccessService,
  ) {}

  /** Who am I, and what can I see? */
  @Get('me')
  async me(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.users.findById(current.id);
    if (!user) throw new NotFoundException('User not found');
    const ctx = await this.access.forUser(user.id);
    const scopes = await this.memberships.describeScopes(ctx.memberships);
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, lastLoginAt: user.lastLoginAt, platformRole: user.platformRole },
      memberships: ctx.memberships.map((m) => ({
        id: m.id,
        role: m.role,
        scopeType: m.scopeType,
        scopeId: m.scopeId,
        scope: scopes.get(`${m.scopeType}:${m.scopeId}`) ?? null,
      })),
    };
  }

  @Get('memberships')
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListMembershipsQuery) {
    return this.memberships.listForScope(user, query.scopeType, query.scopeId);
  }

  @Post('memberships')
  grant(@CurrentUser() user: AuthenticatedUser, @Body() dto: GrantMembershipDto) {
    return this.memberships.grant(user, dto);
  }

  @Delete('memberships/:membershipId')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param('membershipId', ParseUUIDPipe) membershipId: string) {
    await this.memberships.revoke(user, membershipId);
  }
}
