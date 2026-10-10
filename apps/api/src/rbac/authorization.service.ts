import { ForbiddenException, Injectable } from '@nestjs/common';
import { AccessContext } from './access.service';
import { Permission, PERMISSIONS, ROLE_PERMISSIONS } from './permissions';
import { ScopeChain, structureReadPermission } from './scope.types';

/** Pure permission logic (no I/O) so it can be unit-tested exhaustively. */
@Injectable()
export class AuthorizationService {
  /** Union of the permissions granted by every membership on the chain (inheritance downwards). */
  permissionsFor(ctx: AccessContext, chain: ScopeChain): Set<Permission> {
    if (ctx.isPlatformAdmin) return new Set<Permission>(PERMISSIONS);
    const result = new Set<Permission>();
    if (ctx.tokenGrant && chain.refs.some((r) => r.type === ctx.tokenGrant!.scopeType && r.id === ctx.tokenGrant!.scopeId)) {
      for (const permission of ctx.tokenGrant.permissions) result.add(permission as Permission);
    }
    for (const ref of chain.refs) {
      for (const role of ctx.rolesAt(ref)) {
        for (const permission of ROLE_PERMISSIONS[role]) result.add(permission);
      }
    }
    return result;
  }

  hasPermission(ctx: AccessContext, permission: Permission, chain: ScopeChain): boolean {
    return this.permissionsFor(ctx, chain).has(permission);
  }

  /**
   * Structural visibility: a membership on a descendant lets the user *see* the ancestor
   * (a project developer can open their team/workspace/organization) without granting
   * anything else there.
   */
  isVisibleThroughDescendant(ctx: AccessContext, chain: ScopeChain): boolean {
    const { type, id } = chain.target;
    switch (type) {
      case 'ORGANIZATION':
        return ctx.visibleOrganizationIds.has(id);
      case 'WORKSPACE':
        return ctx.visibleWorkspaceIds.has(id);
      case 'TEAM':
        return ctx.visibleTeamIds.has(id);
      case 'PROJECT':
        return ctx.visibleProjectIds.has(id);
      case 'SERVICE':
        return ctx.visibleServiceIds.has(id);
      case 'ENVIRONMENT':
        return ctx.visibleEnvironmentIds.has(id);
    }
  }

  can(ctx: AccessContext, permission: Permission, chain: ScopeChain): boolean {
    if (this.hasPermission(ctx, permission, chain)) return true;
    if (permission === structureReadPermission(chain.target.type)) {
      return this.isVisibleThroughDescendant(ctx, chain);
    }
    return false;
  }

  assert(ctx: AccessContext, permission: Permission, chain: ScopeChain): void {
    if (!this.can(ctx, permission, chain)) {
      throw new ForbiddenException(`Missing permission ${permission} on ${chain.target.type.toLowerCase()}`);
    }
  }
}
