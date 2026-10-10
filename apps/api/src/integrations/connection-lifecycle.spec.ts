import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { CryptoService } from '../common/crypto.service';
import { IntegrationsService } from './integrations.service';
import { SourceSyncService } from './source-sync.service';
import { cloudError } from './cloud-error';

/** Delete vs disconnect, a disconnected keyless identity page, and the pending → connected transition. */
const url = process.env.TEST_DATABASE_URL;
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const crypto = (() => { const c = Object.create(CryptoService.prototype) as CryptoService; Object.assign(c, { key: Buffer.from('55'.repeat(32), 'hex') }); return c; })();

(url ? describe : describe.skip)('connection lifecycle (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgs: string[] = [];
  const users: string[] = [];
  let svc: IntegrationsService;
  let sourceSync: SourceSyncService;
  let org: { id: string };
  let service: { id: string };
  let user: never;
  let audits: string[] = [];

  beforeAll(async () => {
    const s = randomUUID().slice(0, 8);
    [org] = (await db.insert(schema.organizations).values({ slug: `l-${s}`, name: s }).returning()) as unknown as [{ id: string }];
    orgs.push(org.id);
    const [u] = await db.insert(schema.users).values({ email: `l-${s}@acme.local`, externalId: randomUUID(), platformRole: 'user' } as typeof schema.users.$inferInsert).returning();
    users.push(u!.id);
    user = { id: u!.id } as never;
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    [service] = (await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning()) as unknown as [{ id: string }];
    sourceSync = Object.create(SourceSyncService.prototype) as SourceSyncService;
    Object.assign(sourceSync, { db, crypto, logger: quiet, audit: { record: async () => undefined } });
    svc = Object.create(IntegrationsService.prototype) as IntegrationsService;
    Object.assign(svc, {
      db, crypto, sourceSync,
      audit: { record: async (e: { action: string }) => { audits.push(e.action); } },
      queue: { enqueue: async () => undefined },
      targetChain: async () => ({ organizationId: org.id, target: { type: 'ORGANIZATION', id: org.id } }),
      assertOn: async () => undefined,
      describeScope: async () => ({ type: 'ORGANIZATION', id: org.id, name: 'org' }),
    });
  });
  beforeEach(() => { audits = []; });
  afterAll(async () => {
    for (const id of orgs) { await db.delete(schema.integrations).where(eq(schema.integrations.organizationId, id)).catch(() => undefined); await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); }
    for (const id of users) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => undefined);
    await pool.end();
  });

  const keylessAcr = (name: string) => svc.create(user, { organizationId: org.id } as never, { provider: 'registry', name, baseUrl: 'matelottest.azurecr.io', auth: { type: 'azure_wif', tenantId: 'tenant-1', clientId: 'app-client-1' } } as never) as unknown as Promise<{ id: string }>;
  const row = async (id: string) => (await db.select().from(schema.integrations).where(eq(schema.integrations.id, id)))[0];

  it('DELETE removes the connection, its repositories and service links; images pulling through it → 409 listing them, force detaches', async () => {
    const [conn] = await db.insert(schema.integrations).values({ organizationId: org.id, scopeType: 'ORGANIZATION', scopeId: org.id, provider: 'git', authType: 'none', name: 'git demo', status: 'connected', externalAccountId: `git-${randomUUID()}`, settings: {} }).returning();
    const [repo] = await db.insert(schema.repositories).values({ integrationId: conn!.id, externalId: 'r1', fullName: 'acme/demo' } as typeof schema.repositories.$inferInsert).returning();
    await db.insert(schema.serviceRepositories).values({ serviceId: service.id, repositoryId: repo!.id } as typeof schema.serviceRepositories.$inferInsert);
    const [img] = await db.insert(schema.containerImages).values({ organizationId: org.id, serviceId: service.id, integrationId: conn!.id, name: 'matelottest.azurecr.io/demo' }).returning();

    await expect(svc.remove(user, conn!.id)).rejects.toMatchObject({ status: 409, response: { images: ['matelottest.azurecr.io/demo'] } });
    expect(await row(conn!.id)).toBeDefined(); // nothing removed on 409

    const out = await svc.remove(user, conn!.id, { force: true });
    expect(out).toMatchObject({ deleted: true, repositories: 1, imagesDetached: ['matelottest.azurecr.io/demo'] });
    expect(await row(conn!.id)).toBeUndefined();
    expect(await db.select().from(schema.repositories).where(eq(schema.repositories.id, repo!.id))).toHaveLength(0);
    expect(await db.select().from(schema.serviceRepositories).where(eq(schema.serviceRepositories.repositoryId, repo!.id))).toHaveLength(0);
    const [detached] = await db.select().from(schema.containerImages).where(eq(schema.containerImages.id, img!.id));
    expect(detached!.integrationId).toBeNull();
    expect(audits).toContain('integration.deleted');
  });

  it('DELETE without images removes the row outright (never leaves it disconnected)', async () => {
    const c = await keylessAcr('to delete');
    expect(await svc.remove(user, c.id)).toMatchObject({ deleted: true, imagesDetached: [] });
    expect(await row(c.id)).toBeUndefined();
  });

  it('disconnect keeps the row; a disconnected keyless identity shows real values and the disconnected state', async () => {
    const c = await keylessAcr('to disconnect');
    const after = await svc.disconnect(user, c.id);
    expect(after).toMatchObject({ status: 'disconnected' });
    const r = await row(c.id);
    expect(r!.credentialsEncrypted).toBeNull();
    expect(r!.settings).toMatchObject({ keylessParams: { tenantId: 'tenant-1', clientId: 'app-client-1' } });
    expect(r!.settings.pendingReason).toBeUndefined();
    const identity = await svc.identityFor(user, c.id, 'https://matelot.example');
    expect(identity).toMatchObject({ disconnected: true, status: 'disconnected', params: { clientId: 'app-client-1' } });
    expect(identity.azure.steps.join('\n')).toContain('app-client-1');
    expect(identity.azure.steps.join('\n')).not.toContain('CLIENT_ID');
  });

  it('verify clears pendingReason; the first successful sync makes it connected; unverified / disconnected never become connected', async () => {
    const c = await keylessAcr('lifecycle');
    expect((await row(c.id))!.settings.pendingReason).toBeTruthy();
    // unverified keyless: a "successful use" must not flip it
    await sourceSync.markHealthy(c.id);
    expect((await row(c.id))!.status).toBe('pending');

    // verify (the probe itself is covered by keyless-verify.spec; here the cloud accepts)
    jest.spyOn(sourceSync, 'probe').mockResolvedValueOnce('matelottest.azurecr.io (keyless · app app-client-1 federated credential)');
    await svc.verify(user, c.id);
    let r = await row(c.id);
    expect(r!.settings).toMatchObject({ verified: true });
    expect(r!.settings.pendingReason).toBeUndefined();
    expect(r!.status).toBe('pending');

    // the first successful sync (source sync or image sync both call markHealthy)
    expect(await sourceSync.sync(c.id)).toEqual({ upserted: 0, removed: 0 });
    r = await row(c.id);
    expect(r!.status).toBe('connected');
    expect(r!.lastSyncedAt).not.toBeNull();
    expect(r!.lastError).toBeNull();

    await svc.disconnect(user, c.id);
    await sourceSync.markHealthy(c.id);
    expect((await row(c.id))!.status).toBe('disconnected');
  });
});

