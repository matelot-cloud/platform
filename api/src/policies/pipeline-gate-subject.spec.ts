import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { PipelinesService } from '../execution/pipelines.service';
import { JobsService } from '../execution/jobs.service';
import { PoliciesService } from './policies.service';

/**
 * Pipelines #42/#43 (2026-10-07): a security pipeline started without --ref gave its evaluate job an empty payload, so
 * the gate had no subject and failed require_sbom although the pipeline's own sbom job had just produced an SBOM.
 */
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('pipeline gate subject: effective ref, resolved commit, the pipeline\'s own SBOM', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const orgIds: string[] = [];
  const audit = { record: async () => undefined };
  const pipelines = Object.create(PipelinesService.prototype) as PipelinesService;
  Object.assign(pipelines, { db, audit });
  const jobsService = Object.create(JobsService.prototype) as JobsService;
  Object.assign(jobsService, { db, audit, pipelines });
  const policies = Object.create(PoliciesService.prototype) as PoliciesService;
  Object.assign(policies, { db, audit });
  afterAll(async () => { for (const id of orgIds) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  async function seed(defaultBranch: string | null) {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `pg-${s}`, name: s }).returning(); orgIds.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [service] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const [integration] = await db.insert(schema.integrations).values({ organizationId: org!.id, scopeType: 'ORGANIZATION', scopeId: org!.id, provider: 'git', authType: 'none', name: 'git', status: 'connected', externalAccountId: `g-${s}`, settings: {} }).returning();
    const [repo] = await db.insert(schema.repositories).values({ integrationId: integration!.id, externalId: 'r', fullName: 'acme/demo', defaultBranch } as typeof schema.repositories.$inferInsert).returning();
    await db.insert(schema.serviceRepositories).values({ serviceId: service!.id, repositoryId: repo!.id } as typeof schema.serviceRepositories.$inferInsert);
    // "SAST gate 2": block, requireSbom
    await db.insert(schema.policies).values({ organizationId: org!.id, scopeType: 'PROJECT', scopeId: proj!.id, name: 'SAST gate 2', environmentKinds: [], rules: { requireSbom: true, maxSeverity: null, blockKev: false, blockSecrets: false, maxIacSeverity: null, maxSastSeverity: null, honourDecisions: true }, action: 'block', enforceOnDeploy: false } as typeof schema.policies.$inferInsert);
    const chain = { organizationId: org!.id, organizationAncestorIds: [], workspaceId: ws!.id, teamId: team!.id, projectId: proj!.id, serviceId: service!.id, refs: [{ type: 'ORGANIZATION', id: org!.id }, { type: 'WORKSPACE', id: ws!.id }, { type: 'TEAM', id: team!.id }, { type: 'PROJECT', id: proj!.id }, { type: 'SERVICE', id: service!.id }], target: { type: 'SERVICE', id: service!.id } } as never;
    return { org: org!, service: service!, chain };
  }
  const sbom = (orgId: string, serviceId: string, jobId: string | null, createdAt: Date) => db.insert(schema.sboms).values({ organizationId: orgId, serviceId, jobId, source: 'runner', target: 'source', targetRef: 'acme/demo', format: 'cyclonedx', componentCount: 3, digest: randomUUID(), rawGz: Buffer.from(''), correlationStatus: 'done', createdAt } as typeof schema.sboms.$inferInsert).returning().then((r) => r[0]!);
  const jobsOf = (pipelineId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.pipelineId, pipelineId));

  it('without --ref every job works on the default branch; the checkout commit is recorded; the gate passes with the pipeline\'s own SBOM', async () => {
    const { org, service, chain } = await seed('main');
    const created = await pipelines.create(null, chain, { template: 'security' }) as { id: string; ref: string };
    expect(created.ref).toBe('main');
    const rows = await jobsOf(created.id);
    expect(rows.length).toBeGreaterThan(2);
    for (const j of rows) expect(j.payload).toMatchObject({ ref: 'main' }); // was {} for every job (#42)

    // checkout resolves the commit: recorded on the pipeline and on the jobs that have not run yet
    const commit = 'b7e1c0de'.padEnd(40, '0');
    await jobsService.recordCommit(created.id, { commit, branch: 'main', files: 12 });
    const [p] = await db.select().from(schema.pipelines).where(eq(schema.pipelines.id, created.id));
    expect(p!.commitSha).toBe(commit);
    const evalJob = (await jobsOf(created.id)).find((j) => j.type === 'policy_eval')!;
    expect(evalJob.payload).toMatchObject({ ref: 'main', commitSha: commit });
    await jobsService.recordCommit(created.id, { commit: 'f'.repeat(40) }); // the first resolved commit stays
    expect((await db.select().from(schema.pipelines).where(eq(schema.pipelines.id, created.id)))[0]!.commitSha).toBe(commit);

    // its sbom job produced an SBOM; a NEWER source SBOM of the service from elsewhere must not be preferred
    const sbomJob = (await jobsOf(created.id)).find((j) => j.type === 'sbom')!;
    const own = await sbom(org.id, service.id, sbomJob.id, new Date(Date.now() - 60_000));
    const other = await sbom(org.id, service.id, null, new Date());

    const ev = await policies.evaluateJob({ id: evalJob.id, serviceId: service.id, payload: evalJob.payload, pipelineId: created.id }, chain) as { result: string; violations: unknown[]; subject: Record<string, unknown> };
    expect(ev.result).toBe('pass');
    expect(ev.violations).toEqual([]);
    expect(ev.subject).toMatchObject({ ref: 'main', commitSha: commit, pipelineId: created.id, sbomId: own.id, sbomSource: 'pipeline' });
    expect(ev.subject.sbomId).not.toBe(other.id);
    // the stored evaluation records what was evaluated
    const [stored] = await db.select().from(schema.gateEvaluations).where(eq(schema.gateEvaluations.jobId, evalJob.id));
    expect(stored!.subject).toMatchObject({ ref: 'main', commitSha: commit, sbomId: own.id });
  }, 30_000);

  it('an older evaluate payload (no ref) falls back to the pipeline\'s ref and commit', async () => {
    const { org, service, chain } = await seed('main');
    const created = await pipelines.create(null, chain, { template: 'security' }) as { id: string };
    await jobsService.recordCommit(created.id, { commit: 'c'.repeat(40) });
    const sbomJob = (await jobsOf(created.id)).find((j) => j.type === 'sbom')!;
    await sbom(org.id, service.id, sbomJob.id, new Date());
    const evalJob = (await jobsOf(created.id)).find((j) => j.type === 'policy_eval')!;
    const ev = await policies.evaluateJob({ id: evalJob.id, serviceId: service.id, payload: {}, pipelineId: created.id }, chain) as { result: string; subject: Record<string, unknown> };
    expect(ev.result).toBe('pass');
    expect(ev.subject).toMatchObject({ ref: 'main', commitSha: 'c'.repeat(40) });
  }, 30_000);

  it('messages: a ref with no SBOM names the ref and commit; no ref at all says there is nothing to evaluate', async () => {
    const a = await seed('main');
    const p1 = await pipelines.create(null, a.chain, { template: 'security' }) as { id: string };
    await jobsService.recordCommit(p1.id, { commit: 'd'.repeat(40) });
    const e1 = (await jobsOf(p1.id)).find((j) => j.type === 'policy_eval')!;
    const ev1 = await policies.evaluateJob({ id: e1.id, serviceId: a.service.id, payload: e1.payload, pipelineId: p1.id }, a.chain) as { result: string; violations: { rule: string; message: string }[] };
    expect(ev1.result).toBe('fail');
    expect(ev1.violations[0]).toMatchObject({ rule: 'require_sbom' });
    expect(ev1.violations[0]!.message).toBe(`No SBOM for ref main (commit ${'d'.repeat(12)}): run the pipeline's sbom job or upload one, so dependency vulnerabilities are known.`);

    const b = await seed(null); // repository without a default branch, pipeline without --ref
    const p2 = await pipelines.create(null, b.chain, { template: 'security' }) as { id: string; ref: string | null };
    expect(p2.ref).toBeNull();
    const e2 = (await jobsOf(p2.id)).find((j) => j.type === 'policy_eval')!;
    const ev2 = await policies.evaluateJob({ id: e2.id, serviceId: b.service.id, payload: e2.payload, pipelineId: p2.id }, b.chain) as { violations: { message: string }[] };
    expect(ev2.violations[0]!.message).toMatch(/^No ref or image to evaluate/);
    expect(ev2.violations.map((v) => v.message).join(' ')).not.toMatch(/The image has no SBOM/);
  }, 30_000);
});
