import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { buildChain, type ScopeChain } from '../rbac/scope.types';

export const COVERAGE_CHECKS = ['repository', 'pipeline', 'sbom', 'policy', 'deployment'] as const;
export type CoverageCheckId = (typeof COVERAGE_CHECKS)[number];
/** ok: covered · stale: was covered, too long ago (security pipeline older than `days`) · missing: never. */
export type CoverageState = 'ok' | 'stale' | 'missing';

export interface CoverageCheck {
  id: CoverageCheckId;
  title: string;
  state: CoverageState;
  /** What was found, e.g. "last finished 40 days ago", "2 policies apply (inherited)". */
  detail: string;
  /** Where to fix it in the web app, and the same with the CLI (ids filled in); null when ok. */
  href: string | null;
  cli: string | null;
}

export interface ServiceCoverage {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  covered: boolean;
  gaps: CoverageCheckId[];
  checks: CoverageCheck[];
}

export interface CoverageSummary {
  days: number;
  services: number;
  /** Services with every check ok. */
  covered: number;
  checks: Record<CoverageCheckId, { title: string; ok: number; stale: number; missing: number }>;
}

const TITLES: Record<CoverageCheckId, string> = {
  repository: 'Repository attached',
  pipeline: 'Security pipeline',
  sbom: 'SBOM',
  policy: 'Policy applies',
  deployment: 'Deployment recorded',
};

interface Row {
  service_id: string; service_name: string; service_slug: string; project_id: string; project_name: string; team_id: string; workspace_id: string;
  repositories: number; last_pipeline_at: string | Date | null; pipelines: number; sboms: number; policies: number; inherited_policies: number;
  environments: number; first_environment: string | null; deployments: number;
}

export const DEFAULT_COVERAGE_DAYS = 30;
export function parseDays(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_COVERAGE_DAYS;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new BadRequestException('days must be a whole number between 1 and 365');
  return n;
}
export function parseGap(v: unknown): CoverageCheckId | null {
  if (v === undefined || v === null || v === '') return null;
  if (!COVERAGE_CHECKS.includes(v as CoverageCheckId)) throw new BadRequestException(`gap must be one of ${COVERAGE_CHECKS.join(', ')}`);
  return v as CoverageCheckId;
}

/**
 * Service coverage: per service, is it actually under the platform's watch — a repository attached, a security pipeline
 * finished recently, an SBOM, a policy that applies (inherited counts), a deployment recorded. Unlike the one-time
 * organization setup this is permanent, computed from data, and visible to everyone who can read the project.
 */
@Injectable()
export class CoverageService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
  ) {}

  /** Every service of a project with its checks. */
  async forProject(projectId: string, opts: { days?: number; gap?: CoverageCheckId | null; uncovered?: boolean } = {}) {
    const days = opts.days ?? DEFAULT_COVERAGE_DAYS;
    const all = (await this.rows(sql`p.id = ${projectId}::uuid`)).map((r) => evaluate(r, days));
    return { projectId, days, summary: summarize(all, days), services: filter(all, opts.gap ?? null, opts.uncovered ?? false) };
  }

  /** Organization-wide: summary over the services of the projects this user can read, and the uncovered ones. */
  async forOrganization(user: AuthenticatedUser, orgChain: ScopeChain, opts: { days?: number; gap?: CoverageCheckId | null; limit?: number } = {}) {
    const days = opts.days ?? DEFAULT_COVERAGE_DAYS;
    let rows = await this.rows(sql`w.organization_id = ${orgChain.organizationId}::uuid`);
    if (user.platformRole !== 'admin') {
      const ctx = await this.access.forUser(user.id);
      if (!this.authz.hasPermission(ctx, 'project:read', orgChain)) {
        const readable = new Map<string, boolean>();
        rows = rows.filter((r) => {
          if (!readable.has(r.project_id)) readable.set(r.project_id, this.authz.can(ctx, 'project:read', buildChain({ organizationId: orgChain.organizationId, workspaceId: r.workspace_id, teamId: r.team_id, projectId: r.project_id }, orgChain.organizationAncestorIds)));
          return readable.get(r.project_id)!;
        });
      }
    }
    const all = rows.map((r) => evaluate(r, days));
    const uncovered = filter(all, opts.gap ?? null, true);
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    return { organizationId: orgChain.organizationId, days, gap: opts.gap ?? null, summary: summarize(all, days), uncoveredTotal: uncovered.length, uncovered: uncovered.slice(0, limit) };
  }

  private async rows(where: SQL): Promise<Row[]> {
    return (await this.db.execute(sql`
      select s.id as service_id, s.name as service_name, s.slug as service_slug, p.id as project_id, p.name as project_name, t.id as team_id, w.id as workspace_id,
        (select count(*) from service_repositories sr where sr.service_id = s.id)::int as repositories,
        (select max(pl.finished_at) from pipelines pl where pl.service_id = s.id and pl.status in ('succeeded', 'failed') and pl.finished_at is not null) as last_pipeline_at,
        (select count(*) from pipelines pl where pl.service_id = s.id)::int as pipelines,
        (select count(*) from sboms sb where sb.service_id = s.id)::int as sboms,
        (select count(*) from policies po where po.organization_id = w.organization_id and po.enabled and (
          (po.scope_type = 'ORGANIZATION' and po.scope_id = w.organization_id) or (po.scope_type = 'WORKSPACE' and po.scope_id = w.id) or
          (po.scope_type = 'TEAM' and po.scope_id = t.id) or (po.scope_type = 'PROJECT' and po.scope_id = p.id) or (po.scope_type = 'SERVICE' and po.scope_id = s.id) or
          (po.scope_type = 'ENVIRONMENT' and po.scope_id in (select e.id from environments e where e.service_id = s.id))))::int as policies,
        (select count(*) from policies po where po.organization_id = w.organization_id and po.enabled and (
          (po.scope_type = 'ORGANIZATION' and po.scope_id = w.organization_id) or (po.scope_type = 'WORKSPACE' and po.scope_id = w.id) or
          (po.scope_type = 'TEAM' and po.scope_id = t.id)))::int as inherited_policies,
        (select count(*) from environments e where e.service_id = s.id and e.archived_at is null)::int as environments,
        (select e.id from environments e where e.service_id = s.id and e.archived_at is null order by (e.kind = 'production') desc, e.slug limit 1) as first_environment,
        (select count(*) from deployments d where d.service_id = s.id)::int as deployments
      from services s
      join projects p on p.id = s.project_id
      join teams t on t.id = p.team_id
      join workspaces w on w.id = t.workspace_id
      where s.archived_at is null and p.archived_at is null and t.archived_at is null and w.archived_at is null and ${where}
      order by w.name, p.name, s.name
    `)).rows as unknown as Row[];
  }
}

