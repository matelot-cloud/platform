import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { correlationGateViolation } from '../policies/policies.service';
import { CorrelationService } from './correlation.service';

const url = process.env.TEST_DATABASE_URL;

describe('gate on an uncorrelated SBOM does not pass', () => {
  it('pending and failed block; done does not', () => {
    expect(correlationGateViolation('pending', null)).toMatchObject({ action: 'block', rule: 'correlated_sbom' });
    expect(correlationGateViolation('failed', 'OSV 503')?.message).toContain('OSV 503');
    expect(correlationGateViolation('done', null)).toBeNull();
    expect(correlationGateViolation(null, null)).toBeNull();
  });
});

describe('NVD lookup that hangs times out', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; delete process.env.ADVISORY_FETCH_TIMEOUT_MS; jest.resetModules(); });
  it('rejects within the fetch timeout instead of blocking', async () => {
    process.env.ADVISORY_FETCH_TIMEOUT_MS = '80';
    jest.resetModules(); // the timeout is read at module load
    global.fetch = ((_: string, init?: { signal?: AbortSignal }) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)))) as typeof fetch;
    const { HttpAdvisorySource } = await import('./advisory-source');
    const src = new (HttpAdvisorySource as unknown as new () => { nvdCvss(c: string): Promise<unknown> })();
    const t0 = Date.now();
    await expect(src.nvdCvss('CVE-2026-1')).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

