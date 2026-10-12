import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { currentRequestContext } from '../../common/request-context';
import { PersonalTokensService, TOKEN_PREFIX } from './personal-tokens.service';

/**
 * The HTTP-method half of the token-scope semantics (the permission half is `scopeAllows` in rbac/permissions.ts):
 * `read` = safe methods only; `write` = everything except DELETE — every DELETE route archives or removes something
 * (workspaces, projects, teams, policies, integrations, memberships, tokens, runner pools), and destructive operations
 * need `sudo`. The MCP transport is exempt: it is POST for every message and DELETE to close a session; the MCP layer
 * enforces read-only per tool. Returns the refusal message, or null when the request may proceed.
 */
export function methodRefusedForScope(scope: string, method: string, isMcp: boolean): string | null {
  if (isMcp) return null;
  const m = method.toUpperCase();
  if (scope === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(m)) return 'This personal token is read-only';
  if (scope === 'write' && m === 'DELETE') return 'Deleting or archiving needs a sudo token (this token has the write scope)';
  return null;
}

/**
 * Authenticates `Authorization: Bearer spt_…`. Runs after the CI-token guard and before the JWT guard
 * (which skips requests already authenticated). Read-scoped tokens may only use safe methods.
 */
@Injectable()
export class PersonalTokenGuard implements CanActivate {
  constructor(private readonly tokens: PersonalTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; method: string; ip?: string; user?: unknown; apiTokenAuthenticated?: boolean; path?: string; url?: string; personalTokenScope?: string }>();
    if (request.apiTokenAuthenticated) return true;
    const header = request.headers.authorization;
    if (!header?.startsWith(`Bearer ${TOKEN_PREFIX}`)) return true; // not a personal token: the JWT guard decides
    const found = await this.tokens.authenticate(header.slice(7).trim(), request.ip);
    if (!found) throw new UnauthorizedException('Invalid, expired or revoked personal access token');
    // The MCP transport is POST for every message; the MCP layer enforces read-only per tool (GET tools only).
    const isMcp = /\/mcp\/?$/.test(String(request.path ?? request.url ?? ''));
    const refused = methodRefusedForScope(found.scope, request.method, isMcp);
    if (refused) throw new ForbiddenException(refused);
    request.personalTokenScope = found.scope;
    request.user = found.user;
    request.apiTokenAuthenticated = true; // lets the JWT guard through
    const ctx = currentRequestContext();
    if (ctx) ctx.personalToken = { id: found.tokenId, userId: found.user.id, scope: found.scope };
    return true;
  }
}
