import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { InventoryService } from './inventory.service';

const url = process.env.TEST_DATABASE_URL;
const D = `sha256:${'80db9bcc'.padEnd(64, '0')}`;

/** #1: a preprod (ACR) deployment attached to Docker Hub's same-digest `test` row gets a tag row in the ACR image. */
(url ? describe : describe.skip)('deployments never borrow a tag row of another registry', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('backfill re-points the deployment to its own registry image', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `r-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [env] = await db.insert(schema.environments).values({ serviceId: svc!.id, slug: 'preprod', name: 'preprod', kind: 'production' }).returning();
    const [hub] = await db.insert(schema.containerImages).values({ organizationId: org!.id, serviceId: svc!.id, name: 'docker.io/acme/demo' }).returning();
    const [hubTest] = await db.insert(schema.imageTags).values({ imageId: hub!.id, tag: 'test', digest: D }).returning();
    const [dep] = await db.insert(schema.deployments).values({ organizationId: org!.id, serviceId: svc!.id, environmentId: env!.id, imageTagId: hubTest!.id, imageRef: `matelottest.azurecr.io/demo-service:preprod@${D}` } as typeof schema.deployments.$inferInsert).returning();

    const inv = Object.create(InventoryService.prototype) as { repointBorrowedDeployments(): Promise<number> };
    Object.assign(inv, { db, logger: { log: () => undefined, warn: () => undefined } });
    expect(await inv.repointBorrowedDeployments()).toBe(1);

    const [after] = await db.select({ imageTagId: schema.deployments.imageTagId }).from(schema.deployments).where(eq(schema.deployments.id, dep!.id));
    expect(after!.imageTagId).not.toBe(hubTest!.id);
    const [row] = await db.select({ tag: schema.imageTags.tag, digest: schema.imageTags.digest, image: schema.containerImages.name }).from(schema.imageTags).innerJoin(schema.containerImages, eq(schema.imageTags.imageId, schema.containerImages.id)).where(eq(schema.imageTags.id, after!.imageTagId!));
    expect(row).toEqual({ tag: 'preprod', digest: D, image: 'matelottest.azurecr.io/demo-service' });
    expect(await inv.repointBorrowedDeployments()).toBe(0); // idempotent
  });
});

(url ? describe : describe.skip)('digest placeholders are replaced by the real tag after a registry sync', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('preprod moves from sha256-02e9c557c2fb to the real tag (version-like preferred)', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `h-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [env] = await db.insert(schema.environments).values({ serviceId: svc!.id, slug: 'preprod', name: 'preprod', kind: 'production' }).returning();
    const [acr] = await db.insert(schema.containerImages).values({ organizationId: org!.id, serviceId: svc!.id, name: 'matelottest.azurecr.io/demo-service' }).returning();
    const dg = `sha256:${'02e9c557c2fb'.padEnd(64, '0')}`;
    const [ph] = await db.insert(schema.imageTags).values({ imageId: acr!.id, tag: 'sha256-02e9c557c2fb', digest: dg }).returning();
    const [dep] = await db.insert(schema.deployments).values({ organizationId: org!.id, serviceId: svc!.id, environmentId: env!.id, imageTagId: ph!.id, imageRef: `${acr!.name}@${dg}` } as typeof schema.deployments.$inferInsert).returning();
    await db.insert(schema.imageTags).values([{ imageId: acr!.id, tag: 'preprod', digest: dg }, { imageId: acr!.id, tag: '1.0.25', digest: dg }]);  // the sync brings the real tags
    const inv = Object.create(InventoryService.prototype) as { replaceDigestPlaceholders(id: string): Promise<number> };
    Object.assign(inv, { db });
    expect(await inv.replaceDigestPlaceholders(acr!.id)).toBe(1);
    const [after] = await db.select({ tag: schema.imageTags.tag }).from(schema.deployments).innerJoin(schema.imageTags, eq(schema.deployments.imageTagId, schema.imageTags.id)).where(eq(schema.deployments.id, dep!.id));
    expect(after!.tag).toBe('1.0.25');
    expect((await db.select().from(schema.imageTags).where(eq(schema.imageTags.imageId, acr!.id))).map((t) => t.tag).sort()).toEqual(['1.0.25', 'preprod']);
  });
});

