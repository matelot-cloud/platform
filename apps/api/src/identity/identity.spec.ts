import { createPublicKey, verify } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { IdentityService } from './identity.service';
import { dockerCredentialsFor, setIdentityTokenIssuer } from '../integrations/registry-auth';

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const cryptoWith = (hex: string) => { const c = Object.create(CryptoService.prototype) as CryptoService; Object.assign(c, { key: Buffer.from(hex, 'hex') }); return c; };

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('the cell as an OIDC issuer (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  beforeAll(async () => { await db.delete(schema.signingKeys).where(eq(schema.signingKeys.purpose, 'identity')); });
  afterAll(() => pool.end());
  const make = (hex: string) => { const s = Object.create(IdentityService.prototype) as IdentityService; Object.assign(s, { db, crypto: cryptoWith(hex), issuer: 'https://matelot.example', logger: quiet }); return s; };

  it('issues RS256 tokens for one audience that verify against the published JWKS', async () => {
    const svc = make('11'.repeat(32));
    const token = await svc.issue({ subject: 'integration:abc', audience: 'sts.amazonaws.com', claims: { integration: 'abc' } });
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(payload).toMatchObject({ iss: 'https://matelot.example', sub: 'integration:abc', aud: 'sts.amazonaws.com', integration: 'abc' });
    expect(payload.exp - payload.iat).toBe(600);
    const jwk = (await svc.jwks()).keys.find((k) => k.kid === header.kid)!;
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(svc.openidConfiguration()).toMatchObject({ issuer: 'https://matelot.example', jwks_uri: 'https://matelot.example/.well-known/jwks.json' });
  }, 20_000);

  it('a cell-key change rotates: the old key is retired but stays in the JWKS', async () => {
    const before = (await make('11'.repeat(32)).jwks()).keys.map((k) => k.kid);
    const rotated = make('22'.repeat(32));
    const t = await rotated.issue({ subject: 'integration:x', audience: 'a' });
    const kid = JSON.parse(Buffer.from(t.split('.')[0]!, 'base64url').toString()).kid;
    const after = (await rotated.jwks()).keys.map((k) => k.kid);
    expect(before.every((k) => after.includes(k))).toBe(true);
    expect(after).toContain(kid);
    expect(before).not.toContain(kid);
  }, 20_000);

  it('API and worker booting together mint one active key (and rotate once)', async () => {
    const fresh = '33'.repeat(32);
    const [a, b, c] = await Promise.all([make(fresh).ensureKey(), make(fresh).ensureKey(), make(fresh).ensureKey()]);
    expect(new Set([a.kid, b.kid, c.kid]).size).toBe(1);
    const active = await db.select().from(schema.signingKeys).where(and(eq(schema.signingKeys.purpose, 'identity'), isNull(schema.signingKeys.retiredAt)));
    expect(active).toHaveLength(1);
  }, 30_000);
});

