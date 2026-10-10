import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy, StrategyOptionsWithoutRequest } from 'passport-jwt';
import { AppConfig } from '../config/env';
import { BootstrapService } from '../iam/bootstrap.service';
import { UsersService } from '../iam/users.service';
import { AuthenticatedUser, KeycloakClaims } from './authenticated-user';

/**
 * Validates Keycloak-issued RS256 access tokens against the realm's JWKS and provisions
 * the platform user on first sight. Keycloak owns authentication (SSO, SAML, MFA);
 * the platform owns authorization (memberships + RBAC).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly users: UsersService;
  private readonly bootstrap: BootstrapService;

  constructor(@Inject(ConfigService) config: AppConfig, users: UsersService, bootstrap: BootstrapService) {
    super(JwtStrategy.options(config));
    this.users = users;
    this.bootstrap = bootstrap;
  }

  private static options(config: AppConfig): StrategyOptionsWithoutRequest {
    const issuer = config.get('KEYCLOAK_ISSUER', { infer: true });
    const jwksUri = config.get('KEYCLOAK_JWKS_URI', { infer: true }) ?? `${issuer}/protocol/openid-connect/certs`;
    return {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      issuer,
      audience: config.get('KEYCLOAK_AUDIENCE', { infer: true }),
      algorithms: ['RS256'],
      secretOrKeyProvider: passportJwtSecret({
        jwksUri,
        cache: true,
        cacheMaxAge: 10 * 60 * 1000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      }),
    };
  }

  async validate(claims: KeycloakClaims): Promise<AuthenticatedUser> {
    let user = await this.users.provisionFromClaims(claims);
    if (user.disabledAt) throw new UnauthorizedException('This account is disabled');
    user = await this.bootstrap.promoteBootstrapAdminIfEligible(user);
    return { id: user.id, email: user.email, displayName: user.displayName, externalId: claims.sub, platformRole: user.platformRole };
  }
}
