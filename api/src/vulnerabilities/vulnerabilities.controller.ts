import { Inject, Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, NotFoundException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { FindingStatus, Severity } from '../database/schema';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { projectIdsForChain } from '../rbac/scope-projects';
import { DATABASE, Database } from '../database/database.module';
import { ScopeChain } from '../rbac/scope.types';
import { CodeFindingsService } from './code-findings.service';
import { CorrelationJob, CorrelationService } from './correlation.service';
import { FindingsService } from './findings.service';
import { SnapshotsService } from './snapshots.service';

class StatusDto {
  @IsIn(['open', 'accepted', 'false_positive', 'not_affected']) status: FindingStatus;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

function jobView(j: CorrelationJob) { return { jobId: j.id, status: j.status, position: j.position, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, result: j.result, error: j.error }; }

const parseList = <T extends string>(v: string | undefined): T[] | undefined => (v ? (v.split(',').filter(Boolean) as T[]) : undefined);

@ApiTags('vulnerabilities')
@ApiBearerAuth()
@Controller()
export class VulnerabilitiesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly findings: FindingsService,
    private readonly code: CodeFindingsService,
    private readonly correlation: CorrelationService,
    private readonly snapshots: SnapshotsService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
  ) {}

  @Get('organizations/:organizationId/findings')
  @RequirePermission('vulnerability:read')
  async list(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Query('severity') severity?: string, @Query('status') status?: string, @Query('kev') kev?: string, @Query('q') q?: string, @Query('projectId') projectId?: string, @Query('running') running?: string) {
    const rows = await this.findings.list(chain.organizationId, { severity: parseList<Severity>(severity), status: parseList<FindingStatus>(status) ?? ['open'], kev: kev === 'true', q, projectId, running: running === 'true' });
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'vulnerability:read', chain)) return rows;
    const visible = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (!visible.has(r.projectId)) {
        const pc = await this.resolver.resolveChain({ projectId: r.projectId }).catch(() => null);
        visible.set(r.projectId, !!pc && this.authz.can(ctx, 'vulnerability:read', pc));
      }
      if (visible.get(r.projectId)) out.push(r);
    }
    return out;
  }

  @Get('organizations/:organizationId/findings/summary')
  @RequirePermission('vulnerability:read')
  summary(@Scope() chain: ScopeChain) {
    return this.findings.summary(chain.organizationId);
  }

  /** "Running in" panel: environments with what runs there and its open findings. */
  @Get('organizations/:organizationId/findings/environments')
  @RequirePermission('vulnerability:read')
  async environmentsOrg(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    const rows = await this.findings.environments(chain.organizationId);
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'vulnerability:read', chain)) return rows;
    const visible = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (!visible.has(r.projectId)) {
        const pc = await this.resolver.resolveChain({ projectId: r.projectId }).catch(() => null);
        visible.set(r.projectId, !!pc && this.authz.can(ctx, 'vulnerability:read', pc));
      }
      if (visible.get(r.projectId)) out.push(r);
    }
    return out;
  }

  /** Trend: daily open findings per environment (org-wide, visibility-filtered). */
  @Get('organizations/:organizationId/findings/trend')
  @RequirePermission('vulnerability:read')
  async trendOrg(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Query('days') days?: string) {
    const series = await this.snapshots.trend(chain.organizationId, Math.min(365, Math.max(7, Number(days) || 30)));
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'vulnerability:read', chain)) return series;
    const out = [];
    for (const s of series) {
      const pc = await this.resolver.resolveChain({ projectId: s.projectId }).catch(() => null);
      if (pc && this.authz.can(ctx, 'vulnerability:read', pc)) out.push(s);
    }
    return out;
  }

  @Get('projects/:projectId/findings/trend')
  @RequirePermission('vulnerability:read')
  trendProject(@Scope() chain: ScopeChain, @Query('days') days?: string) {
    return this.snapshots.trend(chain.organizationId, Math.min(365, Math.max(7, Number(days) || 30)), chain.projectId!);
  }

  /** Recompute today's snapshots and backfill history (admins / security). */
  @Post('organizations/:organizationId/findings/snapshots')
  @RequirePermission('vulnerability:write')
  async snapshotNow(@Scope() chain: ScopeChain, @Query('backfillDays') backfillDays?: string) {
    void chain;
    const backfilled = await this.snapshots.backfill(Math.min(365, Number(backfillDays) || 90));
    const today = await this.snapshots.snapshotToday();
    return { today, backfilled };
  }

  @Get('projects/:projectId/findings/environments')
  @RequirePermission('vulnerability:read')
  environmentsProject(@Scope() chain: ScopeChain) {
    return this.findings.environments(chain.organizationId, chain.projectId!);
  }


  // ---- workspace / team scope (the projects underneath)
  @Get(['workspaces/:workspaceId/findings', 'teams/:teamId/findings'])
  @RequirePermission('vulnerability:read')
  async scopedList(@Scope() chain: ScopeChain, @Query('severity') severity?: string, @Query('status') status?: string, @Query('kev') kev?: string, @Query('q') q?: string, @Query('team') team?: string) {
    return this.findings.list(chain.organizationId, { projectId: await this.scopeProjects(chain, team), severity: parseList<Severity>(severity), status: parseList<FindingStatus>(status) ?? ['open'], kev: kev === 'true', q });
  }
  @Get(['workspaces/:workspaceId/findings/summary', 'teams/:teamId/findings/summary'])
  @RequirePermission('vulnerability:read')
  async scopedSummary(@Scope() chain: ScopeChain, @Query('team') team?: string) { return this.findings.summary(chain.organizationId, await this.scopeProjects(chain, team)); }
  @Get(['workspaces/:workspaceId/findings/environments', 'teams/:teamId/findings/environments'])
  @RequirePermission('vulnerability:read')
  async scopedEnvironments(@Scope() chain: ScopeChain, @Query('team') team?: string) { return this.findings.environments(chain.organizationId, await this.scopeProjects(chain, team)); }
  @Get(['workspaces/:workspaceId/findings/trend', 'teams/:teamId/findings/trend'])
  @RequirePermission('vulnerability:read')
  async scopedTrend(@Scope() chain: ScopeChain, @Query('days') days?: string, @Query('team') team?: string) { return this.snapshots.trend(chain.organizationId, Math.min(365, Math.max(7, Number(days) || 30)), await this.scopeProjects(chain, team)); }
  @Get(['workspaces/:workspaceId/code-findings', 'teams/:teamId/code-findings'])
  @RequirePermission('vulnerability:read')
  async scopedCode(@Scope() chain: ScopeChain, @Query('kind') kind?: string, @Query('severity') severity?: string, @Query('status') status?: string, @Query('q') q?: string, @Query('team') team?: string) { return this.code.list(chain.organizationId, { projectId: await this.scopeProjects(chain, team), kind: parseList(kind), severity: parseList(severity), status: parseList(status), q }); }
  @Get(['workspaces/:workspaceId/code-findings/summary', 'teams/:teamId/code-findings/summary'])
  @RequirePermission('vulnerability:read')
  async scopedCodeSummary(@Scope() chain: ScopeChain, @Query('team') team?: string) { return this.code.summary(chain.organizationId, await this.scopeProjects(chain, team)); }
  /** Projects of the chain; `?team=` narrows a workspace to one of its teams. */
  private async scopeProjects(chain: ScopeChain, team?: string) {
    if (team) return projectIdsForChain(this.db, { ...chain, teamId: team, projectId: undefined } as ScopeChain);
    return projectIdsForChain(this.db, chain);
  }

  @Get('projects/:projectId/findings')
  @RequirePermission('vulnerability:read')
  projectList(@Scope() chain: ScopeChain, @Query('severity') severity?: string, @Query('status') status?: string, @Query('kev') kev?: string, @Query('q') q?: string) {
    return this.findings.list(chain.organizationId, { projectId: chain.projectId!, severity: parseList<Severity>(severity), status: parseList<FindingStatus>(status) ?? ['open'], kev: kev === 'true', q });
  }

  @Get('projects/:projectId/findings/summary')
  @RequirePermission('vulnerability:read')
  projectSummary(@Scope() chain: ScopeChain) {
    return this.findings.summary(chain.organizationId, chain.projectId!);
  }

  @Get('services/:serviceId/findings')
  @RequirePermission('vulnerability:read')
  serviceList(@Scope() chain: ScopeChain, @Query('status') status?: string) {
    return this.findings.list(chain.organizationId, { serviceId: chain.serviceId!, status: parseList<FindingStatus>(status) ?? ['open'] });
  }

  /** Findings contained in one SBOM (release or image). */
  @Get('sboms/:sbomId/findings')
  async sbomFindings(@CurrentUser() user: AuthenticatedUser, @Param('sbomId', ParseUUIDPipe) sbomId: string, @Query('status') status?: string) {
    const serviceId = await this.findings.serviceOfSbom(sbomId);
    await this.assert(user, serviceId, 'vulnerability:read');
    // Scoped to one SBOM: everything linked to it, whatever the service-level status is now (a `fixed` finding was in this image).
    return this.findings.listForSbom(user, sbomId, parseList<FindingStatus>(status) ?? ['open', 'accepted', 'false_positive', 'not_affected', 'fixed']);
  }

  // ---------------------------------------------------------------- code findings (secrets, IaC)

  @Get('organizations/:organizationId/code-findings')
  @RequirePermission('vulnerability:read')
  async codeList(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Query('kind') kind?: string, @Query('severity') severity?: string, @Query('status') status?: string, @Query('q') q?: string) {
    const rows = await this.code.list(chain.organizationId, { kind: parseList(kind), severity: parseList(severity), status: parseList(status), q });
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'vulnerability:read', chain)) return rows;
    const visible = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (!visible.has(r.projectId)) {
        const pc = await this.resolver.resolveChain({ projectId: r.projectId }).catch(() => null);
        visible.set(r.projectId, !!pc && this.authz.can(ctx, 'vulnerability:read', pc));
      }
      if (visible.get(r.projectId)) out.push(r);
    }
    return out;
  }

  @Get('organizations/:organizationId/code-findings/summary')
  @RequirePermission('vulnerability:read')
  codeSummary(@Scope() chain: ScopeChain) {
    return this.code.summary(chain.organizationId);
  }

  @Get('projects/:projectId/code-findings')
  @RequirePermission('vulnerability:read')
  codeProjectList(@Scope() chain: ScopeChain, @Query('kind') kind?: string, @Query('severity') severity?: string, @Query('status') status?: string, @Query('q') q?: string) {
    return this.code.list(chain.organizationId, { projectId: chain.projectId!, kind: parseList(kind), severity: parseList(severity), status: parseList(status), q });
  }

  @Get('projects/:projectId/code-findings/summary')
  @RequirePermission('vulnerability:read')
  codeProjectSummary(@Scope() chain: ScopeChain) {
    return this.code.summary(chain.organizationId, chain.projectId!);
  }

  @Patch('code-findings/:id')
  async codeSetStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto) {
    await this.assert(user, await this.code.serviceOf(id), 'vulnerability:write');
    return this.code.setStatus(user, id, dto.status, dto.note);
  }

  @Get('findings/:findingId')
  async get(@CurrentUser() user: AuthenticatedUser, @Param('findingId', ParseUUIDPipe) findingId: string) {
    const f = await this.findings.get(findingId);
    await this.assert(user, f.serviceId, 'vulnerability:read');
    return f;
  }

  @Patch('findings/:findingId')
  async setStatus(@CurrentUser() user: AuthenticatedUser, @Param('findingId', ParseUUIDPipe) findingId: string, @Body() dto: StatusDto) {
    const f = await this.findings.get(findingId);
    await this.assert(user, f.serviceId, 'vulnerability:write');
    return this.findings.setStatus(user, findingId, dto.status, dto.note);
  }

  /** Re-correlate now (a service, or everything): admins / security. */
  @Post('services/:serviceId/findings/recorrelate')
  @RequirePermission('vulnerability:write')
  recorrelate(@Scope() chain: ScopeChain) {
    return jobView(this.correlation.request({ serviceId: chain.serviceId!, force: true }, chain.organizationId));
  }

  /** Status of a correlation job, read through the scope that requested it (jobs live in memory; a restart forgets them). */
  @Get('organizations/:organizationId/correlation/jobs/:jobId')
  @RequirePermission('vulnerability:read')
  orgCorrelationJob(@Scope() chain: ScopeChain, @Param('jobId') jobId: string) {
    return jobView(this.jobInScope(jobId, chain.organizationId, null));
  }

  @Get('services/:serviceId/correlation/jobs/:jobId')
  @RequirePermission('vulnerability:read')
  serviceCorrelationJob(@Scope() chain: ScopeChain, @Param('jobId') jobId: string) {
    return jobView(this.jobInScope(jobId, chain.organizationId, chain.serviceId!));
  }

  private jobInScope(jobId: string, organizationId: string, serviceId: string | null): CorrelationJob {
    const job = this.correlation.job(jobId);
    if (!job || job.organizationId !== organizationId || (serviceId && job.options.serviceId !== serviceId)) throw new NotFoundException('Unknown correlation job for this scope (jobs live in memory; a restart forgets them)');
    return job;
  }

  @Post('organizations/:organizationId/findings/recorrelate')
  @RequirePermission('vulnerability:write')
  recorrelateAll(@Scope() chain: ScopeChain) {
    return jobView(this.correlation.request({ force: true, limit: 5000 }, chain.organizationId));
  }

  private async assert(user: AuthenticatedUser, serviceId: string, permission: 'vulnerability:read' | 'vulnerability:write') {
    const chain = await this.resolver.resolveChain({ serviceId });
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }
}
