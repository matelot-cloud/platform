import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { userIdOrNull } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { advisories, codeFindings, exceptions, Exception, findings, FindingStatus, projects, services, teams, workspaces } from '../database/schema';
import { ScopeChain } from '../rbac/scope.types';

/**
 * Exceptions: "accept CVE-X (or rule R) in this scope until <date>, approved by <who>, because <reason>".
 * Applying one moves the matching open findings to the exception's status; expiry or revocation reverts them.
 * The gate, the risk score and the Vulnerabilities page all honour decisions, so they honour exceptions too.
 */
/** Rejects placeholders copied from examples ("CVE-YYYY-YYYY", "GHSA-xxxx-…"): such an exception would apply to nothing. */
export function assertRealMatchId(kind: 'vulnerability' | 'code', matchId: string | undefined): string {
  const match = (matchId ?? '').trim();
  const placeholder = !match || /[XY]{4}|xxxx|placeholder|example|<[^>]*>/i.test(match);
  const shape = /^(CVE-\d{4}-\d{4,}|GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|[A-Z][A-Z0-9]+-(?:CVE-)?\d{4}-\d+|[A-Z][A-Z0-9-]+-\d+)$/i;
  if (placeholder || (kind === 'vulnerability' && !shape.test(match))) throw new BadRequestException(`matchId "${match}" is not a real advisory id (expected CVE-2026-12345, GHSA-xxxx-xxxx-xxxx, DEBIAN-CVE-…, PYSEC-…)`);
  return match;
}

