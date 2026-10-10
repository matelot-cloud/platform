import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeChain } from '../rbac/scope.types';
import { CI_TOKEN_PERMISSIONS, CI_TOKEN_PRESETS, CreateTokenDto } from './dto/tokens.dto';
import { TokensService } from './tokens.service';

@ApiTags('api-tokens')
@ApiBearerAuth()
@Controller()
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get('api-tokens/presets')
  presets() {
    return { presets: CI_TOKEN_PRESETS, permissions: CI_TOKEN_PERMISSIONS };
  }

  @Get('organizations/:organizationId/api-tokens')
  @RequirePermission('organization:read')
  list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.tokens.list(user, chain);
  }

  @Post('organizations/:organizationId/api-tokens')
  @RequirePermission('organization:read')
  create(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateTokenDto) {
    return this.tokens.create(user, chain, dto);
  }

  @Delete('api-tokens/:tokenId')
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('tokenId', ParseUUIDPipe) tokenId: string) {
    return this.tokens.revoke(user, tokenId);
  }

  /** Lets a pipeline verify its credentials: who am I, what may I do. */
  @Get('api-tokens/whoami')
  whoami(@CurrentUser() user: AuthenticatedUser) {
    return user.token ? { kind: 'token', name: user.token.name, scope: { type: user.token.scopeType, id: user.token.scopeId }, permissions: user.token.permissions } : { kind: 'user', email: user.email };
  }
}