(url ? describe : describe.skip)('correlation queue (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  const slow = { ms: 0 };
  const source = {
    queryBatch: async () => { if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms)); return [] as string[][]; },
    vulnerability: async () => null, epss: async () => new Map(), kev: async () => new Map(),
  };
  const svc = new CorrelationService(db as never, source as never, { record: async () => undefined } as never, { snapshotToday: async () => undefined } as never);
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  async function seedService() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `c-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [service] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    return { org: org!, service: service! };
  }

  it('a new SBOM whose components were all checked recently still gets its findings linked', async () => {
    const { org, service } = await seedService();
    const purl = `pkg:npm/lodash@4.17.20?t=${randomUUID().slice(0, 6)}`;
    const [comp] = await db.insert(schema.components).values({ purl, type: 'npm', name: 'lodash', version: '4.17.20' } as typeof schema.components.$inferInsert).returning();
    const advId = `GHSA-test-${randomUUID().slice(0, 8)}`;
    await db.insert(schema.advisories).values({ id: advId, aliases: [], summary: 'test', severity: 'high', cvssScore: 7.5, affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] } as typeof schema.advisories.$inferInsert);
    await db.insert(schema.componentChecks).values({ componentId: comp!.id, checkedAt: new Date(), advisoryIds: [advId] }); // cached: no OSV query needed
    const [sbom] = await db.insert(schema.sboms).values({ organizationId: org.id, serviceId: service.id, source: 'runner', target: 'source', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from('') } as typeof schema.sboms.$inferInsert).returning();
    await db.insert(schema.sbomComponents).values({ sbomId: sbom!.id, componentId: comp!.id } as typeof schema.sbomComponents.$inferInsert);

    const job = await svc.wait(svc.request({ serviceId: service.id }));
    expect(job.status).toBe('done');
    expect(job.result?.checked).toBe(0);              // nothing asked of OSV…
    const links = await db.select().from(schema.findingSboms).where(eq(schema.findingSboms.sbomId, sbom!.id));
    expect(links).toHaveLength(1);                     // …yet the SBOM's finding is linked
    const [row] = await db.select({ st: schema.sboms.correlationStatus }).from(schema.sboms).where(eq(schema.sboms.id, sbom!.id));
    expect(row!.st).toBe('done');
    // #1: nothing deploys this SBOM, so its finding stays open but is NOT running (excluded from totals / map / risk)
    const [f] = await db.select({ running: schema.findings.running, status: schema.findings.status }).from(schema.findings).where(eq(schema.findings.id, links[0]!.findingId));
    expect(f).toEqual({ running: false, status: 'open' });
  }, 20_000);

  it('GHSA + PYSEC records of the same CVE on one component → ONE finding, counted once', async () => {
    const { org, service } = await seedService();
    const tag = randomUUID().slice(0, 6);
    const [comp] = await db.insert(schema.components).values({ purl: `pkg:pypi/pip@25.0.1?t=${tag}`, type: 'pypi', name: 'pip', version: '25.0.1' } as typeof schema.components.$inferInsert).returning();
    const ghsa = `GHSA-dup-${tag}`; const pysec = `PYSEC-dup-${tag}`; const cve = `CVE-2026-${tag.replace(/\D/g, '').padEnd(4, '7').slice(0, 4)}`;
    const aff = [{ package: { ecosystem: 'PyPI', name: 'pip' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '25.1' }] }] }];
    await db.insert(schema.advisories).values([
      { id: ghsa, aliases: [cve], canonicalId: cve, severity: 'high', cvssScore: 7.5, affected: aff },
      { id: pysec, aliases: [cve, ghsa], canonicalId: cve, severity: 'medium', cvssScore: 5.3, affected: aff },
    ] as typeof schema.advisories.$inferInsert[]);
    await db.insert(schema.componentChecks).values({ componentId: comp!.id, checkedAt: new Date(), advisoryIds: [ghsa, pysec] });
    const [sbom] = await db.insert(schema.sboms).values({ organizationId: org.id, serviceId: service.id, source: 'runner', target: 'source', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from('') } as typeof schema.sboms.$inferInsert).returning();
    await db.insert(schema.sbomComponents).values({ sbomId: sbom!.id, componentId: comp!.id } as typeof schema.sbomComponents.$inferInsert);
    // first run creates one finding per record (simulating data from before canonicalisation): two findings exist…
    const [dupFinding] = await db.insert(schema.findings).values({ organizationId: org.id, serviceId: service.id, componentId: comp!.id, advisoryId: pysec, severity: 'medium', status: 'open', packageKey: 'pypi/pip' } as typeof schema.findings.$inferInsert).returning();
    await db.insert(schema.findingSboms).values({ findingId: dupFinding!.id, sbomId: sbom!.id });
    // …and a remediation references the duplicate (finding_ids is text[])
    const [rem] = await db.insert(schema.remediations).values({ organizationId: org.id, serviceId: service.id, kind: 'vulnerability', matchId: cve, title: 'pip: ' + cve, severity: 'medium', status: 'open', findingIds: [dupFinding!.id] } as typeof schema.remediations.$inferInsert).returning();
    const job = await svc.wait(svc.request({ serviceId: service.id }));
    expect(job.status).toBe('done');   // bookkeeping never aborts the run
    const fs = await db.select({ id: schema.findings.id, advisoryId: schema.findings.advisoryId, canonicalId: schema.findings.canonicalId, severity: schema.findings.severity }).from(schema.findings).where(eq(schema.findings.serviceId, service.id));
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ advisoryId: ghsa, canonicalId: cve, severity: 'high' });   // the stronger record is kept
    const [r] = await db.select({ findingIds: schema.remediations.findingIds }).from(schema.remediations).where(eq(schema.remediations.id, rem!.id));
    expect(r!.findingIds).toEqual([fs[0]!.id]);                                              // re-pointed to the kept finding
    const [st] = await db.select({ st: schema.sboms.correlationStatus }).from(schema.sboms).where(eq(schema.sboms.id, sbom!.id));
    expect(st!.st).toBe('done');
  }, 20_000);

  it('failed SBOMs are retried automatically with backoff; a gate retries at once', async () => {
    const a = await seedService();
    const mk = async (status: 'pending' | 'failed', next: Date | null, attempts = 0, ageMs = 0) => (await db.insert(schema.sboms).values({ organizationId: a.org.id, serviceId: a.service.id, source: 'runner', target: 'image', targetRef: 'x', format: 'cyclonedx', componentCount: 0, digest: randomUUID(), rawGz: Buffer.from(''), correlationStatus: status, correlationNextRetryAt: next, correlationAttempts: attempts, createdAt: new Date(Date.now() - ageMs) } as typeof schema.sboms.$inferInsert).returning())[0]!;
    const requeued = svc as unknown as { requeuePendingSboms(): Promise<number> };
    const due = await mk('failed', new Date(Date.now() - 1000), 2);
    expect(await requeued.requeuePendingSboms()).toBeGreaterThanOrEqual(1);   // due for retry → requested
    await svc.wait(svc.request({ serviceId: a.service.id }));                   // the retry run marks it done
    expect((await db.select({ st: schema.sboms.correlationStatus, n: schema.sboms.correlationAttempts }).from(schema.sboms).where(eq(schema.sboms.id, due.id)))[0]).toEqual({ st: 'done', n: 0 });
    const notYet = await mk('failed', new Date(Date.now() + 3600_000), 3);     // backoff not elapsed → not requested
    expect(await requeued.requeuePendingSboms()).toBe(0);
    // a gate on the failed SBOM flips it to pending with an immediate retry
    const { PoliciesService } = await import('../policies/policies.service');
    const pol = new (PoliciesService as unknown as new (...x: unknown[]) => { awaitCorrelation(id: string, ms: number): Promise<{ status: string }> })(db);
    await pol.awaitCorrelation(notYet.id, 100);
    const [row] = await db.select({ st: schema.sboms.correlationStatus, next: schema.sboms.correlationNextRetryAt }).from(schema.sboms).where(eq(schema.sboms.id, notYet.id));
    expect(row!.st).toBe('pending');
    expect(row!.next!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await requeued.requeuePendingSboms()).toBe(1);
  }, 20_000);

  it('a request while a run is in progress is queued (not dropped) and executed', async () => {
    const a = await seedService(); const b = await seedService();
    // service A has an unchecked component, so its run must ask OSV (slow); B's request arrives meanwhile
    const [comp] = await db.insert(schema.components).values({ purl: `pkg:npm/left-pad@1.0.0?t=${randomUUID().slice(0, 6)}`, type: 'npm', name: 'left-pad', version: '1.0.0' } as typeof schema.components.$inferInsert).returning();
    const [sbom] = await db.insert(schema.sboms).values({ organizationId: a.org.id, serviceId: a.service.id, source: 'runner', target: 'source', targetRef: 'x', format: 'cyclonedx', componentCount: 1, digest: randomUUID(), rawGz: Buffer.from('') } as typeof schema.sboms.$inferInsert).returning();
    await db.insert(schema.sbomComponents).values({ sbomId: sbom!.id, componentId: comp!.id } as typeof schema.sbomComponents.$inferInsert);
    slow.ms = 600;
    const jobA = svc.request({ serviceId: a.service.id, force: true });
    await new Promise((r) => setTimeout(r, 50));
    const jobB = svc.request({ serviceId: b.service.id });
    expect(jobA.status).toBe('running');
    expect(jobB.status).toBe('queued');
    expect(jobB.position).toBeGreaterThanOrEqual(0);
    expect(svc.request({ serviceId: b.service.id })).toBe(jobB); // merged, not duplicated
    await svc.wait(jobA); await svc.wait(jobB);
    slow.ms = 0;
    expect(jobA.status).toBe('done');
    expect(jobB.status).toBe('done');
    expect(svc.job(jobB.id)?.status).toBe('done');
    void and;
  }, 20_000);
});

(url ? describe : describe.skip)('gate waits for SBOM correlation (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  afterAll(async () => { for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });
  async function seed(status: 'pending' | 'failed') {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `g-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [sbom] = await db.insert(schema.sboms).values({ organizationId: org!.id, serviceId: svc!.id, source: 'runner', target: 'image', targetRef: 'x', format: 'cyclonedx', componentCount: 0, digest: randomUUID(), rawGz: Buffer.from(''), correlationStatus: status, correlationError: status === 'failed' ? 'OSV 503' : null } as typeof schema.sboms.$inferInsert).returning();
    return sbom!.id;
  }
  it('resolves as soon as correlation finishes, within the timeout', async () => {
    const { PoliciesService } = await import('../policies/policies.service');
    const svc = new (PoliciesService as unknown as new (...a: unknown[]) => { awaitCorrelation(id: string, ms: number): Promise<{ status: string; waitedMs: number }> })(db);
    const sbomId = await seed('pending');
    setTimeout(() => { void db.update(schema.sboms).set({ correlationStatus: 'done' }).where(eq(schema.sboms.id, sbomId)).execute(); }, 400);
    const r = await svc.awaitCorrelation(sbomId, 10_000);
    expect(r.status).toBe('done');
    expect(r.waitedMs).toBeGreaterThanOrEqual(350);
    expect(r.waitedMs).toBeLessThan(5_000);
  }, 15_000);
  it('an SBOM from before correlation tracking (no row / null status) counts as done — gates never wait on old images', async () => {
    const { PoliciesService } = await import('../policies/policies.service');
    const svc = new (PoliciesService as unknown as new (...a: unknown[]) => { awaitCorrelation(id: string, ms: number): Promise<{ status: string; waitedMs: number }> })(db);
    const t0 = Date.now();
    const r = await svc.awaitCorrelation(randomUUID(), 5_000);   // unknown id behaves like a legacy row
    expect(r.status).toBe('done');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('migration 0034 backfill: an older pending SBOM becomes done, a fresh one stays pending', async () => {
    const old = await seed('pending'); const fresh = await seed('pending');
    await db.update(schema.sboms).set({ createdAt: new Date(Date.now() - 3600_000) } as never).where(eq(schema.sboms.id, old)).execute();
    await db.execute(sql.raw(`UPDATE "sboms" SET "correlation_status" = 'done', "correlated_at" = coalesce("correlated_at", "created_at") WHERE "correlation_status" = 'pending' AND "created_at" < now() - interval '10 minutes'`));
    const rows = await db.select({ id: schema.sboms.id, st: schema.sboms.correlationStatus }).from(schema.sboms).where(inArray(schema.sboms.id, [old, fresh]));
    expect(rows.find((r) => r.id === old)?.st).toBe('done');
    expect(rows.find((r) => r.id === fresh)?.st).toBe('pending');
  });
  it('a failed correlation is reported immediately; a pending one at the timeout', async () => {
    const { PoliciesService } = await import('../policies/policies.service');
    const svc = new (PoliciesService as unknown as new (...a: unknown[]) => { awaitCorrelation(id: string, ms: number): Promise<{ status: string; error: string | null; waitedMs: number }> })(db);
    expect(await svc.awaitCorrelation(await seed('failed'), 0)).toMatchObject({ status: 'failed', error: 'OSV 503' });        // evaluate-now: reported as failed
    const retried = await svc.awaitCorrelation(await seed('failed'), 300);                                                     // a waiting gate retries: pending until the run happens
    expect(retried.status).toBe('pending');
    const r = await svc.awaitCorrelation(await seed('pending'), 300);
    expect(r.status).toBe('pending');
    expect(r.waitedMs).toBeGreaterThanOrEqual(300);
  }, 15_000);
});