@Injectable()
export class ExceptionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Service ids covered by a scope (organization → every service; project → its services; service → itself). */
  private async servicesInScope(organizationId: string, scopeType: string, scopeId: string): Promise<string[]> {
    if (scopeType === 'SERVICE') return [scopeId];
    if (scopeType === 'PROJECT') return (await this.db.select({ id: services.id }).from(services).where(eq(services.projectId, scopeId))).map((s) => s.id);
    if (scopeType === 'TEAM') return (await this.db.select({ id: services.id }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).where(eq(projects.teamId, scopeId))).map((s) => s.id);
    if (scopeType === 'WORKSPACE') return (await this.db.select({ id: services.id }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).where(eq(teams.workspaceId, scopeId))).map((s) => s.id);
    return (await this.db.select({ id: services.id }).from(services).innerJoin(projects, eq(services.projectId, projects.id)).innerJoin(teams, eq(projects.teamId, teams.id)).innerJoin(workspaces, eq(teams.workspaceId, workspaces.id)).where(eq(workspaces.organizationId, organizationId))).map((s) => s.id);
  }

  /** Moves matching open findings into the exception's status; returns how many. */
  async apply(ex: Exception): Promise<number> {
    const svc = await this.servicesInScope(ex.organizationId, ex.scopeType, ex.scopeId);
    if (!svc.length) return 0;
    let n = 0;
    if (ex.kind === 'vulnerability') {
      const adv = await this.db.select({ id: advisories.id }).from(advisories).where(sql`${advisories.id} = ${ex.matchId} or ${ex.matchId} = any(${advisories.aliases})`);
      if (!adv.length) return 0;
      const rows = await this.db.select({ id: findings.id }).from(findings).where(and(inArray(findings.serviceId, svc), inArray(findings.advisoryId, adv.map((a) => a.id)), eq(findings.status, 'open'), ...(ex.matchComponent ? [sql`${findings.componentId} in (select id from components where name = ${ex.matchComponent})`] : [])));
      if (rows.length) {
        await this.db.update(findings).set({ status: ex.status, note: `exception ${ex.id}: ${ex.reason}`, statusChangedAt: new Date() }).where(inArray(findings.id, rows.map((r) => r.id)));
        await this.db.update(exceptions).set({ appliedFindingIds: [...new Set([...ex.appliedFindingIds, ...rows.map((r) => r.id)])] }).where(eq(exceptions.id, ex.id));
        n = rows.length;
      }
    } else {
      const rows = await this.db.select({ id: codeFindings.id }).from(codeFindings).where(and(inArray(codeFindings.serviceId, svc), eq(codeFindings.ruleId, ex.matchId), eq(codeFindings.status, 'open'), ...(ex.matchComponent ? [sql`${codeFindings.file} like ${ex.matchComponent + '%'}`] : [])));
      if (rows.length) {
        await this.db.update(codeFindings).set({ status: ex.status as 'accepted' | 'false_positive', note: `exception ${ex.id}: ${ex.reason}`, statusChangedAt: new Date() }).where(inArray(codeFindings.id, rows.map((r) => r.id)));
        await this.db.update(exceptions).set({ appliedCodeFindingIds: [...new Set([...ex.appliedCodeFindingIds, ...rows.map((r) => r.id)])] }).where(eq(exceptions.id, ex.id));
        n = rows.length;
      }
    }
    return n;
  }

  /** Reverts the findings an exception held, back to open. */
  private async revert(ex: Exception) {
    if (ex.appliedFindingIds.length) await this.db.update(findings).set({ status: 'open', note: null, statusChangedAt: new Date() }).where(and(inArray(findings.id, ex.appliedFindingIds), eq(findings.status, ex.status)));
    if (ex.appliedCodeFindingIds.length) await this.db.update(codeFindings).set({ status: 'open', note: null, statusChangedAt: new Date() }).where(and(inArray(codeFindings.id, ex.appliedCodeFindingIds), eq(codeFindings.status, ex.status as 'accepted')));
  }

  async byId(id: string): Promise<Exception> {
    const [row] = await this.db.select().from(exceptions).where(eq(exceptions.id, id)).limit(1);
    if (!row) throw new NotFoundException('Exception not found');
    return row;
  }

  async list(organizationId: string, filter: { scopeType?: string; scopeId?: string; active?: boolean } = {}) {
    const rows = await this.db.select().from(exceptions).where(eq(exceptions.organizationId, organizationId)).orderBy(desc(exceptions.createdAt));
    const now = Date.now();
    return rows
      .filter((e) => (!filter.scopeType || e.scopeType === filter.scopeType) && (!filter.scopeId || e.scopeId === filter.scopeId))
      .map((e) => ({ ...e, state: e.revokedAt ? 'revoked' : e.expiredAt || e.expiresAt.getTime() < now ? 'expired' : !e.approvedAt ? 'pending' : 'active', applied: e.appliedFindingIds.length + e.appliedCodeFindingIds.length }))
      .filter((e) => filter.active === undefined || (e.state === 'active') === filter.active);
  }

  async create(user: AuthenticatedUser, chain: ScopeChain, input: { kind: 'vulnerability' | 'code'; matchId: string; matchComponent?: string; status?: FindingStatus; reason: string; ticketUrl?: string; expiresAt: string; approve?: boolean }) {
    if (!input.reason?.trim()) throw new BadRequestException('reason is required');
    assertRealMatchId(input.kind, input.matchId);
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) throw new BadRequestException('expiresAt must be a future date');
    if (expiresAt.getTime() - Date.now() > 366 * 86400_000) throw new BadRequestException('an exception cannot last more than a year — renew it instead');
    const status = input.status ?? 'accepted';
    if (!['accepted', 'false_positive', 'not_affected'].includes(status)) throw new BadRequestException('status must be accepted, false_positive or not_affected');
    const [row] = await this.db.insert(exceptions).values({ organizationId: chain.organizationId, scopeType: chain.target.type, scopeId: chain.target.id, kind: input.kind, matchId: input.matchId.trim(), matchComponent: input.matchComponent?.trim() || null, status, reason: input.reason.trim(), ticketUrl: input.ticketUrl ?? null, requestedById: userIdOrNull(user), approvedById: input.approve === false ? null : userIdOrNull(user), approvedAt: input.approve === false ? null : new Date(), expiresAt }).returning();
    const applied = row.approvedAt ? await this.apply(row) : 0;
    // state: pending until an approver activates it (then the findings are actually excepted)
    await this.audit.record({ organizationId: chain.organizationId, actor: userActor(user), action: 'exception.created', resourceType: 'exception', resourceId: row.id, after: { kind: row.kind, match: row.matchId, component: row.matchComponent, scope: `${row.scopeType}:${row.scopeId}`, status, expiresAt, applied, reason: row.reason } });
    return { ...row, state: row.revokedAt ? 'revoked' : row.expiresAt.getTime() < Date.now() ? 'expired' : !row.approvedAt ? 'pending' : 'active', applied };
  }

  async approve(user: AuthenticatedUser, id: string) {
    const [row] = await this.db.update(exceptions).set({ approvedById: userIdOrNull(user), approvedAt: new Date() }).where(and(eq(exceptions.id, id), isNull(exceptions.approvedAt), isNull(exceptions.revokedAt))).returning();
    if (!row) throw new NotFoundException('Exception not found or already approved');
    const applied = await this.apply(row);
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'exception.approved', resourceType: 'exception', resourceId: row.id, after: { applied } });
    return { ...row, state: row.revokedAt ? 'revoked' : row.expiresAt.getTime() < Date.now() ? 'expired' : !row.approvedAt ? 'pending' : 'active', applied };
  }

  async revoke(user: AuthenticatedUser, id: string, reason?: string) {
    const [row] = await this.db.update(exceptions).set({ revokedAt: new Date() }).where(and(eq(exceptions.id, id), isNull(exceptions.revokedAt))).returning();
    if (!row) throw new NotFoundException('Exception not found');
    await this.revert(row);
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'exception.revoked', resourceType: 'exception', resourceId: row.id, after: { reverted: row.appliedFindingIds.length + row.appliedCodeFindingIds.length }, reason });
    return { revoked: true };
  }

  /** Worker: expire what is due, re-apply active exceptions to findings opened since (new SBOMs, new advisories). */
  async tick(): Promise<{ expired: number; applied: number }> {
    const due = await this.db.select().from(exceptions).where(and(isNull(exceptions.revokedAt), isNull(exceptions.expiredAt), lt(exceptions.expiresAt, new Date())));
    for (const ex of due) {
      await this.revert(ex);
      await this.db.update(exceptions).set({ expiredAt: new Date() }).where(eq(exceptions.id, ex.id));
      await this.audit.record({ organizationId: ex.organizationId, actor: SYSTEM_ACTOR, action: 'exception.expired', resourceType: 'exception', resourceId: ex.id, after: { match: ex.matchId, reverted: ex.appliedFindingIds.length + ex.appliedCodeFindingIds.length } });
    }
    let applied = 0;
    const active = await this.db.select().from(exceptions).where(and(isNull(exceptions.revokedAt), isNull(exceptions.expiredAt)));
    for (const ex of active) if (ex.approvedAt) applied += await this.apply(ex);
    return { expired: due.length, applied };
  }
}
