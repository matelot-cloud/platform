import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { IdentityService } from '../identity/identity.service';
import { setIdentityTokenIssuer } from './registry-auth';
import { IntegrationsService } from './integrations.service';
import { SourceSyncService } from './source-sync.service';

/**
 * Keyless registry connections: the cloud trusts the exact subject integration:<connection id>. Creation must not
 * probe (that would sign for a subject that does not exist yet); the connection is created unverified, the caller gets
 * the identity setup, and Verify — with the real id — is what checks the trust.
 */
const url = process.env.TEST_DATABASE_URL;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const crypto = (() => { const c = Object.create(CryptoService.prototype) as CryptoService; Object.assign(c, { key: Buffer.from('44'.repeat(32), 'hex') }); return c; })();
const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { sub: string; aud: string };

(url ? describe : describe.skip)('keyless registry connections: create unverified, verify with the real subject', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgs: string[] = [];
  const realFetch = global.fetch;
  /** What the "cloud" trusts — set by the test once the connection id is known, as the user would. */
  let trusted: string | null = null;
  const seenSubjects: string[] = [];
  let svc: IntegrationsService;
  let enqueued: string[] = [];
  let audits: string[] = [];
  let org: { id: string };
  let user: never;
  const users: string[] = [];

  beforeAll(async () => {
    const identity = Object.create(IdentityService.prototype) as IdentityService;
    Object.assign(identity, { db, crypto, issuer: 'https://matelot.example', logger: quiet });
    setIdentityTokenIssuer((id, aud) => identity.issue({ subject: identity.subjectFor(id), audience: aud, claims: { integration: id } }));
    const sourceSync = Object.create(SourceSyncService.prototype) as SourceSyncService;
    Object.assign(sourceSync, { db, crypto, logger: quiet });
    svc = Object.create(IntegrationsService.prototype) as IntegrationsService;
    const s = randomUUID().slice(0, 8);
    const [o] = await db.insert(schema.organizations).values({ slug: `k-${s}`, name: s }).returning();
    org = o!;
    const [u] = await db.insert(schema.users).values({ email: `k-${s}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning();
    users.push(u!.id);
    user = { id: u!.id } as never;
    orgs.push(org.id);
    Object.assign(svc, {
      db, crypto, sourceSync,
      audit: { record: async (e: { action: string }) => { audits.push(e.action); } },
      queue: { enqueue: async (_q: string, d: { integrationId: string }) => { enqueued.push(d.integrationId); } },
      targetChain: async () => ({ organizationId: org.id, target: { type: 'ORGANIZATION', id: org.id } }),
      assertOn: async () => undefined,
      describeScope: async () => ({ type: 'ORGANIZATION', id: org.id, name: 'org' }),
    });
    // Cloud mocks: AWS STS / Google STS / Entra accept only the trusted subject; registries answer /v2/.
    global.fetch = (async (u: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const reject = (status: number, text: string) => new Response(text, { status });
      if (u.startsWith('https://sts.') && u.includes('amazonaws.com')) {
        const c = claims(new URLSearchParams(body).get('WebIdentityToken')!);
        seenSubjects.push(c.sub);
        if (c.aud !== 'sts.amazonaws.com' || c.sub !== trusted) return reject(403, '<Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error>');
        return new Response('<R><Credentials><AccessKeyId>ASIA</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken></Credentials></R>');
      }
      if (u.startsWith('https://api.ecr.')) return new Response(JSON.stringify({ authorizationData: [{ authorizationToken: Buffer.from('AWS:pw').toString('base64'), expiresAt: Date.now() / 1000 + 43200 }] }));
      if (u.startsWith('https://sts.googleapis.com')) {
        const c = claims(JSON.parse(body).subjectToken as string);
        seenSubjects.push(c.sub);
        if (c.sub !== trusted) return reject(400, JSON.stringify({ error: 'invalid_grant', error_description: 'The given credential is rejected by the attribute condition.' }));
        return new Response(JSON.stringify({ access_token: 'federated' }));
      }
      if (u.includes('iamcredentials.googleapis.com')) return new Response(JSON.stringify({ accessToken: 'ya29', expireTime: new Date(Date.now() + 3600_000).toISOString() }));
      if (u.startsWith('https://login.microsoftonline.com')) {
        const c = claims(new URLSearchParams(body).get('client_assertion')!);
        seenSubjects.push(c.sub);
        if (c.sub !== trusted) return reject(400, JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS70021: No matching federated identity record found for presented assertion.' }));
        return new Response(JSON.stringify({ access_token: 'aad' }));
      }
      if (u.includes('/oauth2/exchange')) return new Response(JSON.stringify({ refresh_token: 'acr-rt' }));
      if (u.endsWith('/v2/')) return new Response('{}', { status: 200 });
      return reject(404, `unexpected ${u}`);
    }) as typeof fetch;
  });
  beforeEach(() => { trusted = null; seenSubjects.length = 0; enqueued = []; audits = []; });
  afterAll(async () => {
    global.fetch = realFetch;
    setIdentityTokenIssuer(null);
    for (const id of orgs) { await db.delete(schema.integrations).where(eq(schema.integrations.organizationId, id)).catch(() => undefined); await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); }
    for (const id of users) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => undefined);
    await pool.end();
  });

  const cases = [
    { cloud: 'ECR', baseUrl: '123456789012.dkr.ecr.eu-central-1.amazonaws.com', auth: { type: 'aws_wif', roleArn: 'arn:aws:iam::123456789012:role/matelot-ecr', region: 'eu-central-1' } },
    { cloud: 'GAR', baseUrl: 'europe-west3-docker.pkg.dev', auth: { type: 'gcp_wif', provider: 'projects/42/locations/global/workloadIdentityPools/matelot/providers/cell', serviceAccount: 'puller@p.iam.gserviceaccount.com' } },
    { cloud: 'ACR', baseUrl: 'matelottest.azurecr.io', auth: { type: 'azure_wif', tenantId: 'tenant', clientId: 'app-client' } },
  ] as const;

  for (const c of cases) {
    it(`${c.cloud}: created without a probe; verify fails until the trust pins integration:<id>, then succeeds`, async () => {
      const created = await svc.create(user, { organizationId: org.id } as never, { provider: 'registry', name: `${c.cloud} keyless`, baseUrl: c.baseUrl, auth: { ...c.auth } } as never) as unknown as { id: string; status: string; keyless?: boolean; verified?: boolean };
      expect(created).toMatchObject({ status: 'pending', keyless: true, verified: false });
      expect(seenSubjects).toEqual([]); // nothing signed at create — in particular never integration:pending
      expect(enqueued).toEqual([]); // no sync of an unverified connection

      // stored credentials carry no placeholder; the subject is derived from the row
      const [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.id, created.id));
      expect(crypto.decrypt(Buffer.from(row!.credentialsEncrypted!))).not.toContain('pending');
      expect(row!.settings).toMatchObject({ keyless: true, verified: false });

      // the identity setup names the exact subject (and the concrete principal / trust policy / federated credential)
      const identity = await svc.identityFor(user, created.id, 'https://matelot.example');
      expect(identity.subject).toBe(`integration:${created.id}`);
      expect(identity.verified).toBe(false);
      if (c.cloud === 'GAR') expect(identity.gcp.principal).toBe(`principal://iam.googleapis.com/projects/42/locations/global/workloadIdentityPools/matelot/subject/integration:${created.id}`);
      if (c.cloud === 'ECR') {
        expect(identity.aws.providerArn).toBe('arn:aws:iam::123456789012:oidc-provider/matelot.example');
        expect(identity.aws.trustPolicy.Statement[0]!.Condition.StringEquals).toEqual({ 'matelot.example:aud': 'sts.amazonaws.com', 'matelot.example:sub': `integration:${created.id}` });
      }
      if (c.cloud === 'ACR') expect(identity.azure.steps.join('\n')).toContain(`"subject":"integration:${created.id}"`);

      // trust not configured yet → verify fails, lastError stored, still unverified
      await expect(svc.verify(user, created.id)).rejects.toThrow(/Connection check failed/);
      expect(seenSubjects).toEqual([`integration:${created.id}`]);
      const [failed] = await db.select().from(schema.integrations).where(eq(schema.integrations.id, created.id));
      expect(failed!.lastError).toBeTruthy();
      expect(failed!.settings).toMatchObject({ verified: false });
      expect(audits).toContain('integration.verify_failed');

      // the user configures the trust for the documented subject → verify succeeds
      trusted = `integration:${created.id}`;
      const ok = await svc.verify(user, created.id) as unknown as { verified: boolean; account: string };
      expect(ok.verified).toBe(true);
      expect(ok.account).toContain('keyless');
      const [after] = await db.select().from(schema.integrations).where(eq(schema.integrations.id, created.id));
      expect(after!.lastError).toBeNull();
      expect(after!.settings).toMatchObject({ verified: true, keyless: true });
      expect(enqueued).toEqual([created.id]); // sync starts only now
    }, 30_000);
  }

  it('the wizard "Test connection" explains why a keyless connection cannot be tested before it exists', async () => {
    await expect(svc.test(user, { organizationId: org.id } as never, { provider: 'registry', baseUrl: cases[0].baseUrl, auth: { ...cases[0].auth } } as never)).rejects.toThrow(/subject integration:<connection id>/);
    expect(seenSubjects).toEqual([]);
  });

  it('sync of an unverified keyless connection is a quiet no-op (no error state)', async () => {
    const created = await svc.create(user, { organizationId: org.id } as never, { provider: 'registry', name: 'quiet', baseUrl: cases[0].baseUrl, auth: { ...cases[0].auth } } as never) as unknown as { id: string };
    const sourceSync = (svc as unknown as { sourceSync: SourceSyncService }).sourceSync;
    expect(await sourceSync.sync(created.id)).toEqual({ upserted: 0, removed: 0 });
    const [row] = await db.select().from(schema.integrations).where(eq(schema.integrations.id, created.id));
    expect(row!.status).toBe('pending');
    expect(row!.lastError).toMatch(/not verified yet/);
    expect(seenSubjects).toEqual([]);
  });

  it('verify is refused for providers it does not apply to', async () => {
    const [jira] = await db.insert(schema.integrations).values({ organizationId: org.id, scopeType: 'ORGANIZATION', scopeId: org.id, provider: 'jira', authType: 'basic', name: 'j', status: 'connected', externalAccountId: `j-${randomUUID()}`, settings: {} }).returning();
    await expect(svc.verify(user, jira!.id)).rejects.toThrow(/verify applies to git and registry/);
  });
});
