import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { digestOfRef, environmentsBySbom, imageDigestFromDocument, releaseImage, releaseSbomIds, resolveRunningSboms } from './running-sbom';

const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'d508a19f'.padEnd(64, '0')}`;

describe('imageDigestFromDocument', () => {
  it('reads Syft JSON source.version (the audit document shape)', () => {
    expect(imageDigestFromDocument({ source: { type: 'image', name: 'localhost:5000/x/demo/dev', version: NEW, metadata: { userInput: `localhost:5000/x/demo/dev@${NEW}` } } })).toBe(NEW);
  });
  it('reads CycloneDX metadata.component.version', () => {
    expect(imageDigestFromDocument({ bomFormat: 'CycloneDX', metadata: { component: { type: 'container', name: 'demo', version: NEW.toUpperCase().replace('SHA256', 'sha256') } } })).toBe(NEW);
  });
  it('returns null when the document does not name a digest', () => {
    expect(imageDigestFromDocument({ bomFormat: 'CycloneDX', metadata: { component: { type: 'application', name: 'demo', version: '1.2.3' } } })).toBeNull();
  });
  it('digestOfRef only trusts @sha256 refs', () => {
    expect(digestOfRef(`docker.io/acme/demo@${NEW}`)).toBe(NEW);
    expect(digestOfRef('docker.io/acme/demo:test')).toBeNull();
  });
});

/**
 * Audit scenario (P1): one digest runs in every environment; the Docker Hub tag `test` MOVED from an old vulnerable
 * digest (whose SBOM stays linked to the tag row) to the new one; prod runs the same digest from ECR whose tag row
 * never got its own SBOM. Every environment must resolve to the SBOM of the NEW digest.
 * Runs against a migrated database: TEST_DATABASE_URL=postgres://… pnpm test running-sbom
 */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('resolveRunningSboms (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: Record<string, string> = {};
  afterAll(async () => {
    if (ids.org) {
      for (const t of [schema.deployments, schema.sboms, schema.containerImages, schema.releases] as const) await db.delete(t).where(eq(t.organizationId, ids.org)).catch(() => undefined);
      if (ids.svc) await db.delete(schema.services).where(eq(schema.services.id, ids.svc)).catch(() => undefined);
      await db.delete(schema.organizations).where(eq(schema.organizations.id, ids.org)).catch(() => undefined);
    }
    await pool.end();
  });

  it('uses the digest each environment runs, never the stale SBOM of a moved tag', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `t-${s}`, name: `t-${s}` }).returning(); ids.org = org!.id;
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning(); ids.svc = svc!.id;
    const env = async (slug: string, kind: 'development' | 'testing' | 'production') => (await db.insert(schema.environments).values({ serviceId: svc!.id, slug, name: slug, kind }).returning())[0]!;
    const dev = await env('dev', 'development'); const test = await env('test', 'testing'); const prod = await env('prod', 'production');
    const img = async (name: string) => (await db.insert(schema.containerImages).values({ organizationId: org!.id, serviceId: svc!.id, name }).returning())[0]!;
    const builtin = await img('localhost:5000/w/t/p/demo'); const hub = await img('docker.io/acme/demo'); const ecr = await img('1.dkr.ecr.eu-central-1.amazonaws.com/demo');
    const tag = async (imageId: string, t: string, digest: string) => (await db.insert(schema.imageTags).values({ imageId, tag: t, digest }).returning())[0]!;
    const buildTag = await tag(builtin.id, 'sha-07f11b7', NEW);
    const hubTest = await tag(hub.id, 'test', NEW);            // moved: was OLD when its SBOM was made
    const ecrProd = await tag(ecr.id, 'prod', NEW);            // never scanned under this tag
    const sbom = async (imageTagId: string, imageDigest: string) => (await db.insert(schema.sboms).values({ organizationId: org!.id, serviceId: svc!.id, imageTagId, imageDigest, source: 'runner', target: 'image', targetRef: 'x', format: 'cyclonedx', componentCount: 0, digest: randomUUID(), rawGz: Buffer.from('') } as typeof schema.sboms.$inferInsert).returning())[0]!;
    const stale = await sbom(hubTest.id, OLD);                  // linked to the moved tag row
    const current = await sbom(buildTag.id, NEW);
    const dep = (environmentId: string, imageTagId: string, imageRef: string) => db.insert(schema.deployments).values({ organizationId: org!.id, serviceId: svc!.id, environmentId, imageTagId, imageRef } as typeof schema.deployments.$inferInsert);
    await dep(dev.id, buildTag.id, `localhost:5000/w/t/p/demo/dev@${NEW}`);
    await dep(test.id, hubTest.id, `docker.io/acme/demo@${NEW}`);
    await dep(prod.id, ecrProd.id, `1.dkr.ecr.eu-central-1.amazonaws.com/demo@${NEW}`);

    const running = await resolveRunningSboms(db as never, { serviceIds: [svc!.id] });
    expect(running).toHaveLength(3);
    for (const r of running) { expect(r.sbomId).toBe(current.id); expect(r.via).toBe('digest'); expect(r.digest).toBe(NEW); }
    expect(environmentsBySbom(running).get(stale.id)).toBeUndefined();
    const prodOnly = await resolveRunningSboms(db as never, { serviceIds: [svc!.id], environmentKinds: ['production'] });
    expect(prodOnly.map((r) => r.environmentName)).toEqual(['prod']);

    // Evidence / VEX of release 1.0.9 (audit #1): the moved `test` tag is even linked to the release, yet its old-digest
    // SBOM must not be part of the release; only SBOMs of the digest the release's deployments recorded.
    const [rel] = await db.insert(schema.releases).values({ organizationId: org!.id, serviceId: svc!.id, version: '1.0.9', source: 'api' } as typeof schema.releases.$inferInsert).returning();
    await db.update(schema.imageTags).set({ releaseId: rel!.id }).where(eq(schema.imageTags.id, hubTest.id));
    await db.update(schema.deployments).set({ releaseId: rel!.id }).where(eq(schema.deployments.environmentId, prod.id));
    const image = await releaseImage(db as never, rel!.id);
    expect(image.digests).toEqual([NEW]);
    expect(image.productRef).toBe('1.dkr.ecr.eu-central-1.amazonaws.com/demo');
    expect(await releaseSbomIds(db as never, svc!.id, rel!.id, image.digests)).toEqual([current.id]);
  });
});
