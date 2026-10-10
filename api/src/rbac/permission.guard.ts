import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AccessContext, AccessService } from './access.service';
import { AuthorizationService } from './authorization.service';
import type { Permission } from './permissions';
import { ScopeResolverService } from './scope-resolver.service';
import type { ScopeChain, ScopeParams } from './scope.types';

export const PERMISSION_KEY = 'secops:permission';

/**
 * Declares the permission a route needs. The scope is taken from the route parameters
 * (:organizationId / :workspaceId / :teamId / :projectId, most specific wins) and the
 * resolved chain is attached to the request for the handler (see @Scope()).
 */
export const RequirePermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);

export interface RequestWithContext extends Request {
  user?: AuthenticatedUser;
  scopeChain?: ScopeChain;
  accessContext?: AccessContext;
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: ScopeResolverService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!permission) return true;

    const req = context.switchToHttp().getRequest<RequestWithContext>();
    if (!req.user) throw new UnauthorizedException();

    const chain = await this.resolver.resolveChain(pickScopeParams(req.params));
    const ctx = await this.access.forRequest(req, req.user.id);
    this.authz.assert(ctx, permission, chain);

    req.scopeChain = chain;
    return true;
  }
}

function pickScopeParams(params: Record<string, string | string[] | undefined>): ScopeParams {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return {
    organizationId: first(params.organizationId),
    workspaceId: first(params.workspaceId),
    teamId: first(params.teamId),
    projectId: first(params.projectId),
    serviceId: first(params.serviceId),
    environmentId: first(params.environmentId),
  };
}
