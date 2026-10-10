import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { readGithubIssueState, readJiraIssueState } from './issues';
import { RemediationService } from './remediation.service';

describe('tracker state readers', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  it('Jira: done category = closed; GitHub: state', async () => {
    global.fetch = (async (u: string) => new Response(JSON.stringify(u.includes('jira') || u.includes('atlassian') ? { fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } : { state: 'open' }), { status: 200 })) as typeof fetch;
    expect(await readJiraIssueState('https://acme.atlassian.net', 'u', 't', 'KAN-7')).toEqual({ state: 'closed', status: 'Done' });
    expect(await readGithubIssueState('https://api.github.com', 't', 'o/r', 1)).toEqual({ state: 'open', status: 'open' });
  });
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('inbound sync: an issue closed in the tracker marks the remediation done (database)', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.organizations).where(eq(schema.organizations.id, id)).catch(() => undefined); await pool.end(); });

  it('closed → done; reopened (after 10 min) → open; a tracker error leaves the row untouched', async () => {
    const s = randomUUID().slice(0, 8);
    const [org] = await db.insert(schema.organizations).values({ slug: `ts-${s}`, name: s }).returning(); ids.push(org!.id);
    const [ws] = await db.insert(schema.workspaces).values({ organizationId: org!.id, slug: 'w', name: 'w' }).returning();
    const [team] = await db.insert(schema.teams).values({ workspaceId: ws!.id, slug: 't', name: 't' }).returning();
    const [proj] = await db.insert(schema.projects).values({ teamId: team!.id, slug: 'p', name: 'p' }).returning();
    const [svc] = await db.insert(schema.services).values({ projectId: proj!.id, slug: 'demo', name: 'demo' }).returning();
    const mk = async (status: 'open' | 'done', key: string, closedAt: Date | null = null) => (await db.insert(schema.remediations).values({ organizationId: org!.id, serviceId: svc!.id, kind: 'vulnerability', matchId: `CVE-2026-${key}`, title: key, severity: 'high', status, issueProvider: 'jira', issueKey: key, issueUrl: `https://x/${key}`, findingIds: [], closedAt } as typeof schema.remediations.$inferInsert).returning())[0]!;
    const a = await mk('open', 'KAN-1');                                         // closed in Jira → done
    const b = await mk('done', 'KAN-2', new Date(Date.now() - 3600_000));        // reopened in Jira → open
    const c = await mk('open', 'KAN-3');                                         // tracker error → untouched
    const states: Record<string, { state: 'open' | 'closed'; status: string }> = { 'KAN-1': { state: 'closed', status: 'Done' }, 'KAN-2': { state: 'open', status: 'To Do' } };
    const svcObj = Object.create(RemediationService.prototype) as { syncFromTrackers(): Promise<{ checked: number; closed: number; reopened: number }> };
    Object.assign(svcObj, { db, audit: { record: async () => undefined }, log: { warn: () => undefined }, trackerFor: async (rem: { issueKey: string }) => ({ read: async () => { if (!states[rem.issueKey]) throw new Error('Jira 503'); return states[rem.issueKey]; }, set: async () => null }) });
    const r = await svcObj.syncFromTrackers();
    expect(r).toMatchObject({ closed: 1, reopened: 1 });
    const get = async (id: string) => (await db.select({ status: schema.remediations.status, notes: schema.remediations.notes }).from(schema.remediations).where(eq(schema.remediations.id, id)))[0]!;
    expect((await get(a.id)).status).toBe('done');
    expect((await get(a.id)).notes).toContain('closed in jira (Done)');
    expect((await get(b.id)).status).toBe('open');
    expect((await get(c.id)).status).toBe('open');
  }, 20_000);
});
