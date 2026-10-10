import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { OauthService } from './oauth.service';
import { PersonalTokensService } from '../auth/personal-tokens/personal-tokens.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('OAuth 2.1: code + PKCE → personal token; refresh rotates; revoke', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  let userId: string;
  afterAll(async () => { await db.delete(schema.users).where(eq(schema.users.id, userId)).catch(() => undefined); await pool.end(); });

  it('full flow', async () => {
    const [u] = await db.insert(schema.users).values({ email: `oauth-${randomUUID().slice(0, 8)}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning(); userId = u!.id;
    const tokens = Object.create(PersonalTokensService.prototype) as PersonalTokensService; Object.assign(tokens, { db, audit: { record: async () => undefined } });
    const svc = Object.create(OauthService.prototype) as OauthService;
    Object.assign(svc, { db, tokens, audit: { record: async () => undefined }, issuer: 'https://matelot.example', webBaseUrl: 'https://app.example' });

    const client = await svc.register({ client_name: 'claude.ai', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const { consentUrl } = await svc.authorizeRequest({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'write', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256' });
    expect(consentUrl).toMatch(/^https:\/\/app\.example\/oauth\/consent\?/);
    const { redirect } = await svc.approve({ id: userId, email: u!.email, platformRole: 'user' } as never, { client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'write', state: 'xyz', code_challenge: challenge });
    const code = new URL(redirect).searchParams.get('code')!;
    expect(new URL(redirect).searchParams.get('state')).toBe('xyz');

    await expect(svc.token({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: 'wrong' })).rejects.toThrow();     // PKCE enforced
    const t = await svc.token({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier });
    expect(t.access_token).toMatch(/^spt_/);
    expect(t.scope).toBe('write');
    await expect(svc.token({ grant_type: 'authorization_code', code, client_id: client.client_id, code_verifier: verifier })).rejects.toMatchObject({ response: { error: 'invalid_grant' } });   // single use
    // the access token is a real personal token of that user
    const found = await tokens.authenticate(t.access_token);
    expect(found).toMatchObject({ scope: 'write', user: { id: userId } });
    // refresh rotates: new pair, old access token revoked
    const t2 = await svc.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: client.client_id });
    expect(t2.access_token).not.toBe(t.access_token);
    expect(await tokens.authenticate(t.access_token)).toBeNull();
    await expect(svc.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).rejects.toThrow();    // old refresh token dead
    await svc.revoke(t2.refresh_token);
    expect(await tokens.authenticate(t2.access_token)).toBeNull();
  }, 20_000);

  it('matelot-cli (built-in client): authorize → approve → token succeeds against the real FKs', async () => {
    const [u] = await db.insert(schema.users).values({ email: `cli-${randomUUID().slice(0, 8)}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning();
    const tokens = Object.create(PersonalTokensService.prototype) as PersonalTokensService; Object.assign(tokens, { db, audit: { record: async () => undefined } });
    const svc = Object.create(OauthService.prototype) as OauthService;
    Object.assign(svc, { db, tokens, audit: { record: async () => undefined }, issuer: 'https://matelot.example', webBaseUrl: 'https://app.example' });
    await db.delete(schema.oauthClients).where(eq(schema.oauthClients.id, 'matelot-cli')); // simulate a database restored before 0038
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await svc.authorizeRequest({ response_type: 'code', client_id: 'matelot-cli', redirect_uri: 'http://127.0.0.1:54321/callback', scope: 'write', code_challenge: challenge, code_challenge_method: 'S256' });
    const { redirect } = await svc.approve({ id: u!.id, email: u!.email, platformRole: 'user' } as never, { client_id: 'matelot-cli', redirect_uri: 'http://127.0.0.1:54321/callback', scope: 'write', code_challenge: challenge });
    const code = new URL(redirect).searchParams.get('code')!;
    const t = await svc.token({ grant_type: 'authorization_code', code, client_id: 'matelot-cli', code_verifier: verifier });
    expect(t.access_token).toMatch(/^spt_/);
    expect(await tokens.authenticate(t.access_token)).toMatchObject({ user: { id: u!.id }, scope: 'write' });
    await expect(svc.authorizeRequest({ response_type: 'code', client_id: 'matelot-cli', redirect_uri: 'https://evil.example/cb', scope: 'read', code_challenge: challenge })).rejects.toThrow(); // non-loopback refused
    await db.delete(schema.users).where(eq(schema.users.id, u!.id));
  }, 20_000);
});
