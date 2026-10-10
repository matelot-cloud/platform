import { projectCondition, ProjectScope } from '../rbac/scope-projects';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, notInArray, or, sql, SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Optional } from '@nestjs/common';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { userIdOrNull } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { codeFindings, FindingStatus, projects, repositories, serviceRepositories, services, Severity } from '../database/schema';

export interface CodeFindingInput {
  kind: 'secret' | 'iac' | 'sast';
  ruleId: string;
  title: string;
  severity: Severity;
  file: string;
  startLine: number | null;
  endLine: number | null;
  evidence: string | null;
  resolution: string | null;
  references: string[];
  fingerprint: string;
  category: string | null;
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'unknown']);

@Injectable()
export class CodeFindingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** Stores one scan: upserts reported findings, closes those of this kind that the scan no longer reports. */
  async ingest(input: { organizationId: string; serviceId: string; jobId: string; kind: 'secret' | 'iac' | 'sast'; ref: string; findings: CodeFindingInput[] }) {
    if (input.findings.length > 20000) throw new BadRequestException('too many findings in one scan');
    const [primary] = await this.db.select({ id: repositories.id }).from(serviceRepositories).innerJoin(repositories, eq(serviceRepositories.repositoryId, repositories.id)).where(eq(serviceRepositories.serviceId, input.serviceId)).orderBy(desc(sql`${serviceRepositories.role} = 'primary'`)).limit(1);
    const now = new Date();
    let opened = 0;
    let seen = 0;
    const fingerprints: string[] = [];
    for (const f of input.findings) {
      if (f.kind !== input.kind) continue;
      const severity = (SEVERITIES.has(f.severity) ? f.severity : 'unknown') as Severity;
      // Defence in depth: evidence of secrets is re-redacted server-side.
      const evidence = f.kind === 'secret' && f.evidence ? f.evidence.replace(/([A-Za-z0-9+/_\-]{6})[A-Za-z0-9+/=_\-]{10,}/g, '$1****').slice(0, 300) : (f.evidence ?? null)?.slice(0, 2000) ?? null;
      fingerprints.push(f.fingerprint);
      const [existing] = await this.db.select({ id: codeFindings.id, status: codeFindings.status }).from(codeFindings).where(and(eq(codeFindings.serviceId, input.serviceId), eq(codeFindings.kind, input.kind), eq(codeFindings.fingerprint, f.fingerprint))).limit(1);
      if (existing) {
        seen++;
        await this.db.update(codeFindings).set({ title: f.title.slice(0, 500), severity, file: f.file.slice(0, 1000), startLine: f.startLine, endLine: f.endLine, evidence, resolution: f.resolution?.slice(0, 2000) ?? null, references: f.references.slice(0, 5), category: f.category, ref: input.ref, lastJobId: input.jobId, lastSeenAt: now, ...(existing.status === 'fixed' ? { status: 'open', resolvedAt: null } : {}) }).where(eq(codeFindings.id, existing.id));
        if (existing.status === 'fixed') opened++;
      } else {
        const [row] = await this.db.insert(codeFindings).values({ organizationId: input.organizationId, serviceId: input.serviceId, repositoryId: primary?.id ?? null, kind: input.kind, ruleId: f.ruleId.slice(0, 200), title: f.title.slice(0, 500), severity, category: f.category, file: f.file.slice(0, 1000), startLine: f.startLine, endLine: f.endLine, evidence, resolution: f.resolution?.slice(0, 2000) ?? null, references: f.references.slice(0, 5), fingerprint: f.fingerprint, ref: input.ref, lastJobId: input.jobId, firstSeenAt: now, lastSeenAt: now }).onConflictDoNothing().returning({ id: codeFindings.id });
        if (row) {
          opened++;
          if (input.kind === 'secret' && this.notifications) void this.notifications.notify({ event: 'secret.detected', organizationId: input.organizationId, severity: 'critical', title: `Secret committed · ${f.file}`, text: `${f.title} (${f.ruleId}) found in the repository. Rotate it and remove it from history.`, fields: { file: f.file, rule: f.ruleId, service: input.serviceId }, key: `secret:${row.id}` });
          await this.audit.record({ organizationId: input.organizationId, actor: SYSTEM_ACTOR, action: 'code_finding.opened', resourceType: 'code_finding', resourceId: row.id, after: { kind: input.kind, rule: f.ruleId, file: f.file, severity } });
        }
      }
    }
    // Not reported any more → fixed (open and accepted); false positives keep their verdict.
    const gone = await this.db.update(codeFindings).set({ status: 'fixed', resolvedAt: now }).where(and(eq(codeFindings.serviceId, input.serviceId), eq(codeFindings.kind, input.kind), inArray(codeFindings.status, ['open', 'accepted']), fingerprints.length ? notInArray(codeFindings.fingerprint, fingerprints) : undefined)).returning({ id: codeFindings.id });
    return { opened, seen, fixed: gone.length };
  }

  async list(organizationId: string, filters: { projectId?: ProjectScope; serviceId?: string; kind?: string[]; severity?: string[]; status?: string[]; q?: string }) {
    const where: (SQL | undefined)[] = [eq(codeFindings.organizationId, organizationId)];
    if (filters.serviceId) where.push(eq(codeFindings.serviceId, filters.serviceId));
    const pc = projectCondition(services.projectId, filters.projectId); if (pc) where.push(pc);
    if (filters.kind?.length) where.push(inArray(codeFindings.kind, filters.kind as ('secret' | 'iac' | 'sast')[]));
    if (filters.severity?.length) where.push(inArray(codeFindings.severity, filters.severity as Severity[]));
    where.push(inArray(codeFindings.status, (filters.status?.length ? filters.status : ['open']) as FindingStatus[]));
    if (filters.q) where.push(or(ilike(codeFindings.file, `%${filters.q}%`), ilike(codeFindings.ruleId, `%${filters.q}%`), ilike(codeFindings.title, `%${filters.q}%`)));
    const rows = await this.db
      .select({ f: codeFindings, serviceName: services.name, projectId: projects.id, projectName: projects.name, repoFullName: repositories.fullName, repoUrl: repositories.htmlUrl })
      .from(codeFindings)
      .innerJoin(services, eq(codeFindings.serviceId, services.id))
      .innerJoin(projects, eq(services.projectId, projects.id))
      .leftJoin(repositories, eq(codeFindings.repositoryId, repositories.id))
      .where(and(...where.filter((w): w is SQL => !!w)))
      .orderBy(sql`case ${codeFindings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`, codeFindings.file, codeFindings.startLine)
      .limit(2000);
    return rows.map((r) => ({ ...r.f, serviceName: r.serviceName, projectId: r.projectId, projectName: r.projectName, repository: r.repoFullName, fileUrl: r.repoUrl && r.f.ref ? `${r.repoUrl}/blob/${r.f.ref}/${r.f.file}${r.f.startLine ? `#L${r.f.startLine}` : ''}` : null }));
  }

  async summary(organizationId: string, projectId?: ProjectScope) {
    const rows = await this.db
      .select({ kind: codeFindings.kind, severity: codeFindings.severity, n: sql<number>`count(*)` })
      .from(codeFindings)
      .innerJoin(services, eq(codeFindings.serviceId, services.id))
      .where(and(eq(codeFindings.organizationId, organizationId), eq(codeFindings.status, 'open'), projectCondition(services.projectId, projectId) ?? undefined))
      .groupBy(codeFindings.kind, codeFindings.severity);
    const out = { secret: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, iac: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, sast: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } };
    for (const r of rows) out[r.kind][r.severity] = Number(r.n);
    return out;
  }

  async serviceOf(id: string): Promise<string> {
    const [r] = await this.db.select({ serviceId: codeFindings.serviceId }).from(codeFindings).where(eq(codeFindings.id, id)).limit(1);
    if (!r) throw new NotFoundException('Finding not found');
    return r.serviceId;
  }

  async setStatus(user: AuthenticatedUser, id: string, status: FindingStatus, note?: string) {
    if (status === 'fixed') throw new BadRequestException('"fixed" is set by the platform when a scan no longer reports it');
    const [before] = await this.db.select().from(codeFindings).where(eq(codeFindings.id, id)).limit(1);
    if (!before) throw new NotFoundException('Finding not found');
    const [after] = await this.db.update(codeFindings).set({ status, note: note ?? before.note, statusChangedById: userIdOrNull(user), statusChangedAt: new Date(), resolvedAt: status === 'open' ? null : new Date() }).where(eq(codeFindings.id, id)).returning();
    await this.audit.record({ organizationId: before.organizationId, actor: userActor(user), action: 'code_finding.status_changed', resourceType: 'code_finding', resourceId: id, before: { status: before.status }, after: { status, note: note ?? null, rule: before.ruleId, file: before.file } });
    return after;
  }
}