describe('release identity comes from version/commit tags only', () => {
  it('isReleaseTag', () => {
    for (const t of ['1.0.25', 'v2.1.0-rc1', 'sha-07f11b7', '07f11b7a9c2d', '07f11b7-prod']) expect(InventoryService.isReleaseTag(t)).toBe(true);
    for (const t of ['preprod', 'prod', 'latest', 'sha256-02e9c557c2fb', 'main']) expect(InventoryService.isReleaseTag(t)).toBe(false);
  });
});

(url ? describe : describe.skip)('inventory view: env tags attributed by digest, no false rebuilt_commit, orphan placeholders removed', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('ACR preprod on the 1.0.24 digest shows release 1.0.24, and 1.0.25 is not rebuilt', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `iv-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    await db.insert(schema.environments).values({ serviceId: svc!.id, slug: 'preprod', name: 'preprod', kind: 'production' });
    const [r24] = await db.insert(schema.releases).values({ organizationId: org!.id, serviceId: svc!.id, version: '1.0.24', source: 'api' } as typeof schema.releases.$inferInsert).returning();
    const [r25] = await db.insert(schema.releases).values({ organizationId: org!.id, serviceId: svc!.id, version: '1.0.25', source: 'api' } as typeof schema.releases.$inferInsert).returning();
    const D24 = `sha256:${'24'.padEnd(64, '0')}`; const D25 = `sha256:${'25'.padEnd(64, '0')}`;
    const [acr] = await db.insert(schema.containerImages).values({ organizationId: org!.id, serviceId: svc!.id, name: 'matelottest.azurecr.io/demo-service' }).returning();
    const [hub] = await db.insert(schema.containerImages).values({ organizationId: org!.id, serviceId: svc!.id, name: 'docker.io/acme/demo' }).returning();
    await db.insert(schema.imageTags).values([
      { imageId: acr!.id, tag: '1.0.24', digest: D24, releaseId: r24!.id }, { imageId: acr!.id, tag: '1.0.25', digest: D25, releaseId: r25!.id },
      { imageId: acr!.id, tag: 'preprod', digest: D24, releaseId: r25!.id },  // stale persisted link (the bug): env tag bound to 1.0.25 while pointing at 1.0.24
      { imageId: hub!.id, tag: '1.0.25', digest: D25, releaseId: r25!.id },
      { imageId: acr!.id, tag: 'sha256-ab12cd34ef56', digest: `sha256:${'ab12cd34ef56'.padEnd(64, '0')}` },   // orphan placeholder
    ]);
    const inv = Object.create(InventoryService.prototype) as { serviceOverview(id: string): Promise<{ images: { name: string; tags: { tag: string; releaseVersion: string | null; warnings: { code: string }[] }[] }[] }>; replaceDigestPlaceholders(id: string): Promise<number>; db: unknown; registry: unknown; logger: unknown };
    Object.assign(inv, { db, registry: { host: null }, logger: { log: () => undefined, warn: () => undefined } });
    const { images } = await inv.serviceOverview(svc!.id);
    const acrTags = images.find((i) => i.name.includes('azurecr'))!.tags;
    expect(acrTags.find((t) => t.tag === 'preprod')!.releaseVersion).toBe('1.0.24');                           // by digest, not the stale link
    expect(images.flatMap((i) => i.tags).filter((t) => t.tag === '1.0.25').every((t) => t.warnings.length === 0)).toBe(true);   // one digest → not rebuilt
    expect(images.flatMap((i) => i.tags).every((t) => Array.isArray(t.warnings))).toBe(true);                   // never null
    await inv.replaceDigestPlaceholders(acr!.id);
    expect((await db.select({ tag: schema.imageTags.tag }).from(schema.imageTags).where(eq(schema.imageTags.imageId, acr!.id))).map((t) => t.tag).sort()).toEqual(['1.0.24', '1.0.25', 'preprod']);
  }, 20_000);
});
