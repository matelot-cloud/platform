import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { projectCondition, ProjectScope } from '../rbac/scope-projects';
import { Logger, BadRequestException, Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { IssueProvider, ScopeType } from '../database/schema';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { userIdOrNull } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { advisories, codeFindings, components, DEFAULT_SLA, deployments, environments, findings, findingSboms, integrations, projects, remediations, remediationSettings, repositories, sboms, serviceRepositories, services, Severity, SlaDays, teams, users, workspaces } from '../database/schema';
import { GithubAppClient } from '../integrations/github/github-app.client';
import { GithubSyncService } from '../integrations/github/github-sync.service';
import { SourceSyncService } from '../integrations/source-sync.service';
import { addToGithubProject, createBitbucketIssue, createGithubIssue, createGitlabIssue, createJiraIssue, IssueDraft, readGithubIssueState, readGitlabIssueState, readJiraIssueState, setGithubIssueState, setGitlabIssueState, TrackerState, transitionJiraIssue } from './issues';

const ENV_RANK: Record<string, number> = { production: 3, staging: 2, testing: 2, development: 1 };
const SEV_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

export interface QueueItem {
  key: string; kind: 'vulnerability' | 'code'; serviceId: string; serviceName: string; matchId: string; componentName: string | null; componentVersion: string | null;
  severity: Severity; kev: boolean; epss: number | null; fixVersion: string | null; findingIds: string[]; runsIn: string[]; internetFacing: boolean;
  firstSeenAt: string; dueAt: string; overdue: boolean; daysLeft: number; score: number; remediation: { id: string; status: string; ownerId: string | null; ownerName: string | null; issueKey: string | null; issueUrl: string | null; dueAt: string | null } | null;
}

@Injectable()
export class RemediationService {
  private readonly log = new Logger(RemediationService.name);
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly github: GithubAppClient,
    private readonly githubSync: GithubSyncService,
    private readonly sourceSync: SourceSyncService,
  ) {}

  // ---------------------------------------------------------------- settings

  private emptySettings(organizationId: string, scopeType: ScopeType, scopeId: string) {
    return { organizationId, scopeType, scopeId, slaDays: null as SlaDays | null, issueProvider: null as IssueProvider | null, issueBoard: null as string | null, defaultIssueIntegrationId: null as string | null, jiraProjectKey: null as string | null, updatedAt: null as Date | null };
  }

  /** Raw settings stored at one scope (null fields = inherit from the parent scope). */
  async settingsAt(organizationId: string, scopeType: ScopeType, scopeId: string) {
    const [row] = await this.db.select().from(remediationSettings).where(and(eq(remediationSettings.scopeType, scopeType), eq(remediationSettings.scopeId, scopeId))).limit(1);
    if (row) return row;
    return scopeType === 'ORGANIZATION' ? { ...this.emptySettings(organizationId, scopeType, scopeId), slaDays: DEFAULT_SLA } : this.emptySettings(organizationId, scopeType, scopeId);
  }

  /** Organization-level settings (backwards compatible name). */
  async settings(organizationId: string) { return this.settingsAt(organizationId, 'ORGANIZATION', organizationId); }

  /** project → team → workspace → organization, nearest first. */
  async chainOf(projectId: string): Promise<{ scopeType: ScopeType; scopeId: string; name: string }[]> {
    const [row] = await this.db.select({ projectId: projects.id, projectName: projects.name, teamId: teams.id, teamName: teams.name, workspaceId: workspaces.id, workspaceName: workspaces.name, organizationId: workspaces.organizationId })
      .from(projects).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(projects.id, projectId)).limit(1);
    if (!row) throw new NotFoundException('Project not found');
    return [
      { scopeType: 'PROJECT', scopeId: row.projectId, name: row.projectName },
      { scopeType: 'TEAM', scopeId: row.teamId, name: row.teamName },
      { scopeType: 'WORKSPACE', scopeId: row.workspaceId, name: row.workspaceName },
      { scopeType: 'ORGANIZATION', scopeId: row.organizationId, name: 'organization' },
    ];
  }

  /** Effective settings of a project: each field comes from the nearest scope that defines it. */
  async effectiveSettings(projectId: string) {
    const chain = await this.chainOf(projectId);
    const rows = await this.db.select().from(remediationSettings).where(inArray(remediationSettings.scopeId, chain.map((c) => c.scopeId)));
    const at = (c: { scopeType: ScopeType; scopeId: string }) => rows.find((r) => r.scopeType === c.scopeType && r.scopeId === c.scopeId);
    const pick = <K extends 'slaDays' | 'issueProvider' | 'issueBoard' | 'defaultIssueIntegrationId' | 'jiraProjectKey'>(key: K) => {
      for (const c of chain) { const r = at(c); if (r && r[key] !== null && r[key] !== undefined) return { value: r[key] as NonNullable<(typeof rows)[number][K]>, from: c }; }
      return null;
    };
    const sla = pick('slaDays'); const prov = pick('issueProvider'); const board = pick('issueBoard'); const integ = pick('defaultIssueIntegrationId'); const key = pick('jiraProjectKey');
    return {
      organizationId: chain[3]!.scopeId, projectId,
      slaDays: sla?.value ?? DEFAULT_SLA, issueProvider: prov?.value ?? null, issueBoard: board?.value ?? null, defaultIssueIntegrationId: integ?.value ?? null, jiraProjectKey: key?.value ?? null,
      sources: { slaDays: sla?.from ?? null, issueProvider: prov?.from ?? null, issueBoard: board?.from ?? null, defaultIssueIntegrationId: integ?.from ?? null, jiraProjectKey: key?.from ?? null },
      chain,
    };
  }

  async updateSettings(user: AuthenticatedUser, organizationId: string, patch: { slaDays?: Partial<SlaDays> | null; issueProvider?: IssueProvider | null; issueBoard?: string | null; defaultIssueIntegrationId?: string | null; jiraProjectKey?: string | null }, scopeType: ScopeType = 'ORGANIZATION', scopeId: string = organizationId) {
    const current = await this.settingsAt(organizationId, scopeType, scopeId);
    let slaDays: SlaDays | null = current.slaDays;
    if (patch.slaDays === null) slaDays = scopeType === 'ORGANIZATION' ? DEFAULT_SLA : null;
    else if (patch.slaDays) {
      // a partial override starts from what the scope currently inherits, not from the built-in defaults
      const inherited = current.slaDays ?? (scopeType === 'PROJECT' ? (await this.effectiveSettings(scopeId)).slaDays : (await this.settings(organizationId)).slaDays ?? DEFAULT_SLA);
      slaDays = { ...inherited, ...patch.slaDays };
      for (const [k, v] of Object.entries(slaDays)) if (!Number.isInteger(v) || v < 1 || v > 3650) throw new BadRequestException(`sla ${k} must be 1–3650 days`);
    }
    if (patch.issueProvider && !['github', 'gitlab', 'bitbucket', 'jira'].includes(patch.issueProvider)) throw new BadRequestException('issueProvider must be github, gitlab, bitbucket or jira');
    if (patch.issueBoard && !/^https:\/\/github\.com\/(orgs|users)\/[^/]+\/projects\/\d+/.test(patch.issueBoard.trim())) throw new BadRequestException('issueBoard must be a GitHub Projects URL: https://github.com/orgs/<org>/projects/<n>');
    const values = {
      organizationId, scopeType, scopeId, slaDays,
      issueProvider: patch.issueProvider === undefined ? current.issueProvider : patch.issueProvider,
      issueBoard: patch.issueBoard === undefined ? current.issueBoard : patch.issueBoard?.trim() || null,
      defaultIssueIntegrationId: patch.defaultIssueIntegrationId === undefined ? current.defaultIssueIntegrationId : patch.defaultIssueIntegrationId,
      jiraProjectKey: patch.jiraProjectKey === undefined ? current.jiraProjectKey : patch.jiraProjectKey?.trim().toUpperCase() || null,
      updatedAt: new Date(),
    };
    const [row] = await this.db.insert(remediationSettings).values(values).onConflictDoUpdate({ target: [remediationSettings.scopeType, remediationSettings.scopeId], set: values }).returning();
    await this.audit.record({ organizationId, actor: userActor(user), action: 'remediation.settings_updated', resourceType: scopeType.toLowerCase(), resourceId: scopeId, after: { slaDays, issueProvider: row!.issueProvider, issueBoard: row!.issueBoard, jiraProjectKey: row!.jiraProjectKey, defaultIssueIntegrationId: row!.defaultIssueIntegrationId } });
    return row!;
  }

  // ---------------------------------------------------------------- queue

  /** Open work, grouped by advisory × service (and component), ranked by exposure → severity → KEV/EPSS → fix available → SLA. */
  async queue(organizationId: string, filter: { projectId?: ProjectScope; serviceId?: string; limit?: number } = {}): Promise<QueueItem[]> {
    const svcRows = await this.db.select({ id: services.id, name: services.name, projectId: services.projectId }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(and(eq(workspaces.organizationId, organizationId), isNull(services.archivedAt), ...(filter.projectId ? [projectCondition(services.projectId, filter.projectId)!] : []), ...(filter.serviceId ? [eq(services.id, filter.serviceId)] : [])));
    if (!svcRows.length) return [];
    const svcIds = svcRows.map((s) => s.id);
    const svcName = new Map(svcRows.map((s) => [s.id, s.name]));
    const svcProject = new Map(svcRows.map((s) => [s.id, s.projectId]));
    const slaByProject = new Map<string, SlaDays>();
    for (const pid of new Set(svcRows.map((s) => s.projectId))) slaByProject.set(pid, (await this.effectiveSettings(pid)).slaDays);
    // what runs where: sbomId → environments, by digest (sbom/running-sbom.ts) — the same answer as the findings views.
    const runs = (await resolveRunningSboms(this.db, { serviceIds: svcRows.map((s) => s.id) })).filter((r) => r.sbomId).map((r) => ({ sbomId: r.sbomId!, kind: r.environmentKind, internetFacing: r.internetFacing }));
    const runsBySbom = new Map<string, { kind: string; internetFacing: boolean }[]>();
    for (const r of runs) runsBySbom.set(r.sbomId, [...(runsBySbom.get(r.sbomId) ?? []), { kind: r.kind, internetFacing: r.internetFacing }]);
    const rows = await this.db.select({ id: findings.id, serviceId: findings.serviceId, severity: findings.severity, fixedVersion: findings.fixedVersion, firstSeenAt: findings.firstSeenAt, advisoryId: findings.advisoryId, kev: advisories.kev, epss: advisories.epssScore, componentName: components.name, componentVersion: components.version }).from(findings).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).innerJoin(components, eq(findings.componentId, components.id)).where(and(inArray(findings.serviceId, svcIds), eq(findings.status, 'open')));
    const links = rows.length ? await this.db.select({ findingId: findingSboms.findingId, sbomId: findingSboms.sbomId }).from(findingSboms).where(inArray(findingSboms.findingId, rows.map((r) => r.id))) : [];
    const sbomsOf = new Map<string, string[]>();
    for (const l of links) sbomsOf.set(l.findingId, [...(sbomsOf.get(l.findingId) ?? []), l.sbomId]);
    const open = await this.db.select().from(remediations).where(and(eq(remediations.organizationId, organizationId), inArray(remediations.status, ['open', 'in_progress'])));
    const ownerIds = [...new Set(open.map((r) => r.ownerId).filter((x): x is string => !!x))];
    const owners = ownerIds.length ? await this.db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, ownerIds)) : [];
    const ownerName = new Map(owners.map((o) => [o.id, o.name ?? o.email]));
    const groups = new Map<string, QueueItem>();
    for (const f of rows) {
      const key = `vulnerability|${f.serviceId}|${f.advisoryId}|${f.componentName}`;
      const envs = (sbomsOf.get(f.id) ?? []).flatMap((s) => runsBySbom.get(s) ?? []);
      const g = groups.get(key) ?? { key, kind: 'vulnerability' as const, serviceId: f.serviceId, serviceName: svcName.get(f.serviceId) ?? '', matchId: f.advisoryId, componentName: f.componentName, componentVersion: f.componentVersion, severity: f.severity, kev: f.kev, epss: f.epss, fixVersion: f.fixedVersion, findingIds: [] as string[], runsIn: [] as string[], internetFacing: false, firstSeenAt: f.firstSeenAt.toISOString(), dueAt: '', overdue: false, daysLeft: 0, score: 0, remediation: null };
      g.findingIds.push(f.id);
      for (const e of envs) { if (!g.runsIn.includes(e.kind)) g.runsIn.push(e.kind); if (e.internetFacing) g.internetFacing = true; }
      if (f.firstSeenAt.toISOString() < g.firstSeenAt) g.firstSeenAt = f.firstSeenAt.toISOString();
      if (f.fixedVersion && !g.fixVersion) g.fixVersion = f.fixedVersion;
      groups.set(key, g);
    }
    const code = await this.db.select({ id: codeFindings.id, serviceId: codeFindings.serviceId, kind: codeFindings.kind, ruleId: codeFindings.ruleId, severity: codeFindings.severity, firstSeenAt: codeFindings.firstSeenAt }).from(codeFindings).where(and(inArray(codeFindings.serviceId, svcIds), eq(codeFindings.status, 'open')));
    for (const c of code) {
      const key = `code|${c.serviceId}|${c.ruleId}|`;
      const g = groups.get(key) ?? { key, kind: 'code' as const, serviceId: c.serviceId, serviceName: svcName.get(c.serviceId) ?? '', matchId: c.ruleId, componentName: c.kind, componentVersion: null, severity: c.severity, kev: false, epss: null, fixVersion: null, findingIds: [] as string[], runsIn: ['repository'], internetFacing: false, firstSeenAt: c.firstSeenAt.toISOString(), dueAt: '', overdue: false, daysLeft: 0, score: 0, remediation: null };
      g.findingIds.push(c.id);
      if (c.kind === 'secret') g.severity = 'critical';
      groups.set(key, g);
    }
    const now = Date.now();
    const items = [...groups.values()].map((g) => {
      const sla = slaByProject.get(svcProject.get(g.serviceId) ?? '') ?? DEFAULT_SLA;
      const days = sla[g.severity as keyof SlaDays] ?? sla.low;
      const due = new Date(new Date(g.firstSeenAt).getTime() + days * 86400_000);
      const exposure = Math.max(0, ...g.runsIn.map((k) => ENV_RANK[k] ?? 0));
      const score = exposure * 100 + (g.internetFacing ? 50 : 0) + SEV_RANK[g.severity] * 10 + (g.kev ? 40 : 0) + Math.round((g.epss ?? 0) * 20) + (g.fixVersion ? 5 : 0) + (due.getTime() < now ? 15 : 0);
      const rem = open.find((r) => r.serviceId === g.serviceId && r.kind === g.kind && r.matchId === g.matchId && (r.componentName ?? null) === (g.kind === 'code' ? null : g.componentName)) ?? null;
      return { ...g, dueAt: due.toISOString(), overdue: due.getTime() < now, daysLeft: Math.ceil((due.getTime() - now) / 86400_000), score, remediation: rem ? { id: rem.id, status: rem.status, ownerId: rem.ownerId, ownerName: rem.ownerId ? (ownerName.get(rem.ownerId) ?? null) : null, issueKey: rem.issueKey, issueUrl: rem.issueUrl, dueAt: rem.dueAt?.toISOString() ?? null } : null };
    });
    return items.sort((a, b) => b.score - a.score || a.dueAt.localeCompare(b.dueAt) || (b.epss ?? 0) - (a.epss ?? 0) || b.findingIds.length - a.findingIds.length || String(a.componentName ?? '').localeCompare(String(b.componentName ?? '')) || a.matchId.localeCompare(b.matchId)).slice(0, filter.limit ?? Number.MAX_SAFE_INTEGER); // no silent cap: callers page with ?limit; X-Total-Count says how many exist
  }

  // ---------------------------------------------------------------- remediations

  async list(organizationId: string, filter: { projectId?: ProjectScope; serviceId?: string; status?: string[]; ownerId?: string } = {}) {
    const rows = await this.db.select({ r: remediations, serviceName: services.name, projectId: services.projectId, ownerName: users.displayName, ownerEmail: users.email }).from(remediations).innerJoin(services, eq(remediations.serviceId, services.id)).leftJoin(users, eq(remediations.ownerId, users.id)).where(and(eq(remediations.organizationId, organizationId), ...(filter.serviceId ? [eq(remediations.serviceId, filter.serviceId)] : []), ...(filter.projectId ? [projectCondition(services.projectId, filter.projectId)!] : []), ...(filter.status?.length ? [inArray(remediations.status, filter.status as ('open' | 'in_progress' | 'done' | 'wont_fix')[])] : []), ...(filter.ownerId ? [eq(remediations.ownerId, filter.ownerId)] : []))).orderBy(desc(remediations.createdAt));
    // "done" is a claim until a scan agrees: a done remediation whose findings are still open in a RUNNING image is flagged.
    const doneIds = rows.filter((x) => x.r.status === 'done' && x.r.kind === 'vulnerability' && x.r.findingIds.length).flatMap((x) => x.r.findingIds);
    const present = doneIds.length ? new Set((await this.db.select({ id: findings.id }).from(findings).where(and(inArray(findings.id, doneIds), eq(findings.status, 'open'), eq(findings.running, true)))).map((f) => f.id)) : new Set<string>();
    return rows.map((x) => ({ ...x.r, stillPresent: x.r.status === 'done' && x.r.kind === 'vulnerability' && x.r.findingIds.some((id) => present.has(id)), serviceName: x.serviceName, projectId: x.projectId, ownerName: x.ownerName ?? x.ownerEmail ?? null, overdue: !!x.r.dueAt && x.r.dueAt.getTime() < Date.now() && ['open', 'in_progress'].includes(x.r.status) }));
  }

  async byId(id: string) {
    const [row] = await this.db.select().from(remediations).where(eq(remediations.id, id)).limit(1);
    if (!row) throw new NotFoundException('Remediation not found');
    return row;
  }

  /** Track a queue item (advisory × service [× component]) as work. Idempotent per open key. */
  async create(user: AuthenticatedUser | null, organizationId: string, input: { force?: boolean; serviceId: string; kind: 'vulnerability' | 'code'; matchId: string; componentName?: string | null; ownerId?: string | null; ownerEmail?: string | null; dueAt?: string | null; notes?: string | null; title?: string }) {
    const q = (await this.queue(organizationId, { serviceId: input.serviceId })).find((i) => i.kind === input.kind && i.matchId === input.matchId && (input.kind === 'code' || !input.componentName || (i.componentName ?? null) === input.componentName));
    if (!q) throw new NotFoundException('No open findings match this advisory / rule in the service');
    if (q.remediation) return this.byId(q.remediation.id);
    // One active remediation per (service, advisory/rule, component): a second one would mean a second ticket for the same work.
    const [dup] = await this.db.select({ id: remediations.id, status: remediations.status, issueKey: remediations.issueKey }).from(remediations)
      .where(and(eq(remediations.serviceId, input.serviceId), eq(remediations.kind, input.kind), eq(remediations.matchId, input.matchId), inArray(remediations.status, ['open', 'in_progress']), input.kind === 'code' ? sql`true` : sql`coalesce(${remediations.componentName}, '') = coalesce(${input.componentName ?? q.componentName ?? null}, '')`)).limit(1);
    if (dup && !input.force) throw new ConflictException({ statusCode: 409, code: 'remediation_exists', existingId: dup.id, issueKey: dup.issueKey, message: `An active remediation already exists for ${input.matchId}${input.componentName ? ` on ${input.componentName}` : ''} in this service (${dup.id}, ${dup.status}${dup.issueKey ? `, ${dup.issueKey}` : ''}). Update it, or pass force=true to create another.` });
    let ownerId = input.ownerId ?? null;
    if (!ownerId && input.ownerEmail) { const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, input.ownerEmail)).limit(1); if (!u) throw new BadRequestException(`no user with e-mail ${input.ownerEmail}`); ownerId = u.id; }
    const title = input.title ?? (q.kind === 'vulnerability' ? `${q.matchId} in ${q.componentName}${q.componentVersion ? ` ${q.componentVersion}` : ''} (${q.serviceName})` : `${q.matchId} ${q.componentName} in ${q.serviceName}`);
    const [row] = await this.db.insert(remediations).values({ organizationId, serviceId: input.serviceId, kind: input.kind, matchId: input.matchId, componentName: input.kind === 'code' ? null : (input.componentName ?? q.componentName), title, severity: q.severity, ownerId, dueAt: input.dueAt ? new Date(input.dueAt) : new Date(q.dueAt), findingIds: q.kind === 'vulnerability' ? q.findingIds : [], codeFindingIds: q.kind === 'code' ? q.findingIds : [], notes: input.notes ?? null, createdById: user ? userIdOrNull(user) : null }).returning();
    await this.audit.record({ organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'remediation.created', resourceType: 'remediation', resourceId: row.id, after: { title, severity: row.severity, ownerId, dueAt: row.dueAt, findings: row.findingIds.length + row.codeFindingIds.length } });
    return row;
  }

  async update(user: AuthenticatedUser, id: string, patch: { status?: 'open' | 'in_progress' | 'done' | 'wont_fix'; ownerId?: string | null; ownerEmail?: string | null; dueAt?: string | null; notes?: string | null; title?: string }) {
    const before = await this.byId(id);
    let ownerId = patch.ownerId;
    if (patch.ownerEmail) { const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.email, patch.ownerEmail)).limit(1); if (!u) throw new BadRequestException(`no user with e-mail ${patch.ownerEmail}`); ownerId = u.id; }
    const set: Partial<typeof remediations.$inferInsert> = { updatedAt: new Date() };
    if (patch.status) { set.status = patch.status; set.closedAt = ['done', 'wont_fix'].includes(patch.status) ? new Date() : null; }
    if (ownerId !== undefined) set.ownerId = ownerId;
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.title) set.title = patch.title;
    const [row] = await this.db.update(remediations).set(set).where(eq(remediations.id, id)).returning();
    // Mirror the status to the tracker (best effort: a tracker hiccup never blocks the change).
    if (patch.status && row.issueKey && row.issueProvider) {
      const closing = ['done', 'wont_fix'].includes(patch.status) && !['done', 'wont_fix'].includes(before.status);
      const reopening = ['open', 'in_progress'].includes(patch.status) && ['done', 'wont_fix'].includes(before.status);
      if (closing || reopening) this.mirrorIssueState(row, closing ? 'close' : 'reopen', user).catch((e: Error) => this.log.warn(`issue ${row.issueKey} not ${closing ? 'closed' : 'reopened'}: ${e.message}`));
    }
    // "won't fix" is a decision on the findings themselves
    if (patch.status === 'wont_fix' && before.findingIds.length) await this.db.update(findings).set({ status: 'accepted', note: `remediation ${id}: won't fix`, statusChangedAt: new Date(), statusChangedById: userIdOrNull(user) }).where(and(inArray(findings.id, before.findingIds), eq(findings.status, 'open')));
    await this.audit.record({ organizationId: before.organizationId, actor: userActor(user), action: 'remediation.updated', resourceType: 'remediation', resourceId: id, before: { status: before.status, ownerId: before.ownerId, dueAt: before.dueAt }, after: patch });
    return row;
  }

  // ---------------------------------------------------------------- issues

  private async draft(rem: typeof remediations.$inferSelect): Promise<IssueDraft> {
    const q = (await this.queue(rem.organizationId, { serviceId: rem.serviceId })).find((i) => i.kind === rem.kind && i.matchId === rem.matchId && (rem.kind === 'code' || (i.componentName ?? null) === (rem.componentName ?? null)));
    const [adv] = rem.kind === 'vulnerability' ? await this.db.select().from(advisories).where(eq(advisories.id, rem.matchId)).limit(1) : [null];
    const lines = [
      `**Service:** ${q?.serviceName ?? rem.serviceId}`,
      `**Severity:** ${rem.severity}${q?.kev ? ' · listed in CISA KEV (known exploited)' : ''}${q?.epss != null ? ` · EPSS ${(q.epss * 100).toFixed(1)}%` : ''}`,
      rem.kind === 'vulnerability' ? `**Component:** ${rem.componentName}${q?.componentVersion ? ` ${q.componentVersion}` : ''}${q?.fixVersion ? ` → fix available in ${q.fixVersion}` : ''}` : `**Rule:** ${rem.matchId} (${q?.componentName ?? 'code'})`,
      `**Runs in:** ${q?.runsIn.length ? q.runsIn.join(', ') : 'not deployed'}${q?.internetFacing ? ' (internet-facing)' : ''}`,
      `**SLA due:** ${(rem.dueAt ?? new Date(q?.dueAt ?? Date.now())).toISOString().slice(0, 10)}`,
      adv?.summary ? `\n${adv.summary}` : '',
      adv ? `\nReferences: https://osv.dev/vulnerability/${encodeURIComponent(adv.id)}` : '',
      `\nTracked in Matelot as remediation ${rem.id}.`,
    ].filter(Boolean);
    return { title: `[${rem.severity}] ${rem.title}`, body: lines.join('\n\n'), labels: ['security', rem.severity, rem.kind], severity: rem.severity, dueAt: rem.dueAt ?? (q?.dueAt ? new Date(q.dueAt) : null) };
  }

  /** Close / reopen the linked issue with a comment; resolves the connection the same way createIssue did. */
  /** The tracker client for a remediation's linked issue: Jira (nearest connection on the chain) or the repository host. */
  private async trackerFor(rem: typeof remediations.$inferSelect): Promise<{ read: () => Promise<TrackerState>; set: (target: 'close' | 'reopen', comment: string) => Promise<string | null> }> {
    if (rem.issueProvider === 'jira') {
      const [svc] = await this.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, rem.serviceId)).limit(1);
      const settings = svc ? await this.effectiveSettings(svc.projectId) : null;
      const candidates = await this.db.select().from(integrations).where(and(eq(integrations.organizationId, rem.organizationId), eq(integrations.provider, 'jira'), inArray(integrations.status, ['connected', 'pending', 'error'])));
      let jira = null as (typeof candidates)[number] | null;
      for (const c of settings?.chain ?? []) { jira = candidates.find((i) => i.scopeType === c.scopeType && i.scopeId === c.scopeId) ?? null; if (jira) break; }
      jira = jira ?? candidates[0] ?? null;
      if (!jira) throw new Error('no Jira connection');
      const creds = this.sourceSync.credentialsOf(jira);
      if (creds.type !== 'basic') throw new Error('Jira connection needs e-mail + API token');
      const base = String(jira.settings.baseUrl);
      return { read: () => readJiraIssueState(base, creds.username, creds.password, rem.issueKey!), set: (t, c) => transitionJiraIssue(base, creds.username, creds.password, rem.issueKey!, t, c) };
    }
    const [repo] = await this.db.select({ repository: repositories, integration: integrations }).from(serviceRepositories).innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id)).innerJoin(integrations, eq(repositories.integrationId, integrations.id)).where(eq(serviceRepositories.serviceId, rem.serviceId)).orderBy(desc(eq(serviceRepositories.role, 'primary'))).limit(1);
    if (!repo) throw new Error('service has no repository');
    const num = Number(/#(\d+)$/.exec(rem.issueKey!)?.[1] ?? 0);
    if (!num) throw new Error(`cannot parse issue number from ${rem.issueKey}`);
    if (rem.issueProvider === 'github') {
      const apiUrl = String(repo.integration.settings.apiUrl ?? repo.integration.settings.baseUrl ?? 'https://api.github.com');
      const token = repo.integration.provider === 'github' && repo.integration.externalAccountId ? await this.github.installationToken(repo.integration.externalAccountId, this.githubSync.appConfigFor(repo.integration)) : (() => { const c = this.sourceSync.credentialsOf(repo.integration); if (c.type !== 'token') throw new Error('GitHub connection needs a token'); return c.token; })();
      return { read: () => readGithubIssueState(apiUrl, token, repo.repository.fullName, num), set: async (t, c) => { await setGithubIssueState(apiUrl, token, repo.repository.fullName, num, t === 'close' ? 'closed' : 'open', c); return t === 'close' ? 'closed' : 'open'; } };
    }
    if (rem.issueProvider === 'gitlab') {
      const c = this.sourceSync.credentialsOf(repo.integration);
      if (c.type !== 'token') throw new Error('GitLab connection needs a token');
      const base = String(repo.integration.settings.baseUrl ?? 'https://gitlab.com');
      return { read: () => readGitlabIssueState(base, c.token, repo.repository.externalId, num), set: async (t, cm) => { await setGitlabIssueState(base, c.token, repo.repository.externalId, num, t, cm); return t; } };
    }
    throw new Error(`no state API for ${rem.issueProvider}`);
  }

  /** Close / reopen the linked issue with a comment (outbound mirror). Best effort. */
  async mirrorIssueState(rem: typeof remediations.$inferSelect, target: 'close' | 'reopen', user: AuthenticatedUser | null): Promise<void> {
    const who = user ? (user.displayName ?? user.email) : 'Matelot';
    const comment = target === 'close' ? `Marked **${rem.status === 'wont_fix' ? "won't fix" : 'done'}** in Matelot by ${who}. The finding is verified at the next scan; if it is still present the remediation shows "done — still present".` : `Reopened in Matelot by ${who} (status ${rem.status}).`;
    const tracker = await this.trackerFor(rem);
    const to = await tracker.set(target, comment);
    await this.audit.record({ organizationId: rem.organizationId, actor: user ? userActor(user) : SYSTEM_ACTOR, action: 'remediation.issue_synced', resourceType: 'remediation', resourceId: rem.id, after: { issueKey: rem.issueKey, target, trackerStatus: to } });
  }

  /**
   * Inbound sync (hourly): an issue closed in the tracker marks the remediation done (verified by the next scan, like any
   * done); an issue reopened in the tracker while the remediation is done reopens it. Each remediation isolated.
   */
  async syncFromTrackers(organizationId?: string): Promise<{ checked: number; closed: number; reopened: number }> {
    const rows = await this.db.select().from(remediations).where(and(sql`${remediations.issueKey} is not null`, inArray(remediations.status, ['open', 'in_progress', 'done']), organizationId ? eq(remediations.organizationId, organizationId) : undefined));
    let checked = 0; let closed = 0; let reopened = 0;
    for (const rem of rows) {
      try {
        const state = await (await this.trackerFor(rem)).read();
        checked++;
        if (state.state === 'closed' && ['open', 'in_progress'].includes(rem.status)) {
          await this.db.update(remediations).set({ status: 'done', closedAt: new Date(), notes: `${rem.notes ? rem.notes + '\n' : ''}closed in ${rem.issueProvider} (${state.status ?? 'closed'})` }).where(eq(remediations.id, rem.id));
          await this.audit.record({ organizationId: rem.organizationId, actor: SYSTEM_ACTOR, action: 'remediation.updated', resourceType: 'remediation', resourceId: rem.id, before: { status: rem.status }, after: { status: 'done', source: `tracker:${rem.issueProvider}`, trackerStatus: state.status } });
          closed++;
        } else if (state.state === 'open' && rem.status === 'done' && rem.closedAt && rem.closedAt.getTime() < Date.now() - 10 * 60_000) {
          await this.db.update(remediations).set({ status: 'open', closedAt: null }).where(eq(remediations.id, rem.id));
          await this.audit.record({ organizationId: rem.organizationId, actor: SYSTEM_ACTOR, action: 'remediation.updated', resourceType: 'remediation', resourceId: rem.id, before: { status: 'done' }, after: { status: 'open', source: `tracker:${rem.issueProvider}`, trackerStatus: state.status } });
          reopened++;
        }
      } catch (e) {
        this.log.warn(`tracker sync for remediation ${rem.id} (${rem.issueKey}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { checked, closed, reopened };
  }

  /** Creates a GitHub or Jira issue for the remediation and links it. */
  async createIssue(user: AuthenticatedUser, id: string, options: { provider?: IssueProvider; integrationId?: string; projectKey?: string } = {}) {
    const rem = await this.byId(id);
    if (rem.issueUrl) return rem;
    const [svc] = await this.db.select({ projectId: services.projectId }).from(services).where(eq(services.id, rem.serviceId)).limit(1);
    if (!svc) throw new NotFoundException('Service not found');
    const settings = await this.effectiveSettings(svc.projectId);
    const draft = await this.draft(rem);
    // the service's primary repository and the connection it came from (GitHub / GitLab / Bitbucket / plain git)
    const [repo] = await this.db.select({ repository: repositories, integration: integrations }).from(serviceRepositories).innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id)).innerJoin(integrations, eq(repositories.integrationId, integrations.id)).where(eq(serviceRepositories.serviceId, rem.serviceId)).orderBy(desc(eq(serviceRepositories.role, 'primary'))).limit(1);
    const repoHost: IssueProvider | null = !repo ? null : ['github', 'github_token'].includes(repo.integration.provider) ? 'github' : repo.integration.provider === 'gitlab' ? 'gitlab' : repo.integration.provider === 'bitbucket' ? 'bitbucket' : null;
    const integrationId = options.integrationId ?? settings.defaultIssueIntegrationId ?? null;
    const [chosen] = integrationId ? await this.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1) : [null];
    const provider: IssueProvider = options.provider ?? (chosen?.provider === 'jira' ? 'jira' : null) ?? settings.issueProvider ?? repoHost ?? 'jira';
    let created;
    if (provider === 'jira') {
      // nearest Jira connection on the project's chain (project → team → workspace → organization)
      let jira = chosen?.provider === 'jira' ? chosen : null;
      if (!jira) {
        const candidates = await this.db.select().from(integrations).where(and(eq(integrations.organizationId, rem.organizationId), eq(integrations.provider, 'jira'), inArray(integrations.status, ['connected', 'pending', 'error'])));
        for (const c of settings.chain) { jira = candidates.find((i) => i.scopeType === c.scopeType && i.scopeId === c.scopeId) ?? null; if (jira) break; }
      }
      if (!jira) throw new BadRequestException('No Jira connection on this project, its team, workspace or organization: add one under Connections → Jira Cloud');
      const creds = this.sourceSync.credentialsOf(jira);
      if (creds.type !== 'basic') throw new BadRequestException('Jira connection needs e-mail + API token');
      const projectKey = options.projectKey ?? settings.jiraProjectKey ?? String(jira.settings.projectKey ?? '');
      if (!projectKey) throw new BadRequestException('Jira project key is required: set it under Remediation → SLAs & issues (project, team, workspace or organization) or pass --project-key');
      created = await createJiraIssue(String(jira.settings.baseUrl), creds.username, creds.password, projectKey, draft, String(jira.settings.issueType ?? 'Task'));
    } else {
      if (!repo) throw new BadRequestException('The service has no repository to open the issue in; connect one or use Jira');
      const { repository, integration } = repo;
      if (provider !== repoHost) throw new BadRequestException(`The service repository is on ${repoHost ?? integration.provider}, not ${provider}; use --provider ${repoHost ?? 'jira'}`);
      if (provider === 'github') {
        const apiUrl = String(integration.settings.apiUrl ?? integration.settings.baseUrl ?? 'https://api.github.com');
        const token = integration.provider === 'github' && integration.externalAccountId ? await this.github.installationToken(integration.externalAccountId, this.githubSync.appConfigFor(integration)) : (() => { const c = this.sourceSync.credentialsOf(integration); if (c.type !== 'token') throw new BadRequestException('GitHub connection needs a token'); return c.token; })();
        created = await createGithubIssue(apiUrl, token, repository.fullName, draft);
        if (settings.issueBoard && created.nodeId) {
          if (integration.provider === 'github' && /github\.com\/users\//.test(settings.issueBoard)) this.log.warn(`issue ${created.key} created; board ${settings.issueBoard} skipped: a GitHub App can only add to organization-owned Projects (use a fine-grained token connection for user boards)`);
          else try { created.board = await addToGithubProject(apiUrl, token, settings.issueBoard, created.nodeId); }
          catch (e) { this.log.warn(`issue ${created.key} created but not added to board ${settings.issueBoard}: ${e instanceof Error ? e.message : String(e)}`); }
        }
      } else if (provider === 'gitlab') {
        const c = this.sourceSync.credentialsOf(integration);
        if (c.type !== 'token') throw new BadRequestException('GitLab connection needs a token');
        created = await createGitlabIssue(String(integration.settings.baseUrl ?? 'https://gitlab.com'), c.token, repository.externalId, draft);
      } else {
        const c = this.sourceSync.credentialsOf(integration);
        if (c.type !== 'basic') throw new BadRequestException('Bitbucket connection needs username + app password');
        created = await createBitbucketIssue({ username: c.username, password: c.password }, repository.fullName, draft);
      }
    }
    const [row] = await this.db.update(remediations).set({ issueProvider: created.provider, issueKey: created.key, issueUrl: created.url, status: rem.status === 'open' ? 'in_progress' : rem.status, updatedAt: new Date() }).where(eq(remediations.id, id)).returning();
    await this.audit.record({ organizationId: rem.organizationId, actor: userActor(user), action: 'remediation.issue_created', resourceType: 'remediation', resourceId: id, after: created });
    return row;
  }

  /** Worker: close remediations whose findings are all resolved; refresh their finding lists. */
  async reconcile(): Promise<{ closed: number }> {
    const open = await this.db.select().from(remediations).where(inArray(remediations.status, ['open', 'in_progress']));
    let closed = 0;
    for (const r of open) {
      const ids = r.kind === 'vulnerability' ? r.findingIds : r.codeFindingIds;
      if (!ids.length) continue;
      const stillOpen = r.kind === 'vulnerability'
        ? await this.db.select({ n: sql<number>`count(*)` }).from(findings).where(and(inArray(findings.id, ids), eq(findings.status, 'open'), eq(findings.running, true)))
        : await this.db.select({ n: sql<number>`count(*)` }).from(codeFindings).where(and(inArray(codeFindings.id, ids), eq(codeFindings.status, 'open')));
      if (Number(stillOpen[0]?.n ?? 0) === 0) {
        await this.db.update(remediations).set({ status: 'done', closedAt: new Date(), updatedAt: new Date() }).where(eq(remediations.id, r.id));
        await this.audit.record({ organizationId: r.organizationId, actor: SYSTEM_ACTOR, action: 'remediation.closed', resourceType: 'remediation', resourceId: r.id, after: { reason: 'all findings resolved' } });
        closed++;
      }
    }
    return { closed };
  }
}
