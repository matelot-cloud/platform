import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { userActor } from '../../audit/audit.types';
import { currentRequestContext } from '../../common/request-context';
import { DATABASE, Database } from '../../database/database.module';
import { memberships, personalAccessTokens, users } from '../../database/schema';
import type { AuthenticatedUser } from '../authenticated-user';
import { ScopeResolverService } from '../../rbac/scope-resolver.service';
import { scopeParamsFor } from '../../rbac/scope.types';

export type PersonalTokenScope = 'read' | 'write' | 'sudo';
export const TOKEN_PREFIX = 'spt_';
const ADMIN_ROLES = ['ORG_ADMIN', 'SECURITY_ADMIN'] as const;
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

@Injectable()
export class PersonalTokensService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** Token events are recorded in every organization the user belongs to, so its admins see them. */
  private async auditEverywhere(user: AuthenticatedUser, action: string, resourceId: string, after: Record<string, unknown>) {
    const rows = await this.db.select({ scopeType: memberships.scopeType, scopeId: memberships.scopeId }).from(memberships).where(eq(memberships.userId, user.id));
    const orgs = new Set<string>();
    for (const r of rows) {
      const chain = await this.resolver.resolveChain(scopeParamsFor(r.scopeType, r.scopeId)).catch(() => null);
      if (chain) orgs.add(chain.organizationId);
    }
    for (const organizationId of orgs.size ? orgs : new Set<string | null>([null])) await this.audit.record({ organizationId, actor: userActor(user), action, resourceType: 'personal_token', resourceId, after });
  }

  /** Admin = platform admin or organization/security admin somewhere: only they may hold sudo tokens. */
  async isAdmin(user: AuthenticatedUser): Promise<boolean> {
    if (user.platformRole === 'admin') return true;
    const [m] = await this.db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, user.id), inArray(memberships.role, [...ADMIN_ROLES]))).limit(1);
    return !!m;
  }

  private assertInteractive(user: AuthenticatedUser) {
    if (user.token) throw new ForbiddenException('CI tokens cannot manage personal tokens');
    if (currentRequestContext()?.personalToken) throw new ForbiddenException('Personal tokens cannot create or revoke tokens — sign in to the web app');
  }

  async list(user: AuthenticatedUser) {
    const rows = await this.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, user.id)).orderBy(desc(personalAccessTokens.createdAt));
    return rows.map(({ tokenHash: _h, ...r }) => ({ ...r, expired: r.expiresAt.getTime() < Date.now() }));
  }

  async create(user: AuthenticatedUser, input: { name: string; scope: PersonalTokenScope; expiresInDays: number }) {
    this.assertInteractive(user);
    const name = input.name.trim();
    if (!name) throw new BadRequestException('name is required');
    if (!['read', 'write', 'sudo'].includes(input.scope)) throw new BadRequestException('scope must be read, write or sudo');
    if (input.scope === 'sudo' && !(await this.isAdmin(user))) throw new ForbiddenException('Only administrators can create sudo tokens');
    const days = Math.min(365, Math.max(1, Math.floor(input.expiresInDays || 30)));
    const secret = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
    const [row] = await this.db.insert(personalAccessTokens).values({ userId: user.id, name: name.slice(0, 100), scope: input.scope, tokenHash: hash(secret), prefix: secret.slice(0, 10), expiresAt: new Date(Date.now() + days * 86400_000) }).returning();
    await this.auditEverywhere(user, 'personal_token.created', row.id, { name: row.name, scope: row.scope, expiresAt: row.expiresAt });
    const { tokenHash: _h, ...rest } = row;
    return { ...rest, token: secret };
  }

  /** OAuth access tokens are personal tokens with a short life; created for the user who approved the consent. */
  async createForOauth(userId: string, input: { name: string; scope: PersonalTokenScope; expiresInSeconds: number; clientId: string }) {
    // Same row, same authentication and authorisation as a UI-created token (see authenticate / AccessService.forUser);
    // only the provenance differs: source=oauth, named after the client, short-lived (refreshed by the OAuth client).
    const secret = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
    const [row] = await this.db.insert(personalAccessTokens).values({ userId, name: input.name.slice(0, 100), scope: input.scope, tokenHash: hash(secret), prefix: secret.slice(0, 10), expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000), source: 'oauth', oauthClientId: input.clientId }).returning();
    await this.audit.record({ organizationId: null, actor: { type: 'USER', id: userId, label: 'oauth consent' }, action: 'personal_token.created', resourceType: 'personal_token', resourceId: row!.id, after: { name: row!.name, scope: row!.scope, source: 'oauth', client: input.clientId, expiresAt: row!.expiresAt } }).catch(() => undefined);
    return { id: row!.id, token: secret, expiresAt: row!.expiresAt };
  }

  async revoke(user: AuthenticatedUser, id: string) {
    this.assertInteractive(user);
    const [row] = await this.db.update(personalAccessTokens).set({ revokedAt: new Date() }).where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, user.id), isNull(personalAccessTokens.revokedAt))).returning({ id: personalAccessTokens.id, name: personalAccessTokens.name });
    if (!row) throw new NotFoundException('Token not found');
    await this.auditEverywhere(user, 'personal_token.revoked', row.id, { name: row.name });
    return { revoked: true };
  }

  // ---- tokens of another identity (service accounts): authorised and audited by the caller --------------------------
  /** A token for `userId` (a service account): same table, hashing and authentication as a personal token, source
   *  'service_account', never sudo. Returns the secret once. */
  async issueFor(userId: string, input: { name: string; scope: 'read' | 'write'; expiresAt: Date }) {
    const secret = `${TOKEN_PREFIX}${randomBytes(30).toString('base64url')}`;
    const [row] = await this.db.insert(personalAccessTokens).values({ userId, name: input.name.trim().slice(0, 100), scope: input.scope, tokenHash: hash(secret), prefix: secret.slice(0, 10), expiresAt: input.expiresAt, source: 'service_account' }).returning();
    const { tokenHash: _h, ...rest } = row!;
    return { ...rest, token: secret };
  }

  async listFor(userId: string) {
    const rows = await this.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, userId)).orderBy(desc(personalAccessTokens.createdAt));
    return rows.map(({ tokenHash: _h, ...r }) => ({ ...r, expired: r.expiresAt.getTime() < Date.now() }));
  }

  async revokeFor(userId: string, tokenId: string) {
    const [row] = await this.db.update(personalAccessTokens).set({ revokedAt: new Date() }).where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt))).returning();
    if (!row) return null;
    const { tokenHash: _h, ...rest } = row;
    return rest;
  }

  /** Resolves a presented secret to its user; null when unknown, revoked, expired or the user is disabled. */
  async authenticate(secret: string, ip?: string): Promise<{ user: AuthenticatedUser; tokenId: string; scope: PersonalTokenScope } | null> {
    const [row] = await this.db.select({ t: personalAccessTokens, u: users }).from(personalAccessTokens).innerJoin(users, eq(personalAccessTokens.userId, users.id)).where(eq(personalAccessTokens.tokenHash, hash(secret))).limit(1);
    if (!row || row.t.revokedAt || row.t.expiresAt.getTime() < Date.now()) return null;
    if ((row.u as { disabledAt?: Date | null }).disabledAt) return null;
    // Last use, at most once a minute per token.
    if (!row.t.lastUsedAt || Date.now() - row.t.lastUsedAt.getTime() > 60_000) void this.db.update(personalAccessTokens).set({ lastUsedAt: new Date(), lastUsedIp: ip ?? null }).where(eq(personalAccessTokens.id, row.t.id)).catch(() => undefined);
    const scope = row.t.scope as PersonalTokenScope;
    const user: AuthenticatedUser = { id: row.u.id, email: row.u.email, displayName: row.u.displayName ?? null, externalId: row.u.externalId ?? `pat:${row.t.id}`, platformRole: scope === 'sudo' && row.u.platformRole === 'admin' ? 'admin' : 'user' };
    return { user, tokenId: row.t.id, scope };
  }
}
