import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { PoliciesService } from './policies.service';
import { FindingsService } from '../vulnerabilities/findings.service';

const url = process.env.TEST_DATABASE_URL;
const D = (p: string) => `sha256:${p.padEnd(64, '0')}`;

/** Run #17 (2026-10-02 10:44Z): clean image 1.0.19 (digest 2a59…) refused with the critical of a sibling build of the same version. */
(url ? describe : describe.skip)('gate facts: an image subject is scored only by the SBOM of ITS digest', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const svc = new (PoliciesService as unknown as new (...a: unknown[]) => { facts(serviceId: string, subject: Record<string, unknown>, honour: boolean): Promise<{ sbomId: string | null; sbomDigest: string | null; evaluatedDigest: string | null; version: string | null; findings: Record<string, number> }> })(db);
  afterAll(async () => { for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  async function seed() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `f-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [service] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [env] = await db.insert(schema.environments).values({ serviceId: service!.id, slug: 'dev', name: 'dev', kind: 'development' }).returning();
    const [img] = await db.insert(schema.containerImages).values({ organizationId: org!.id, serviceId: service!.id, name: 'localhost:5000/w/t/p/demo' }).returning();
    const sbom = async (digest: string) => (await db.insert(schema.sboms).values({ organizationId: org!.id, serviceId: service!.id, imageDigest: digest, source: 'runner', target: 'image', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from(''), correlationStatus: 'done' } as typeof schema.sboms.$inferInsert).returning())[0]!;
    // the sibling build of 1.0.19 (paramiko 2.4.0, one open critical), deployed to dev as 1.0.19
    const dirty = await sbom(D('17'));
    const [comp] = await db.insert(schema.components).values({ purl: `pkg:pypi/paramiko@2.4.0?t=${s}`, type: 'pypi', name: 'paramiko', version: '2.4.0' } as typeof schema.components.$inferInsert).returning();
    const advId = `GHSA-crit-${s}`;
    await db.insert(schema.advisories).values({ id: advId, aliases: [], severity: 'critical', cvssScore: 9.8, affected: [] } as typeof schema.advisories.$inferInsert);
    const [finding] = await db.insert(schema.findings).values({ organizationId: org!.id, serviceId: service!.id, componentId: comp!.id, advisoryId: advId, severity: 'critical', status: 'open', packageKey: 'pypi/paramiko' } as typeof schema.findings.$inferInsert).returning();
    await db.insert(schema.findingSboms).values({ findingId: finding!.id, sbomId: dirty.id });
    const [rel] = await db.insert(schema.releases).values({ organizationId: org!.id, serviceId: service!.id, version: '1.0.19', source: 'api' } as typeof schema.releases.$inferInsert).returning();
    await db.insert(schema.deployments).values({ organizationId: org!.id, serviceId: service!.id, environmentId: env!.id, releaseId: rel!.id, imageRef: `${img!.name}@${D('17')}` } as typeof schema.deployments.$inferInsert);
    return { service: service!, img: img!, clean: await sbom(D('2a597390')) };
  }

  it('digest without an SBOM yet + same version as a dirty sibling → NO sbom (pending), never the sibling one', async () => {
    const { service, img } = await seed();
    const f = await svc.facts(service.id, { imageRef: `${img.name}@${D('19new')}`, version: '1.0.19' }, true);
    expect(f.sbomId).toBeNull();
    expect(f.evaluatedDigest).toBe(D('19new'));
    expect(f.findings.critical).toBe(0);
  });

  it('a clean SBOM is scored 0 critical although an older SBOM of the service has an open critical', async () => {
    const { service, img, clean } = await seed();
    const f = await svc.facts(service.id, { imageRef: `${img.name}@${D('2a597390')}`, version: '1.0.19' }, true);
    expect(f.sbomId).toBe(clean.id);
    expect(f.sbomDigest).toBe(D('2a597390'));
    expect(f.findings).toMatchObject({ critical: 0, high: 0 });
  });

  it('a version-only subject still uses the release fallback', async () => {
    const { service } = await seed();
    const f = await svc.facts(service.id, { version: '1.0.19' }, true);
    expect(f.sbomDigest).toBe(D('17'));
    expect(f.findings.critical).toBe(1);
  });
});

(url ? describe : describe.skip)('sbom findings: scoped by SBOM membership, not by service-level status', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });
  it('a service-level fixed paramiko finding is listed for the old SBOM that contains it', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `sf-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [old] = await db.insert(schema.sboms).values({ organizationId: org!.id, serviceId: svc!.id, imageDigest: `sha256:${'22'.padEnd(64, '0')}`, source: 'runner', target: 'image', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from(''), correlationStatus: 'done' } as typeof schema.sboms.$inferInsert).returning();
    const [comp] = await db.insert(schema.components).values({ purl: `pkg:pypi/paramiko@2.4.0?t=${s}`, type: 'pypi', name: 'paramiko', version: '2.4.0' } as typeof schema.components.$inferInsert).returning();
    const advId = `GHSA-232r-${s}`;
    await db.insert(schema.advisories).values({ id: advId, aliases: ['CVE-2018-7750'], canonicalId: 'CVE-2018-7750', severity: 'critical', cvssScore: 9.8, affected: [] } as typeof schema.advisories.$inferInsert);
    const [f] = await db.insert(schema.findings).values({ organizationId: org!.id, serviceId: svc!.id, componentId: comp!.id, advisoryId: advId, canonicalId: 'CVE-2018-7750', severity: 'critical', status: 'fixed', fixedVersion: '2.4.1', packageKey: 'pypi/paramiko' } as typeof schema.findings.$inferInsert).returning();
    await db.insert(schema.findingSboms).values({ findingId: f!.id, sbomId: old!.id });
    const fs = Object.create(FindingsService.prototype) as { listForSbom(u: unknown, id: string, st: string[]): Promise<{ id: string; status: string; inThisSbom: string }[]> };
    Object.assign(fs, { db });
    const rows = await fs.listForSbom(null, old!.id, ['open', 'accepted', 'false_positive', 'not_affected', 'fixed']);
    expect(rows.map((r) => [r.id, r.status, r.inThisSbom])).toEqual([[f!.id, 'fixed', 'affected — fixed in a later build']]);
  }, 20_000);
});
