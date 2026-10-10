import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { DATABASE, Database } from '../database/database.module';
import { organizations, usageActiveUsers, usageSnapshots, type UsageMetrics } from '../database/schema';

export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
export function monthRange(month: string): { from: Date; to: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}
const previousMonth = (month: string) => monthOf(new Date(monthRange(month).from.getTime() - 1));

export const USAGE_COLUMNS = ['month', 'seats_active', 'seats_members', 'projects', 'services', 'environments', 'pipelines', 'jobs', 'runner_minutes', 'runner_minutes_managed', 'sboms'] as const;

/**
 * Usage metering per organization and month (UTC): active seats (members who used the cell that month), inventory size
 * (projects / services / environments, as of computation), pipelines, finished jobs, runner minutes (jobs run by a
 * runner, finished − started), SBOMs. The current month is computed live; past months come from snapshots the worker
 * writes hourly (and finalises once the month is over), so history survives pruning.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  /** user:month pairs already recorded by this process (one insert per user per month per process). */
  private readonly seen = new Set<string>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Called for every authenticated person (not CI tokens, not runners). Never throws, never blocks the request. */
  markActive(userId: string, now = new Date()): Promise<void> {
    const month = monthOf(now);
    const key = `${userId}:${month}`;
    if (this.seen.has(key)) return Promise.resolve();
    this.seen.add(key);
    return this.db.insert(usageActiveUsers).values({ userId, month, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: [usageActiveUsers.userId, usageActiveUsers.month], set: { lastSeenAt: now } })
      .then(() => undefined)
      .catch((e: Error) => { this.seen.delete(key); this.logger.warn(`usage: could not record activity: ${e.message}`); });
  }

  async compute(organizationId: string, month: string): Promise<UsageMetrics> {
    const { from, to } = monthRange(month);
    const org = sql`${organizationId}::uuid`;
    // every scope id in the organization's tree, for membership-based seats
    const tree = sql`
      with ws as (select id from workspaces where organization_id = ${org}),
           tm as (select id from teams where workspace_id in (select id from ws)),
           pj as (select id from projects where team_id in (select id from tm)),
           sv as (select id from services where project_id in (select id from pj)),
           ev as (select id from environments where service_id in (select id from sv)),
           members as (
             select distinct m.user_id from memberships m join users u on u.id = m.user_id
             where u.disabled_at is null and (
               (m.scope_type = 'ORGANIZATION' and m.scope_id = ${org}) or (m.scope_type = 'WORKSPACE' and m.scope_id in (select id from ws)) or
               (m.scope_type = 'TEAM' and m.scope_id in (select id from tm)) or (m.scope_type = 'PROJECT' and m.scope_id in (select id from pj)) or
               (m.scope_type = 'SERVICE' and m.scope_id in (select id from sv)) or (m.scope_type = 'ENVIRONMENT' and m.scope_id in (select id from ev))))`;
    const [counts] = (await this.db.execute(sql`${tree}
      select
        (select count(*) from members)::int as members,
        (select count(*) from usage_active_users a where a.month = ${month} and a.user_id in (select user_id from members))::int as active,
        (select count(*) from projects p where p.id in (select id from pj) and p.archived_at is null)::int as projects,
        (select count(*) from services s where s.id in (select id from sv) and s.archived_at is null)::int as services,
        (select count(*) from environments e where e.id in (select id from ev))::int as environments,
        (select count(*) from pipelines where organization_id = ${org} and created_at >= ${from} and created_at < ${to})::int as pipelines,
        (select count(*) from sboms where organization_id = ${org} and created_at >= ${from} and created_at < ${to})::int as sboms
    `)).rows as { members: number; active: number; projects: number; services: number; environments: number; pipelines: number; sboms: number }[];
    const byType = (await this.db.execute(sql`
      select j.type::text as type, count(*)::int as jobs,
             coalesce(sum(case when j.runner_id is not null and j.started_at is not null then extract(epoch from (j.finished_at - j.started_at)) else 0 end), 0)::float as seconds,
             coalesce(sum(case when j.runner_id is not null and j.started_at is not null and rp.managed then extract(epoch from (j.finished_at - j.started_at)) else 0 end), 0)::float as managed_seconds
      from jobs j left join runner_pools rp on rp.id = j.pool_id
      where j.organization_id = ${org} and j.finished_at >= ${from} and j.finished_at < ${to}
      group by j.type`)).rows as { type: string; jobs: number; seconds: number; managed_seconds: number }[];
    const minutes = (s: number) => Math.round((s / 60) * 10) / 10;
    const totalSeconds = byType.reduce((n, r) => n + r.seconds, 0);
    const runnerMinutes = minutes(totalSeconds);
    // the per-type figures add up to the total exactly: tenths of a minute apportioned by largest remainder
    const runnerMinutesByType = apportionTenths(byType.filter((r) => r.seconds > 0).map((r) => [r.type, r.seconds / 6] as const), Math.round(runnerMinutes * 10));
    // seats are tracked since the first request after metering was introduced: a month that ended before that has no
    // figure (null, shown as "—"), not a misleading 0
    return {
      seats: { active: (await this.seatsTrackedBy(to)) ? counts!.active : null, members: counts!.members },
      projects: counts!.projects,
      services: counts!.services,
      environments: counts!.environments,
      pipelines: counts!.pipelines,
      jobs: byType.reduce((n, r) => n + r.jobs, 0),
      runnerMinutes,
      runnerMinutesManaged: minutes(byType.reduce((n, r) => n + r.managed_seconds, 0)),
      runnerMinutesByType,
      sboms: counts!.sboms,
    };
  }

  /** Were seats tracked in this cell before `to` (the end of a month)? False for months that ended before the first request after metering was introduced. */
  private async seatsTrackedBy(to: Date): Promise<boolean> {
    const [tracking] = (await this.db.execute(sql`select min(first_seen_at) as since from usage_active_users`)).rows as { since: Date | string | null }[];
    return !!tracking?.since && new Date(tracking.since) < to;
  }

  /** Writes (or refreshes) the snapshot of a month; `final` once the month has ended. */
  async snapshot(organizationId: string, month: string, now = new Date()) {
    const metrics = await this.compute(organizationId, month);
    const final = monthRange(month).to <= now;
    await this.db.insert(usageSnapshots).values({ organizationId, month, metrics, final, computedAt: now })
      .onConflictDoUpdate({ target: [usageSnapshots.organizationId, usageSnapshots.month], set: { metrics, final, computedAt: now } });
    return metrics;
  }

  /** Worker pass: current month of every organization, plus last month once (until it is final). */
  async snapshotAll(now = new Date()): Promise<{ organizations: number; finalised: number }> {
    const orgs = await this.db.select({ id: organizations.id }).from(organizations);
    const current = monthOf(now);
    const last = previousMonth(current);
    let finalised = 0;
    for (const o of orgs) {
      await this.snapshot(o.id, current, now);
      const [prev] = await this.db.select({ final: usageSnapshots.final }).from(usageSnapshots).where(and(eq(usageSnapshots.organizationId, o.id), eq(usageSnapshots.month, last))).limit(1);
      if (!prev?.final) { await this.snapshot(o.id, last, now); finalised++; }
    }
    return { organizations: orgs.length, finalised };
  }

  /** The requested month (live when it is the current month or has no snapshot) and up to 12 months of history. */
  async report(organizationId: string, month?: string, now = new Date()) {
    const target = month ?? monthOf(now);
    monthRange(target);
    const [stored] = await this.db.select().from(usageSnapshots).where(and(eq(usageSnapshots.organizationId, organizationId), eq(usageSnapshots.month, target))).limit(1);
    const live = target === monthOf(now) || !stored;
    const metrics = live ? await this.compute(organizationId, target) : stored.metrics;
    const since = monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)));
    const rows = await this.db.select().from(usageSnapshots).where(and(eq(usageSnapshots.organizationId, organizationId), gte(usageSnapshots.month, since), lt(usageSnapshots.month, '9999'))).orderBy(desc(usageSnapshots.month));
    // snapshots written before the "not tracked" rule stored 0 seats for months without tracking: present them as unknown
    const unknownSeats = async (m: UsageMetrics, mo: string): Promise<UsageMetrics> => (m.seats.active === 0 && !(await this.seatsTrackedBy(monthRange(mo).to)) ? { ...m, seats: { ...m.seats, active: null } } : m);
    const history: { month: string; final: boolean; computedAt: Date; metrics: UsageMetrics }[] = [];
    for (const r of rows) if (r.month !== target) history.push({ month: r.month, final: r.final, computedAt: r.computedAt, metrics: await unknownSeats(r.metrics, r.month) });
    const shown = live ? metrics : await unknownSeats(metrics, target);
    history.push({ month: target, final: !live && stored.final, computedAt: live ? now : stored.computedAt, metrics: shown });
    history.sort((a, b) => b.month.localeCompare(a.month));
    return { organizationId, month: target, live, computedAt: live ? now : stored.computedAt, metrics: shown, history };
  }

  toCsv(history: { month: string; metrics: UsageMetrics }[]): string {
    const lines = [USAGE_COLUMNS.join(',')];
    for (const h of history) {
      const m = h.metrics;
      lines.push([h.month, m.seats.active ?? '', m.seats.members, m.projects, m.services, m.environments, m.pipelines, m.jobs, m.runnerMinutes, m.runnerMinutesManaged ?? 0, m.sboms].join(','));
    }
    return lines.join('\n') + '\n';
  }
}

/** Split `totalTenths` across the entries in proportion to their raw tenths so that the rounded parts sum exactly to the total. */
export function apportionTenths(entries: readonly (readonly [string, number])[], totalTenths: number): Record<string, number> {
  if (!entries.length) return {};
  const floors = entries.map(([, raw]) => Math.floor(raw));
  let left = totalTenths - floors.reduce((n, v) => n + v, 0);
  const order = entries.map((e, i) => ({ i, frac: e[1] - floors[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; floors[i]! += 1; left--; }
  // (left < 0 cannot happen: the floors never exceed the rounded total; left > entries.length only on absurd input)
  for (let k = 0; left > 0; k = (k + 1) % entries.length) { floors[k]! += 1; left--; }
  return Object.fromEntries(entries.map(([type], i) => [type, floors[i]! / 10]));
}

