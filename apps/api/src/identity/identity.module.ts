import { Controller, Get, Global, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { IdentityService } from './identity.service';

/** OIDC discovery at the origin root (outside api/v1) — what the clouds fetch to verify the cell's tokens. */
@ApiExcludeController()
@Controller('.well-known')
export class IdentityWellKnownController {
  constructor(private readonly identity: IdentityService) {}
  @Public() @Get('openid-configuration') config() { return this.identity.openidConfiguration(); }
  @Public() @Get('jwks.json') jwks() { return this.identity.jwks(); }
}

@Global()
@Module({ controllers: [IdentityWellKnownController], providers: [IdentityService], exports: [IdentityService] })
export class IdentityModule {}
