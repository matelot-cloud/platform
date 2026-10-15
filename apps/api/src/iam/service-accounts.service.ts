import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';
import { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { memberships, personalAccessTokens, Role, ScopeType, User, users } from '../database/schema';
import { assertFeature } from '../features/features';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { MembersService } from './members.service';

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export interface TokenRequest { name: string; scope: 'read' | 'write'; expiresInDays?: number }

/**
 * Service accounts (GitLab: service accounts + group / project access tokens): a non-human user owned by one scope,
 * with no password and no browser login, that holds roles through ordinary memberships (only at its scope and below)
 * and authenticates with tokens. Its tokens are personal access tokens of the bot (source 'service_account'), so the
 * read / write mask, revocation, last-use tracking and the audit trail work exactly like a person's — no parallel
 * token system. CI tokens stay what they are: HMAC-signed pipeline credentials with deploy presets (docs/access-tokens.md).
 * Managing a service account needs membership:write at the scope that owns it.
 */
@Injectable()
export class ServiceAccountsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly members: MembersService,
    private readonly tokens: PersonalTokensService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private maxDays(): number {
    return this.config.get('SERVICE_ACCOUNT_TOKEN_MAX_DAYS', { infer: true }) ?? 365;
  }

  private async authorize(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string) {
    const chain = await this.members.chainOf(scopeType, scopeId);
    const ctx = await this.access.forUser(actor.id);
    this.authz.assert(ctx, 'membership:write', chain);
    return chain;
  }

  private async load(id: string): Promise<User> {
    const [u] = await this.db.select().from(users).where(and(eq(users.id, id), eq(users.kind, 'service_account'))).limit(1);
    if (!u) throw new NotFoundException('Service account not found');
    return u;
  }

  private view<T extends Record<string, unknown> = Record<string, never>>(u: User, extra: T = {} as T) {
    return { id: u.id, name: u.displayName, username: u.email, description: u.description, ownerScopeType: u.ownerScopeType, ownerScopeId: u.ownerScopeId, disabled: !!u.disabledAt, createdAt: u.createdAt, ...extra };
  }

  async list(actor: AuthenticatedUser, scopeType: ScopeType, scopeId: string) {
    assertFeature('service_accounts');
    const chain = await this.members.chainOf(scopeType, scopeId);
    const ctx = await this.access.forUser(actor.id);
    this.authz.assert(ctx, 'membership:read', chain);
    const rows = await this.db.select().from(users).where(and(eq(users.kind, 'service_account'), eq(users.ownerScopeType, scopeType), eq(users.ownerScopeId, scopeId))).orderBy(users.displayName);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const active = await this.db.select({ userId: personalAccessTokens.userId, n: count() }).from(personalAccessTokens).where(and(inArray(personalAccessTokens.userId, ids), isNull(personalAccessTokens.revokedAt))).groupBy(personalAccessTokens.userId);
    const roles = await this.db.select({ userId: memberships.userId, role: memberships.role, scopeType: memberships.scopeType, scopeId: memberships.scopeId, expiresAt: memberships.expiresAt }).from(memberships).where(inArray(memberships.userId, ids));
    return rows.map((u) => this.view(u, { activeTokens: Number(active.find((a) => a.userId === u.id)?.n ?? 0), memberships: roles.filter((r) => r.userId === u.id) }));
  }

  async create(actor: AuthenticatedUser, input: { scopeType: ScopeType; scopeId: string; name: string; description?: string; role?: Role; expiresAt?: string | null }) {
    assertFeature('service_accounts');
    const chain = await this.authorize(actor, input.scopeType, input.scopeId);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    // a reserved, never-routable address: nobody can sign in with it, and it says what the account is
    const username = `bot-${slugify(name).slice(0, 30) || 'service'}-${randomBytes(4).toString('hex')}@${input.scopeType.toLowerCase()}-${input.scopeId.slice(0, 8)}.bots.matelot.invalid`;
    const [sa] = await this.db.insert(users).values({ email: username, displayName: name, kind: 'service_account', ownerScopeType: input.scopeType, ownerScopeId: input.scopeId, description: input.description?.trim() || null, createdById: actor.token ? null : actor.id }).returning();
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'service_account.created', resourceType: 'user', resourceId: sa!.id, after: { name, username, scopeType: input.scopeType, scopeId: input.scopeId } });
    let membershipId: string | null = null;
    if (input.role) {
      const r = await this.members.add(actor, { scopeType: input.scopeType, scopeId: input.scopeId, role: input.role, userIds: [sa!.id], expiresAt: input.expiresAt });
      membershipId = r.added[0]?.membershipId ?? null;
    }
    return this.view(sa!, { membershipId });
  }

  async remove(actor: AuthenticatedUser, id: string) {
    const sa = await this.load(id);
    const chain = await this.authorize(actor, sa.ownerScopeType!, sa.ownerScopeId!);
    const [{ n: tokens }] = await this.db.select({ n: count() }).from(personalAccessTokens).where(eq(personalAccessTokens.userId, id));
    const [{ n: roles }] = await this.db.select({ n: count() }).from(memberships).where(eq(memberships.userId, id));
    await this.db.delete(users).where(eq(users.id, id));   // cascades: memberships, tokens
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'service_account.deleted', resourceType: 'user', resourceId: id, before: { name: sa.displayName, username: sa.email, memberships: Number(roles), tokens: Number(tokens) } });
    return { deleted: true, memberships: Number(roles), tokens: Number(tokens) };
  }

  async setDisabled(actor: AuthenticatedUser, id: string, disabled: boolean) {
    const sa = await this.load(id);
    const chain = await this.authorize(actor, sa.ownerScopeType!, sa.ownerScopeId!);
    const [after] = await this.db.update(users).set({ disabledAt: disabled ? new Date() : null }).where(eq(users.id, id)).returning();
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: disabled ? 'service_account.disabled' : 'service_account.enabled', resourceType: 'user', resourceId: id, after: { name: sa.displayName } });
    return this.view(after!);
  }

  async listTokens(actor: AuthenticatedUser, id: string) {
    const sa = await this.load(id);
    await this.authorize(actor, sa.ownerScopeType!, sa.ownerScopeId!);
    return this.tokens.listFor(id);
  }

  async createToken(actor: AuthenticatedUser, id: string, req: TokenRequest) {
    const sa = await this.load(id);
    const chain = await this.authorize(actor, sa.ownerScopeType!, sa.ownerScopeId!);
    if (!['read', 'write'].includes(req.scope)) throw new BadRequestException('A service-account token is read or write (sudo is for people)');
    if (!req.name?.trim()) throw new BadRequestException('name is required');
    const max = this.maxDays();
    const days = Math.floor(req.expiresInDays ?? Math.min(365, max));
    if (days < 1 || days > max) throw new BadRequestException(`expiresInDays must be between 1 and ${max} (SERVICE_ACCOUNT_TOKEN_MAX_DAYS)`);
    const created = await this.tokens.issueFor(id, { name: req.name, scope: req.scope, expiresAt: new Date(Date.now() + days * 86400_000) });
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'service_account.token_created', resourceType: 'personal_token', resourceId: created.id, after: { serviceAccount: sa.displayName, name: created.name, scope: created.scope, expiresAt: created.expiresAt } });
    return created;
  }

  async revokeToken(actor: AuthenticatedUser, id: string, tokenId: string) {
    const sa = await this.load(id);
    const chain = await this.authorize(actor, sa.ownerScopeType!, sa.ownerScopeId!);
    const row = await this.tokens.revokeFor(id, tokenId);
    if (!row) throw new NotFoundException('Token not found or already revoked');
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(actor), action: 'service_account.token_revoked', resourceType: 'personal_token', resourceId: tokenId, before: { serviceAccount: sa.displayName, name: row.name } });
    return { revoked: true };
  }

  /** Rotation: a new token with the same name, scope and lifetime; the old one is revoked at once. */
  async rotateToken(actor: AuthenticatedUser, id: string, tokenId: string) {
    const sa = await this.load(id);
    await this.authorize(actor, sa.ownerScopeType!, sa.ownerScopeId!);
    const old = (await this.tokens.listFor(id)).find((t) => t.id === tokenId && !t.revokedAt);
    if (!old) throw new NotFoundException('Token not found or already revoked');
    const days = Math.max(1, Math.min(this.maxDays(), Math.round((old.expiresAt.getTime() - old.createdAt.getTime()) / 86400_000)));
    const created = await this.createToken(actor, id, { name: old.name, scope: old.scope as 'read' | 'write', expiresInDays: days });
    await this.revokeToken(actor, id, tokenId);
    return { ...created, replaces: tokenId };
  }

  /** Scope access token (GitLab "project access token"): bot + membership + token in one step. */
  async createScopeAccessToken(actor: AuthenticatedUser, input: { scopeType: ScopeType; scopeId: string; name: string; role: Role; scope: 'read' | 'write'; expiresInDays?: number }) {
    assertFeature('scope_access_tokens');
    if (!input.role) throw new BadRequestException('role is required');
    const sa = await this.create(actor, { scopeType: input.scopeType, scopeId: input.scopeId, name: input.name, role: input.role, description: 'Access token (created with its bot member)' });
    try {
      const token = await this.createToken(actor, sa.id, { name: input.name, scope: input.scope, expiresInDays: input.expiresInDays });
      return { serviceAccount: sa, token };
    } catch (e) {
      await this.db.delete(users).where(eq(users.id, sa.id));   // all-or-nothing: no orphaned bot when the token is refused
      throw e;
    }
  }
}
