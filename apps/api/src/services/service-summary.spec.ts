/**
 * GET /services/:id/summary against a real database — the two bugs of the rc.12 review:
 *  1. open vulnerabilities must be what the gate counts (the findings linked to the newest SBOM), not `findings.running`,
 *     which is false for every finding of a service that has no deployment yet ("0 open" next to "1 open critical");
 *  2. SAST findings re-ingested with the same fingerprint stay ONE open row across runs; a changed fingerprint opens a
 *     new row and closes the old one (1 open, 1 fixed), never N open after N runs.
 * Needs TEST_DATABASE_URL (skipped otherwise).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { AuditService } from '../audit/audit.service';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { buildChain } from '../rbac/scope.types';
import { CodeFindingsService } from '../vulnerabilities/code-findings.service';
import { ServicesService } from './services.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('service summary (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema }) as never as import('../database/database.module').Database;
  const audit = new AuditService(db);
  const services = new ServicesService(db, new AccessService(db), new AuthorizationService(), audit);
  const codeFindings = new CodeFindingsService(db, audit);
  const orgIds: string[] = [];
  afterAll(async () => {
    // structure rows do not cascade from the organization (archives, not deletes, in the product): remove bottom-up
    for (const id of orgIds) {
      const ws = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.organizationId, id));
      for (const w of ws) {
        const teams = await db.select({ id: schema.teams.id }).from(schema.teams).where(eq(schema.teams.workspaceId, w.id));
        for (const t of teams) {
          const projects = await db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.teamId, t.id));
          for (const p of projects) { await db.delete(schema.services).where(eq(schema.services.projectId, p.id)); await db.delete(schema.projects).where(eq(schema.projects.id, p.id)); }
          await db.delete(schema.teams).where(eq(schema.teams.id, t.id));
        }
        await db.delete(schema.workspaces).where(eq(schema.workspaces.id, w.id));
      }
      await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined);
    }
    await pool.end();
  });

  async function fixture() {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `sum-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo-app', name: 'demo-app' }).returning();
    const chain = buildChain({ organizationId: org!.id, workspaceId: ws!.id, teamId: team!.id, projectId: proj!.id, serviceId: svc!.id });
    return { org: org!, proj: proj!, svc: svc!, chain, s };
  }

  it('counts the open vulnerabilities of the newest SBOM like the gate, even when nothing is deployed (running = false)', async () => {
    const { org, svc, chain, s } = await fixture();
    const [sbom] = await db.insert(schema.sboms).values({ organizationId: org.id, serviceId: svc.id, source: 'runner', target: 'source', targetRef: 'main', format: 'cyclonedx', digest: `sha256:${s}`, componentCount: 2, rawGz: Buffer.from('') } as typeof schema.sboms.$inferInsert).returning();
    const [comp] = await db.insert(schema.components).values({ purl: `pkg:pypi/demo-${s}@1.0`, type: 'pypi', name: `demo-${s}`, version: '1.0' }).returning();
    const [comp2] = await db.insert(schema.components).values({ purl: `pkg:pypi/other-${s}@1.0`, type: 'pypi', name: `other-${s}`, version: '1.0' }).returning();
    await db.insert(schema.advisories).values([{ id: `CVE-2026-${s}`, severity: 'critical', kev: true }, { id: `GHSA-${s}`, severity: 'high' }] as typeof schema.advisories.$inferInsert[]).onConflictDoNothing();
    const rows = await db.insert(schema.findings).values([
      { organizationId: org.id, serviceId: svc.id, componentId: comp!.id, advisoryId: `CVE-2026-${s}`, severity: 'critical', status: 'open', running: false },
      { organizationId: org.id, serviceId: svc.id, componentId: comp2!.id, advisoryId: `GHSA-${s}`, severity: 'high', status: 'open', running: false },
    ] as typeof schema.findings.$inferInsert[]).returning({ id: schema.findings.id });
    // only the critical one is in the newest SBOM; the high one belongs to an older image
    await db.insert(schema.findingSboms).values({ findingId: rows[0]!.id, sbomId: sbom!.id });
    const out = await services.summary(chain);
    expect(out.findings.open).toEqual({ critical: 1, high: 0, medium: 0, low: 0, unknown: 0, total: 1 });
    expect(out.findings.kev).toBe(1);
    expect(out.findings.sbomId).toBe(sbom!.id);
    expect(out.latestSbom?.componentCount).toBe(2);
    expect(out.latestPipeline).toBeNull();
  });

  it('SAST ingested three times with the same fingerprint is one open finding; a changed fingerprint closes the old one', async () => {
    const { org, proj, svc, chain } = await fixture();
    const f = (fingerprint: string) => ({ kind: 'sast' as const, ruleId: 'python.lang.security.audit.eval-detected.eval-detected', title: 'Detected the use of eval()', severity: 'high' as const, file: 'app/run.py', startLine: 3, endLine: 3, evidence: 'return eval(x)', resolution: null, references: [], fingerprint, category: 'CWE-95' });
    const [job] = await db.insert(schema.jobs).values({ organizationId: org.id, projectId: proj.id, serviceId: svc.id, name: 'code', type: 'sast', stage: 'scan', stageOrder: 2, status: 'succeeded' } as typeof schema.jobs.$inferInsert).returning();
    for (let run = 0; run < 3; run++) await codeFindings.ingest({ organizationId: org.id, serviceId: svc.id, jobId: job!.id, kind: 'sast', ref: 'main', findings: [f('fp-same')] });
    let out = await services.summary(chain);
    expect(out.codeFindings.open).toEqual({ secret: 0, iac: 0, sast: 1 });
    expect(out.codeFindings.rules).toEqual([{ kind: 'sast', ruleId: 'python.lang.security.audit.eval-detected.eval-detected', n: 1 }]);
    // the next run reports the same issue under a different fingerprint (a path or snippet change): one open, one fixed
    const r = await codeFindings.ingest({ organizationId: org.id, serviceId: svc.id, jobId: job!.id, kind: 'sast', ref: 'main', findings: [f('fp-changed')] });
    expect(r).toEqual({ opened: 1, seen: 0, fixed: 1 });
    out = await services.summary(chain);
    expect(out.codeFindings.open.sast).toBe(1);
    const all = await db.select({ status: schema.codeFindings.status }).from(schema.codeFindings).where(eq(schema.codeFindings.serviceId, svc.id));
    expect(all.map((x) => x.status).sort()).toEqual(['fixed', 'open']);
  }, 20_000);
});
