import { BadRequestException, Inject, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';
import { DATABASE, Database } from '../database/database.module';
import { oauthClients, oauthCodes, oauthRefreshTokens, personalAccessTokens } from '../database/schema';
import type { Env } from '../config/env';
import { publicApiBase } from '../config/public-url';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');
export const SCOPES = ['read', 'write', 'sudo'] as const;
export type OauthScope = (typeof SCOPES)[number];
const ACCESS_TTL_S = 24 * 3600;      // personal tokens live in days; the OAuth access token is the shortest: 1 day
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 300;
/** `matelot login` is pre-registered: a public client that may use any loopback redirect. */
export const CLI_CLIENT_ID = 'matelot-cli';

/**
 * OAuth 2.1 authorization server for MCP connectors (claude.ai "Add custom connector") and `matelot login`.
 * Public clients + PKCE (S256) only, dynamic client registration, rotating refresh tokens.
 * The access token IS a personal access token (spt_…): same RBAC, audit trail and revocation as any token.
 */
@Injectable()
export class OauthService implements OnModuleInit {
  readonly issuer: string;
  readonly webBaseUrl: string;
  constructor(@Inject(DATABASE) private readonly db: Database, config: ConfigService<Env, true>, private readonly tokens: PersonalTokensService, private readonly audit: AuditService) {
    this.issuer = publicApiBase(config);
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  /** The built-in CLI client exists as a row (FKs from codes / refresh tokens); migration 0038 seeds it, this covers restored databases. */
  async onModuleInit() { await this.ensureCliClient().catch(() => undefined); }
  async ensureCliClient() {
    await this.db.insert(oauthClients).values({ id: CLI_CLIENT_ID, name: 'matelot CLI', redirectUris: ['loopback'] }).onConflictDoNothing();
  }

  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/api/v1/oauth/authorize`,
      token_endpoint: `${this.issuer}/api/v1/oauth/token`,
      registration_endpoint: `${this.issuer}/api/v1/oauth/register`,
      revocation_endpoint: `${this.issuer}/api/v1/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES],
      service_documentation: `${this.webBaseUrl}/docs/mcp`,
    };
  }
  protectedResource() {
    return { resource: `${this.issuer}/api/v1/mcp`, authorization_servers: [this.issuer], scopes_supported: [...SCOPES], bearer_methods_supported: ['header'], resource_documentation: `${this.webBaseUrl}/docs/mcp` };
  }

  // ---------------------------------------------------------------- clients
  async register(input: { client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string; grant_types?: string[] }) {
    const uris = (input.redirect_uris ?? []).filter((u) => typeof u === 'string');
    if (!uris.length) throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
    for (const u of uris) { let x: URL; try { x = new URL(u); } catch { throw new BadRequestException({ error: 'invalid_redirect_uri', error_description: `not a URL: ${u}` }); } if (x.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(x.hostname) && x.protocol !== 'http:') throw new BadRequestException({ error: 'invalid_redirect_uri' }); }
    if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') throw new BadRequestException({ error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method=none) with PKCE are supported' });
    const id = randomUUID();
    await this.db.insert(oauthClients).values({ id, name: (input.client_name ?? 'OAuth client').slice(0, 120), redirectUris: uris });
    return { client_id: id, client_name: input.client_name ?? 'OAuth client', redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_id_issued_at: Math.floor(Date.now() / 1000) };
  }

  private async client(id: string) {
    let [c] = await this.db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1);
    if (!c && id === CLI_CLIENT_ID) { await this.ensureCliClient(); [c] = await this.db.select().from(oauthClients).where(eq(oauthClients.id, id)).limit(1); }
    if (!c) throw new BadRequestException({ error: 'invalid_client', error_description: 'unknown client_id' });
    return c;
  }
  private redirectAllowed(client: { id: string; redirectUris: string[] }, uri: string) {
    if (client.id === CLI_CLIENT_ID || client.redirectUris.includes('loopback')) { try { const u = new URL(uri); return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.protocol === 'http:'; } catch { return false; } }
    return client.redirectUris.includes(uri);
  }

  // ---------------------------------------------------------------- authorize → consent → code
  /** Validates an authorization request and returns where the web consent page must send the user; errors go back to the client when the redirect is trusted. */
  async authorizeRequest(q: Record<string, string | undefined>): Promise<{ consentUrl: string }> {
    const client = await this.client(q.client_id ?? '');
    if (!q.redirect_uri || !this.redirectAllowed(client, q.redirect_uri)) throw new BadRequestException({ error: 'invalid_request', error_description: 'redirect_uri is not registered for this client' });
    if (q.response_type !== 'code') throw new BadRequestException({ error: 'unsupported_response_type' });
    if (!q.code_challenge || (q.code_challenge_method ?? 'S256') !== 'S256') throw new BadRequestException({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    const scope = (q.scope ?? 'read').split(/[ ,]+/).filter(Boolean);
    const bad = scope.find((s) => !(SCOPES as readonly string[]).includes(s));
    if (bad) throw new BadRequestException({ error: 'invalid_scope', error_description: `unknown scope ${bad}` });
    const params = new URLSearchParams({ client_id: client.id, client_name: client.name, redirect_uri: q.redirect_uri, scope: scope.join(' '), state: q.state ?? '', code_challenge: q.code_challenge, resource: q.resource ?? '' });
    return { consentUrl: `${this.webBaseUrl}/oauth/consent?${params}` };
  }

  /** Called by the web consent page with the user's session: mints the code and returns the client redirect. */
  async approve(user: AuthenticatedUser, input: { client_id: string; redirect_uri: string; scope: OauthScope; state?: string; code_challenge: string; resource?: string }) {
    const client = await this.client(input.client_id);
    if (!this.redirectAllowed(client, input.redirect_uri)) throw new BadRequestException('redirect_uri is not registered for this client');
    if (!SCOPES.includes(input.scope)) throw new BadRequestException('scope must be read, write or sudo');
    if (input.scope === 'sudo' && user.platformRole !== 'admin') throw new BadRequestException('Only administrators can grant sudo');
    const code = b64url(randomBytes(32));
    await this.db.insert(oauthCodes).values({ codeHash: sha(code), clientId: client.id, userId: user.id, scope: input.scope, redirectUri: input.redirect_uri, codeChallenge: input.code_challenge, resource: input.resource || null, expiresAt: new Date(Date.now() + CODE_TTL_S * 1000) });
    await this.audit.record({ organizationId: null, actor: userActor(user), action: 'oauth.authorized', resourceType: 'oauth_client', resourceId: client.id, after: { client: client.name, scope: input.scope } }).catch(() => undefined);
    const u = new URL(input.redirect_uri); u.searchParams.set('code', code); if (input.state) u.searchParams.set('state', input.state);
    return { redirect: u.toString() };
  }

  // ---------------------------------------------------------------- token
  async token(body: Record<string, string | undefined>) {
    if (body.grant_type === 'authorization_code') {
      const [row] = await this.db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, sha(body.code ?? ''))).limit(1);
      if (!row || row.usedAt || row.expiresAt < new Date()) throw new BadRequestException({ error: 'invalid_grant', error_description: 'code unknown, used or expired' });
      if (row.clientId !== body.client_id) throw new BadRequestException({ error: 'invalid_grant', error_description: 'client_id mismatch' });
      if (body.redirect_uri && body.redirect_uri !== row.redirectUri) throw new BadRequestException({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      if (!body.code_verifier || b64url(createHash('sha256').update(body.code_verifier).digest()) !== row.codeChallenge) throw new BadRequestException({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      await this.db.update(oauthCodes).set({ usedAt: new Date() }).where(eq(oauthCodes.codeHash, row.codeHash));
      return this.issue(row.clientId, row.userId, row.scope as OauthScope);
    }
    if (body.grant_type === 'refresh_token') {
      const [row] = await this.db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, sha(body.refresh_token ?? ''))).limit(1);
      if (!row || row.revokedAt || row.expiresAt < new Date()) throw new BadRequestException({ error: 'invalid_grant', error_description: 'refresh token unknown, revoked or expired' });
      if (body.client_id && body.client_id !== row.clientId) throw new BadRequestException({ error: 'invalid_grant' });
      // rotation: the old refresh token and its access token die with this exchange
      await this.db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(eq(oauthRefreshTokens.tokenHash, row.tokenHash));
      if (row.personalTokenId) await this.db.update(personalAccessTokens).set({ revokedAt: new Date() }).where(and(eq(personalAccessTokens.id, row.personalTokenId), isNull(personalAccessTokens.revokedAt)));
      return this.issue(row.clientId, row.userId, row.scope as OauthScope);
    }
    throw new BadRequestException({ error: 'unsupported_grant_type' });
  }

  private async issue(clientId: string, userId: string, scope: OauthScope) {
    const client = await this.client(clientId);
    const access = await this.tokens.createForOauth(userId, { name: client.name, scope, expiresInSeconds: ACCESS_TTL_S, clientId });
    const refresh = b64url(randomBytes(32));
    await this.db.insert(oauthRefreshTokens).values({ tokenHash: sha(refresh), clientId, userId, scope, personalTokenId: access.id, expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000) });
    await this.db.update(oauthClients).set({ lastUsedAt: new Date() }).where(eq(oauthClients.id, clientId)).catch(() => undefined);
    return { access_token: access.token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  async revoke(token: string) {
    const [r] = await this.db.update(oauthRefreshTokens).set({ revokedAt: new Date() }).where(and(eq(oauthRefreshTokens.tokenHash, sha(token)), isNull(oauthRefreshTokens.revokedAt))).returning();
    if (r?.personalTokenId) await this.db.update(personalAccessTokens).set({ revokedAt: new Date() }).where(eq(personalAccessTokens.id, r.personalTokenId));
    if (!r && token.startsWith('spt_')) await this.db.update(personalAccessTokens).set({ revokedAt: new Date() }).where(and(eq(personalAccessTokens.tokenHash, sha(token)), isNull(personalAccessTokens.revokedAt)));
    return {};
  }

  unauthorized(): never { throw new UnauthorizedException(); }
}
