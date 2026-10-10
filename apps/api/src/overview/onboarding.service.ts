import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { organizations } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import type { ScopeChain } from '../rbac/scope.types';

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  done: boolean;
  /** Where to do it in the web app (an organization-level page). */
  href: string;
  /** The same with the CLI. */
  cli: string | null;
  /** What was found, e.g. "2 connections". */
  detail: string | null;
  optional?: boolean;
}

/**
 * Organization setup: the one-time, organization-level steps, computed from what exists — connect source code, get a
 * runner working, send alerts somewhere (optional), invite the team (optional). Per-service work (repository,
 * pipeline, SBOM, policy, deployment) is not setup but coverage, which never "completes": see CoverageService.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
  ) {}

  /** Who the Overview card is for: people who can act on the organization's setup. Everyone else never sees it. */
  async canManage(user: AuthenticatedUser, chain: ScopeChain): Promise<boolean> {
    if (user.platformRole === 'admin') return true;
    return this.authz.can(await this.access.forUser(user.id), 'organization:write', chain);
  }

  async status(organizationId: string, opts: { canManage?: boolean } = {}) {
    const [org] = await this.db.select({ id: organizations.id, dismissedAt: organizations.onboardingDismissedAt, completedAt: organizations.onboardingCompletedAt }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    if (!org) throw new NotFoundException('Organization not found');
    const o = sql`${organizationId}::uuid`;
    const [c] = (await this.db.execute(sql`
      with ws as (select id from workspaces where organization_id = ${o} and archived_at is null),
           tm as (select id from teams where workspace_id in (select id from ws) and archived_at is null),
           pj as (select id from projects where team_id in (select id from tm) and archived_at is null)
      select
        (select count(*) from integrations where organization_id = ${o} and provider <> 'registry' and provider <> 'jira' and status <> 'disconnected')::int as sources,
        (select count(*) from runners r join runner_pools p on p.id = r.pool_id where (p.organization_id = ${o} or p.managed) and r.status <> 'offline')::int as runners_online,
        (select count(*) from jobs where organization_id = ${o} and pool_id is not null and finished_at is not null)::int as runner_jobs,
        (select count(*) from notification_channels where organization_id = ${o})::int as channels,
        (select count(distinct m.user_id) from memberships m where (m.scope_type = 'ORGANIZATION' and m.scope_id = ${o}) or (m.scope_type = 'WORKSPACE' and m.scope_id in (select id from ws)) or (m.scope_type = 'TEAM' and m.scope_id in (select id from tm)) or (m.scope_type = 'PROJECT' and m.scope_id in (select id from pj)))::int as members
    `)).rows as {
      sources: number; runners_online: number; runner_jobs: number; channels: number; members: number;
    }[];
    const n = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
    const steps: OnboardingStep[] = [
      { id: 'connect_source', title: 'Connect your source code', description: 'GitHub App, GitLab, Bitbucket or any git repository — at the organization or any level below.', done: c!.sources > 0, href: '/connections', cli: `matelot connection create --org ${organizationId} --body …`, detail: n(c!.sources, 'source connection') },
      { id: 'runner_online', title: 'Get a runner working', description: 'The cell\'s managed runners run pipelines out of the box; add a pool of your own for private networks.', done: c!.runners_online > 0 || c!.runner_jobs > 0, href: '/runners', cli: 'matelot runners list', detail: c!.runner_jobs ? `${n(c!.runner_jobs, 'job')} run by runners` : `${c!.runners_online} online, no jobs run yet` },
      { id: 'notifications', title: 'Send alerts somewhere', description: 'Slack, Teams, e-mail or a webhook for failed gates, overdue SLAs and new known-exploited vulnerabilities.', done: c!.channels > 0, href: '/notifications', cli: null, detail: n(c!.channels, 'channel'), optional: true },
      { id: 'invite_team', title: 'Invite your team', description: 'Grant roles at the organization, a workspace, a team or a project.', done: c!.members > 1, href: '/members', cli: 'matelot membership grant --email <email> --role DEVELOPER --scope-type PROJECT --scope-id <id>', detail: n(c!.members, 'member'), optional: true },
    ];
    const required = steps.filter((s) => !s.optional);
    const completed = steps.filter((s) => s.done).length;
    const complete = required.every((s) => s.done);
    // the first time setup is complete is remembered: the card never comes back by itself afterwards
    let completedAt = org.completedAt;
    if (complete && !completedAt) {
      completedAt = new Date();
      await this.db.update(organizations).set({ onboardingCompletedAt: completedAt }).where(eq(organizations.id, organizationId));
    }
    return {
      organizationId,
      canManage: opts.canManage ?? false,
      steps,
      completed,
      total: steps.length,
      requiredRemaining: required.filter((s) => !s.done).length,
      complete,
      completedAt,
      dismissedAt: org.dismissedAt,
      /** Shown on the Overview until setup was complete once, unless an administrator hid it (and only to them: canManage). */
      visible: !org.dismissedAt && !completedAt,
      next: steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done) ?? null,
    };
  }

  async setDismissed(user: AuthenticatedUser, organizationId: string, dismissed: boolean) {
    const [before] = await this.db.select({ dismissedAt: organizations.onboardingDismissedAt }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    if (!before) throw new NotFoundException('Organization not found');
    await this.db.update(organizations).set({ onboardingDismissedAt: dismissed ? new Date() : null }).where(eq(organizations.id, organizationId));
    await this.audit.record({ organizationId, actor: userActor(user), action: dismissed ? 'onboarding.dismissed' : 'onboarding.restored', resourceType: 'organization', resourceId: organizationId, before: { dismissedAt: before.dismissedAt }, after: { dismissed } });
    return this.status(organizationId, { canManage: true });
  }
}