describe('cloud error messages', () => {
  it('Entra AADSTS70025 (real string): Trace ID, Correlation ID and Timestamp removed whole, ends at the last sentence', () => {
    const description = "AADSTS70025: The client 'X'(matelot-acr-keyless) has no configured federated identity credentials. Trace ID: 4e4eaefc-1111-2222-3333-444455556666 Correlation ID: cf7e9014-f9bd-4504-bfc3-7dbd86d2f9a1 Timestamp: 2026-10-07 10:41:52Z";
    const expected = "invalid_client: AADSTS70025: The client 'X'(matelot-acr-keyless) has no configured federated identity credentials.";
    expect(cloudError(JSON.stringify({ error: 'invalid_client', error_description: description }))).toBe(expected);
    // any order of the diagnostics, and fractional timestamps
    const shuffled = "AADSTS70025: The client 'X'(matelot-acr-keyless) has no configured federated identity credentials. Timestamp: 2026-10-07 10:41:52.1234567Z Correlation ID: cf7e9014-f9bd-4504-bfc3-7dbd86d2f9a1 Trace ID: 4e4eaefc-1111-2222-3333-444455556666";
    expect(cloudError(JSON.stringify({ error: 'invalid_client', error_description: shuffled }))).toBe(expected);
    expect(cloudError(JSON.stringify({ error: 'invalid_client', error_description: description }))).not.toMatch(/orrelation|Trace|Timestamp|cf7e9014/);
  });

  it('Entra AADSTS700213: the "Check your federated identity credential…" hint stays whole (and the docs link is kept)', () => {
    const description = "AADSTS700213: No matching federated identity record found for presented assertion subject 'integration:6a1f0c2e-1d3b-4c5a-9e8f-0a1b2c3d4e5f'. Check your federated identity credential Subject, Audience and Issuer against the presented assertion. https://learn.microsoft.com/entra/workload-id/workload-identity-federation Trace ID: 0a0b0c0d-1111-2222-3333-444455556666 Correlation ID: 1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d Timestamp: 2026-10-07 10:52:03Z";
    expect(cloudError(JSON.stringify({ error: 'invalid_client', error_description: description }))).toBe(
      "invalid_client: AADSTS700213: No matching federated identity record found for presented assertion subject 'integration:6a1f0c2e-1d3b-4c5a-9e8f-0a1b2c3d4e5f'. Check your federated identity credential Subject, Audience and Issuer against the presented assertion. https://learn.microsoft.com/entra/workload-id/workload-identity-federation",
    );
    const noLink = description.replace(/ https:\S+/, '');
    expect(cloudError(JSON.stringify({ error: 'invalid_client', error_description: noLink }))).toMatch(/Check your federated identity credential Subject, Audience and Issuer against the presented assertion\.$/);
  });

  it('a subject guid that is not a diagnostic stays; text without a sentence end is untouched', () => {
    expect(cloudError(JSON.stringify({ error: 'x', error_description: "subject 'integration:cf7e9014-f9bd-4504-bfc3-7dbd86d2f9a1' rejected." }))).toBe("x: subject 'integration:cf7e9014-f9bd-4504-bfc3-7dbd86d2f9a1' rejected.");
    expect(cloudError('<Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error>')).toBe('AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity');
    // a meaningful trailing clause without a full stop is not a fragment
    expect(cloudError(JSON.stringify({ error: 'invalid_request', error_description: 'AADSTS50027: Invalid JWT token. Expected audience api://AzureADTokenExchange' }))).toBe('invalid_request: AADSTS50027: Invalid JWT token. Expected audience api://AzureADTokenExchange');
    // a leftover label fragment after the last sentence is dropped
    expect(cloudError(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS70025: no credentials. orrelation ID: cf7e9014' }))).toBe('invalid_client: AADSTS70025: no credentials.');
  });

  it('Entra: error + description, trace/correlation ids and timestamp dropped, hint kept whole', () => {
    const body = JSON.stringify({
      error: 'invalid_client',
      error_description: "AADSTS700213: No matching federated identity record found for presented assertion subject 'integration:6a1f0c2e-1d3b-4c5a-9e8f-0a1b2c3d4e5f'. Check your federated identity credential Subject, Audience and Issuer against the presented assertion. https://learn.microsoft.com/entra/workload-id/workload-identity-federation Trace ID: 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e00 Correlation ID: 9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0 Timestamp: 2026-10-07 08:41:12Z",
      error_codes: [700213], trace_id: '3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e00', correlation_id: '9f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0',
    });
    const out = cloudError(body);
    expect(out).toMatch(/^invalid_client: AADSTS700213: No matching federated identity record/);
    expect(out).toContain('Check your federated identity credential Subject, Audience and Issuer');
    expect(out).not.toMatch(/Trace ID|Correlation ID|Timestamp/);
    expect(out.length).toBeLessThanOrEqual(500);
  });

  it('AWS XML: Code + Message', () => {
    expect(cloudError('<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error><RequestId>1f2e3d4c-aaaa-bbbb-cccc-1234567890ab</RequestId></ErrorResponse>'))
      .toBe('AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity');
  });

  it('Google APIs, ECR JSON and registry errors', () => {
    expect(cloudError(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: "Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist)." } }))).toBe("PERMISSION_DENIED: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).");
    expect(cloudError(JSON.stringify({ __type: 'com.amazonaws.ecr#AccessDeniedException', message: 'User is not authorized to perform ecr:GetAuthorizationToken' }))).toBe('AccessDeniedException: User is not authorized to perform ecr:GetAuthorizationToken');
    expect(cloudError(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }))).toBe('UNAUTHORIZED: authentication required');
    expect(cloudError('plain text')).toBe('plain text');
  });

  it('long messages are cut at a word boundary near 500 chars', () => {
    const out = cloudError(JSON.stringify({ error: 'x', error_description: 'word '.repeat(300) }));
    expect(out.length).toBeLessThanOrEqual(501);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/wor…$/);
  });
});