const plural = (v: number, one: string, many = `${one}s`) => `${v} ${v === 1 ? one : many}`;
const ago = (d: Date) => { const days = Math.floor((Date.now() - d.getTime()) / 86_400_000); return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`; };

/** The five checks of one service, each with what to do when it is not ok. */
export function evaluate(r: Row, days: number, now = Date.now()): ServiceCoverage {
  const p = r.project_id;
  const s = r.service_id;
  const last = r.last_pipeline_at ? new Date(r.last_pipeline_at) : null;
  const pipelineState: CoverageState = !last ? 'missing' : now - last.getTime() > days * 86_400_000 ? 'stale' : 'ok';
  const check = (id: CoverageCheckId, state: CoverageState, detail: string, href: string, cli: string): CoverageCheck =>
    ({ id, title: TITLES[id], state, detail, href: state === 'ok' ? null : href, cli: state === 'ok' ? null : cli });
  const checks: CoverageCheck[] = [
    check('repository', r.repositories > 0 ? 'ok' : 'missing', r.repositories > 0 ? plural(r.repositories, 'repository', 'repositories') : 'no repository attached',
      `/projects/${p}/services`, `matelot repository attach --service ${s} --repository-id <id>`),
    check('pipeline', pipelineState, last ? `last finished ${ago(last)}${pipelineState === 'stale' ? ` (older than ${days === 1 ? '1 day' : `${days} days`})` : ''}` : r.pipelines ? `${plural(r.pipelines, 'pipeline')}, none finished` : 'never run',
      `/projects/${p}/pipelines`, `matelot pipeline --service ${s} --template security --wait`),
    check('sbom', r.sboms > 0 ? 'ok' : 'missing', r.sboms > 0 ? plural(r.sboms, 'SBOM') : 'no SBOM',
      `/projects/${p}/inventory`, `matelot sbom --service ${s} --file bom.json --target source`),
    check('policy', r.policies > 0 ? 'ok' : 'missing', r.policies > 0 ? `${plural(r.policies, 'policy', 'policies')} ${r.policies === 1 ? 'applies' : 'apply'}${r.inherited_policies ? ` (${r.inherited_policies} inherited)` : ''}` : 'no policy applies',
      `/projects/${p}/policies`, `matelot policy from-template-project --project ${p} --template production-baseline`),
    check('deployment', r.deployments > 0 ? 'ok' : 'missing', r.deployments > 0 ? plural(r.deployments, 'deployment') : r.environments ? `${plural(r.environments, 'environment')}, no deployment` : 'no environment',
      `/projects/${p}/environments`, r.first_environment ? `matelot deploy --env ${r.first_environment} --image <ref>` : `matelot env create --service ${s} --slug production --name Production --kind production`),
  ];
  const gaps = checks.filter((c) => c.state !== 'ok').map((c) => c.id);
  return { serviceId: s, serviceName: r.service_name, serviceSlug: r.service_slug, projectId: p, projectName: r.project_name, workspaceId: r.workspace_id, covered: gaps.length === 0, gaps, checks };
}

export function summarize(all: ServiceCoverage[], days: number): CoverageSummary {
  const checks = Object.fromEntries(COVERAGE_CHECKS.map((id) => [id, { title: TITLES[id], ok: 0, stale: 0, missing: 0 }])) as CoverageSummary['checks'];
  for (const svc of all) for (const c of svc.checks) checks[c.id][c.state]++;
  return { days, services: all.length, covered: all.filter((s) => s.covered).length, checks };
}

function filter(all: ServiceCoverage[], gap: CoverageCheckId | null, uncoveredOnly: boolean) {
  return all.filter((s) => (gap ? s.gaps.includes(gap) : !uncoveredOnly || !s.covered));
}