describe('keyless registry credentials (cloud endpoints mocked)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  beforeAll(() => setIdentityTokenIssuer(async (id, aud) => `jwt[${id}|${aud}]`));
  afterAll(() => setIdentityTokenIssuer(null));
  const body = (init?: RequestInit) => String(init?.body ?? '');

  it('GCP: STS exchange with the provider audience, then impersonation → oauth2accesstoken', async () => {
    const calls: { url: string; body: string }[] = [];
    global.fetch = (async (u: string, init?: RequestInit) => { calls.push({ url: u, body: body(init) }); return new Response(JSON.stringify(u.includes('sts.googleapis') ? { access_token: 'federated' } : { accessToken: 'ya29.sa', expireTime: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }); }) as typeof fetch;
    const provider = 'projects/123/locations/global/workloadIdentityPools/matelot/providers/cell';
    const c = await dockerCredentialsFor('europe-west3-docker.pkg.dev', { type: 'gcp_wif', integrationId: '11111111-1111-4111-8111-111111111111', provider, serviceAccount: 'puller@p.iam.gserviceaccount.com' }, 'gcp-t');
    expect(c).toMatchObject({ username: 'oauth2accesstoken', password: 'ya29.sa' });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ audience: `//iam.googleapis.com/${provider}`, subjectToken: `jwt[11111111-1111-4111-8111-111111111111|https://iam.googleapis.com/${provider}]` });
    expect(calls[1]!.url).toContain('/serviceAccounts/puller%40p.iam.gserviceaccount.com:generateAccessToken');
  });

  it('never signs for a placeholder subject (the pre-insert "pending" id)', async () => {
    let calls = 0;
    global.fetch = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
    for (const integrationId of ['pending', '', 'i4']) {
      await expect(dockerCredentialsFor('1.dkr.ecr.eu-central-1.amazonaws.com', { type: 'aws_wif', integrationId, roleArn: 'arn:aws:iam::1:role/m', region: 'eu-central-1' }, `ph-${integrationId}`)).rejects.toThrow(/checked after they are created/);
    }
    expect(calls).toBe(0);
  });

  it('AWS: AssumeRoleWithWebIdentity → temporary keys (with session token) → ECR', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    global.fetch = (async (u: string, init?: RequestInit) => {
      seen.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string>, body: body(init) });
      if (u.startsWith('https://sts.')) return new Response('<R><Credentials><AccessKeyId>AKIA</AccessKeyId><SecretAccessKey>sec</SecretAccessKey><SessionToken>tok</SessionToken></Credentials></R>', { status: 200 });
      return new Response(JSON.stringify({ authorizationData: [{ authorizationToken: Buffer.from('AWS:ecrpass').toString('base64'), expiresAt: Date.now() / 1000 + 43200 }] }), { status: 200 });
    }) as typeof fetch;
    const c = await dockerCredentialsFor('1.dkr.ecr.eu-central-1.amazonaws.com', { type: 'aws_wif', integrationId: '22222222-2222-4222-8222-222222222222', roleArn: 'arn:aws:iam::1:role/matelot', region: 'eu-central-1' }, 'aws-t');
    expect(c).toMatchObject({ username: 'AWS', password: 'ecrpass' });
    const sts = new URLSearchParams(seen[0]!.body);
    expect([seen[0]!.url, sts.get('Action'), sts.get('RoleArn'), sts.get('WebIdentityToken')]).toEqual(['https://sts.eu-central-1.amazonaws.com/', 'AssumeRoleWithWebIdentity', 'arn:aws:iam::1:role/matelot', 'jwt[22222222-2222-4222-8222-222222222222|sts.amazonaws.com]']);
    const h = Object.fromEntries(Object.entries(seen[1]!.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['x-amz-security-token']).toBe('tok');
  });

  it('Azure: federated client assertion (no secret) → AAD → ACR exchange', async () => {
    const seen: { url: string; body: string }[] = [];
    global.fetch = (async (u: string, init?: RequestInit) => { seen.push({ url: u, body: body(init) }); return new Response(JSON.stringify(u.includes('login.microsoftonline') ? { access_token: 'aad' } : { refresh_token: 'acr-rt' }), { status: 200 }); }) as typeof fetch;
    const c = await dockerCredentialsFor('matelottest.azurecr.io', { type: 'azure_wif', integrationId: '33333333-3333-4333-8333-333333333333', tenantId: 't', clientId: 'app' }, 'az-t');
    expect(c).toMatchObject({ username: '00000000-0000-0000-0000-000000000000', password: 'acr-rt' });
    const aad = new URLSearchParams(seen[0]!.body);
    expect([aad.get('client_assertion'), aad.get('client_secret'), aad.get('client_id')]).toEqual(['jwt[33333333-3333-4333-8333-333333333333|api://AzureADTokenExchange]', null, 'app']);
    expect(seen[1]!.url).toBe('https://matelottest.azurecr.io/oauth2/exchange');
  });

  it('without an initialised issuer the error says so (no silent fallback)', async () => {
    setIdentityTokenIssuer(null);
    await expect(dockerCredentialsFor('x.azurecr.io', { type: 'azure_wif', integrationId: 'i4', tenantId: 't', clientId: 'c' }, 'none-t')).rejects.toThrow(/identity key is not initialised/);
    setIdentityTokenIssuer(async (id, aud) => `jwt[${id}|${aud}]`);
  });
});
