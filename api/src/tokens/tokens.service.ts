import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CryptoService } from '../common/crypto.service';
import { DATABASE, Database } from '../database/database.module';
import { ApiToken, apiTokens, organizations, projects, ScopeType, teams, workspaces } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor } from '../rbac/scope.types';
import { CI_TOKEN_PRESETS, CreateTokenDto } from './dto/tokens.dto';

const publicView = (t: ApiToken) => {
  const { secretEncrypted: _s, ...rest } = t;
  return rest;
};

@Injectable()
export class TokensService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  private async describeScope(scopeType: ScopeType, scopeId: string) {
    const table = { ORGANIZATION: organizations, WORKSPACE: workspaces, TEAM: teams, PROJECT: projects, SERVICE: null, ENVIRONMENT: null }[scopeType];
    if (!table) return { type: scopeType, id: scopeId, name: scopeType.toLowerCase() };
    const [row] = await this.db.select({ name: table.name }).from(table).where(eq(table.id, scopeId)).limit(1);
    return { type: scopeType, id: scopeId, name: row?.name ?? scopeType.toLowerCase() };
  }

  /** Tokens of the organization the user may manage (membership:write at the token's level). */
  async list(user: AuthenticatedUser, orgChain: ScopeChain) {
    if (user.token) throw new BadRequestException('Tokens cannot manage tokens');
    const rows = await this.db.select().from(apiTokens).where(eq(apiTokens.organizationId, orgChain.organizationId)).orderBy(asc(apiTokens.createdAt));
    const ctx = await this.access.forUser(user.id);
    const out = [];
    for (const row of rows) {
      const chain = await this.resolver.resolveChain(scopeParamsFor(row.scopeType, row.scopeId)).catch(() => null);
      if (!chain || !this.authz.can(ctx, 'membership:write', chain)) continue;
      out.push({ ...publicView(row), scope: await this.describeScope(row.scopeType, row.scopeId) });
    }
    return out;
  }

  /** Creates a token and returns the secret exactly once. */
  async create(user: AuthenticatedUser, orgChain: ScopeChain, dto: CreateTokenDto) {
    if (user.token) throw new BadRequestException('Tokens cannot create tokens');
    let chain = orgChain;
    if (dto.scopeType && dto.scopeType !== 'ORGANIZATION') {
      if (!dto.scopeId) throw new BadRequestException('scopeId is required');
      chain = await this.resolver.resolveChain(scopeParamsFor(dto.scopeType, dto.scopeId));
      if (chain.organizationId !== orgChain.organizationId) throw new BadRequestException('Scope belongs to another organization');
    }
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'membership:write', chain);
    const permissions = dto.permissions ?? CI_TOKEN_PRESETS[dto.preset ?? 'deploy'].permissions;
    const keyId = `sk_${randomBytes(6).toString('hex')}`;
    const secret = `sec_${randomBytes(32).toString('base64url')}`;
    const [token] = await this.db
      .insert(apiTokens)
      .values({ organizationId: orgChain.organizationId, scopeType: chain.target.type, scopeId: chain.target.id, name: dto.name, keyId, secretEncrypted: this.crypto.encrypt(secret), permissions, environments: dto.environments ?? [], expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86400_000) : null, createdById: user.id })
      .returning();
    await this.audit.record({ organizationId: orgChain.organizationId, actor: userActor(user), action: 'api_token.created', resourceType: 'api_token', resourceId: token.id, after: { name: token.name, keyId, scope: `${chain.target.type}:${chain.target.id}`, permissions, environments: token.environments, expiresAt: token.expiresAt } });
    return { ...publicView(token), scope: await this.describeScope(token.scopeType, token.scopeId), secret };
  }

  async revoke(user: AuthenticatedUser, tokenId: string) {
    if (user.token) throw new BadRequestException('Tokens cannot revoke tokens');
    const [token] = await this.db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1);
    if (!token) throw new NotFoundException('Token not found');
    const chain = await this.resolver.resolveChain(scopeParamsFor(token.scopeType, token.scopeId));
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, 'membership:write', chain);
    const [after] = await this.db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, token.id)).returning();
    await this.audit.record({ organizationId: token.organizationId, actor: userActor(user), action: 'api_token.revoked', resourceType: 'api_token', resourceId: token.id, before: { name: token.name, keyId: token.keyId } });
    return publicView(after);
  }
}
