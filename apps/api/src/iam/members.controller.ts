import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AddMembersDto, CandidatesQuery, CreateServiceAccountDto, ReasonQuery, ScopeAccessTokenDto, ScopeQuery, ServiceAccountTokenDto, ToggleDto, UpdateMemberDto } from './dto/members.dto';
import { MembersService } from './members.service';
import { ServiceAccountsService } from './service-accounts.service';

@ApiTags('members')
@ApiBearerAuth()
@Controller()
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly serviceAccounts: ServiceAccountsService,
  ) {}

  /** Members of a scope: direct rows and the ones inherited from above (where they come from), GitLab-style. */
  @Get('members')
  list(@CurrentUser() user: AuthenticatedUser, @Query() q: ScopeQuery) {
    return this.members.list(user, q.scopeType, q.scopeId);
  }

  /** Roles offered at this scope, in order, with descriptions, their GitLab equivalent and whether you may grant each. */
  @Get('members/roles')
  roles(@CurrentUser() user: AuthenticatedUser, @Query() q: ScopeQuery) {
    return this.members.roles(user, q.scopeType, q.scopeId);
  }

  /** Search people (and this scope's service accounts) to add; excludes current direct members. */
  @Get('members/candidates')
  candidates(@CurrentUser() user: AuthenticatedUser, @Query() q: CandidatesQuery) {
    return this.members.candidates(user, q.scopeType, q.scopeId, q.q ?? '');
  }

  /** Add (or invite) one or more people with a role and an optional expiry. */
  @Post('members')
  add(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddMembersDto) {
    return this.members.add(user, dto);
  }

  @Patch('members/:membershipId')
  update(@CurrentUser() user: AuthenticatedUser, @Param('membershipId', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.members.update(user, id, dto);
  }

  @Delete('members/:membershipId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('membershipId', ParseUUIDPipe) id: string, @Query() q: ReasonQuery) {
    await this.members.remove(user, id, q.reason);
  }

  // ---- service accounts -------------------------------------------------------------------------
  @Get('service-accounts')
  listServiceAccounts(@CurrentUser() user: AuthenticatedUser, @Query() q: ScopeQuery) {
    return this.serviceAccounts.list(user, q.scopeType, q.scopeId);
  }

  @Post('service-accounts')
  createServiceAccount(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateServiceAccountDto) {
    return this.serviceAccounts.create(user, dto);
  }

  @Patch('service-accounts/:id')
  toggleServiceAccount(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ToggleDto) {
    return this.serviceAccounts.setDisabled(user, id, dto.disabled);
  }

  @Delete('service-accounts/:id')
  @HttpCode(200)
  deleteServiceAccount(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.serviceAccounts.remove(user, id);
  }

  @Get('service-accounts/:id/tokens')
  tokens(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.serviceAccounts.listTokens(user, id);
  }

  @Post('service-accounts/:id/tokens')
  createToken(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceAccountTokenDto) {
    return this.serviceAccounts.createToken(user, id, dto);
  }

  @Post('service-accounts/:id/tokens/:tokenId/rotate')
  rotateToken(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('tokenId', ParseUUIDPipe) tokenId: string) {
    return this.serviceAccounts.rotateToken(user, id, tokenId);
  }

  @Delete('service-accounts/:id/tokens/:tokenId')
  @HttpCode(200)
  revokeToken(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Param('tokenId', ParseUUIDPipe) tokenId: string) {
    return this.serviceAccounts.revokeToken(user, id, tokenId);
  }

  /** GitLab "project access token": a bot member with a role plus its token, in one step. */
  @Post('scope-access-tokens')
  scopeAccessToken(@CurrentUser() user: AuthenticatedUser, @Body() dto: ScopeAccessTokenDto) {
    return this.serviceAccounts.createScopeAccessToken(user, dto);
  }
}
