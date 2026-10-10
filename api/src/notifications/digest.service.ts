import { Inject, Injectable } from '@nestjs/common';
import { digestOfRef, environmentsBySbom, resolveRunningSboms } from '../sbom/running-sbom';
import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { advisories, deployments, environments, exceptions, findings, findingSboms, organizations, projects, sboms, services, teams, workspaces } from '../database/schema';
import { RemediationService } from '../remediation/remediation.service';
import { NotificationsService } from './notifications.service';

/** Periodic notifications: SLA overdue (daily), KEV in production (as they appear), exceptions expiring (weekly reminder). */
@Injectable()
export class DigestService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly notifications: NotificationsService,
    private readonly remediation: RemediationService,
  ) {}

  async tick(): Promise<{ overdue: number; kev: number; expiring: number }> {
    const out = { overdue: 0, kev: 0, expiring: 0 };
    const orgs = await this.db.select({ id: organizations.id, name: organizations.name }).from(organizations);
    for (const org of orgs) {
      // SLA overdue — one message per organization per day, grouped by project
      const queue = await this.remediation.queue(org.id, { limit: 500 });
      const overdue = queue.filter((i) => i.overdue);
      if (overdue.length) {
        const svcProject = new Map((await this.db.select({ id: services.id, projectId: services.projectId, projectName: projects.name }).from(services).innerJoin(projects, eq(services.projectId, projects.id))).map((s) => [s.id, s]));
        const byProject = new Map<string, typeof overdue>();
        for (const i of overdue) { const p = svcProject.get(i.serviceId)?.projectId ?? 'unknown'; byProject.set(p, [...(byProject.get(p) ?? []), i]); }
        for (const [projectId, items] of byProject) {
          const top = items.slice(0, 8).map((i) => `• ${i.severity} ${i.matchId}${i.componentName ? ` (${i.componentName})` : ''} in ${i.serviceName} — ${-i.daysLeft}d overdue${i.runsIn.includes('production') ? ' · production' : ''}`).join('\n');
          out.overdue += await this.notifications.notify({ event: 'sla.overdue', organizationId: org.id, projectId, severity: items.some((i) => i.runsIn.includes('production')) ? 'critical' : 'warning', title: `${items.length} finding${items.length === 1 ? '' : 's'} past SLA · ${svcProject.get(items[0].serviceId)?.projectName ?? 'project'}`, text: top + (items.length > 8 ? `\n… and ${items.length - 8} more` : ''), key: `sla.overdue:${projectId}`, dedupeHours: 24 });
        }
      }
      // KEV in production — notify per (service, advisory) once
      const prodSboms = (await resolveRunningSboms(this.db, { organizationId: org.id, environmentKinds: ['production'] })).filter((r) => r.sbomId).map((r) => ({ sbomId: r.sbomId!, serviceId: r.serviceId }));
      if (prodSboms.length) {
        const rows = await this.db.select({ findingId: findings.id, serviceId: findings.serviceId, advisory: advisories.id, severity: findings.severity, sbomId: findingSboms.sbomId }).from(findingSboms).innerJoin(findings, eq(findingSboms.findingId, findings.id)).innerJoin(advisories, eq(findings.advisoryId, advisories.id)).where(and(inArray(findingSboms.sbomId, prodSboms.map((p) => p.sbomId)), eq(findings.status, 'open'), eq(advisories.kev, true)));
        const seen = new Set<string>();
        for (const r of rows) {
          const key = `${r.serviceId}:${r.advisory}`;
          if (seen.has(key)) continue; seen.add(key);
          const [svc] = await this.db.select({ name: services.name, projectId: services.projectId }).from(services).where(eq(services.id, r.serviceId)).limit(1);
          out.kev += await this.notifications.notify({ event: 'kev.production', organizationId: org.id, projectId: svc?.projectId, severity: 'critical', title: `Known-exploited vulnerability in production · ${svc?.name ?? 'service'}`, text: `${r.advisory} (${r.severity}) is listed in CISA KEV and runs in production. Fix or document a decision now.`, key: `kev.production:${key}`, dedupeHours: 24 * 7 });
        }
      }
      // exceptions expiring within 7 days
      const soon = await this.db.select().from(exceptions).where(and(eq(exceptions.organizationId, org.id), isNull(exceptions.revokedAt), isNull(exceptions.expiredAt), gt(exceptions.expiresAt, new Date()), lt(exceptions.expiresAt, new Date(Date.now() + 7 * 86400_000))));
      for (const e of soon) out.expiring += await this.notifications.notify({ event: 'exception.expiring', organizationId: org.id, severity: 'warning', title: `Exception expires ${e.expiresAt.toISOString().slice(0, 10)} · ${e.matchId}`, text: `${e.kind} exception${e.matchComponent ? ` on ${e.matchComponent}` : ''} (${e.status}) expires soon; its findings reopen then. Reason: ${e.reason}`, key: `exception.expiring:${e.id}`, dedupeHours: 24 * 7 });
    }
    void teams; void workspaces;
    return out;
  }
}
