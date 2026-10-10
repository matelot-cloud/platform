import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { CodeFindingsService } from './code-findings.service';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('code findings re-scan: descriptive fields refresh, decisions stay (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('same fingerprint, new title/resolution/evidence/lines → stored values change; status and notes untouched', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `cf-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [job] = await db.insert(schema.jobs).values({ organizationId: org!.id, projectId: proj!.id, serviceId: svc!.id, type: 'sast', name: 'code', status: 'running', payload: {} } as typeof schema.jobs.$inferInsert).returning();
    const service = Object.create(CodeFindingsService.prototype) as CodeFindingsService;
    Object.assign(service, { db, audit: { record: async () => undefined } });
    const base = { kind: 'sast' as const, ruleId: 'python.lang.security.audit.dangerous-subprocess-use', severity: 'high' as const, file: 'app/run.py', references: [], category: 'CWE-78', fingerprint: `fp-${s}` };
    // first scan (old runner: mid-word title, raw autofix)
    await service.ingest({ organizationId: org!.id, serviceId: svc!.id, jobId: job!.id, kind: 'sast', ref: 'main', findings: [{ ...base, title: 'Detected subprocess with shell=True which can lead to command injection when the input is not sanit', startLine: 12, endLine: 12, evidence: 'subprocess.call(cmd, shell=True)', resolution: 'Suggested fix: False' }] });
    const [first] = await db.select().from(schema.codeFindings).where(eq(schema.codeFindings.fingerprint, base.fingerprint));
    await db.update(schema.codeFindings).set({ status: 'accepted', note: 'reviewed, input is constant' }).where(eq(schema.codeFindings.id, first!.id));   // a decision in between
    // second scan (new runner: better title and fix, line moved)
    const r = await service.ingest({ organizationId: org!.id, serviceId: svc!.id, jobId: job!.id, kind: 'sast', ref: 'main', findings: [{ ...base, title: 'Detected subprocess with shell=True which can lead to command injection…', startLine: 15, endLine: 15, evidence: 'subprocess.call(cmd, shell=True)  # moved', resolution: 'Suggested fix: shell=False (instead of shell=True)' }] });
    expect(r).toMatchObject({ opened: 0, seen: 1, fixed: 0 });
    const [second] = await db.select().from(schema.codeFindings).where(eq(schema.codeFindings.id, first!.id));
    expect(second).toMatchObject({ title: 'Detected subprocess with shell=True which can lead to command injection…', startLine: 15, resolution: 'Suggested fix: shell=False (instead of shell=True)', status: 'accepted', note: 'reviewed, input is constant' });
    expect(second!.evidence).toContain('moved');
  }, 20_000);
});
