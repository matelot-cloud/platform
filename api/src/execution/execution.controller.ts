import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { AppConfig } from '../config/env';
import { AccessService } from '../rbac/access.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { RequirePermission } from '../rbac/permission.guard';
import { Scope } from '../rbac/scope.decorator';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain } from '../rbac/scope.types';
import { CreateJobDto, CreatePipelineDto, CreatePoolDto } from './dto/execution.dto';
import { PIPELINE_TEMPLATES } from './pipeline-templates';
import { PipelinesService } from './pipelines.service';
import { JobsService } from './jobs.service';
import { PoolsService } from './pools.service';
import { RUNNER_AGENT_VERSION } from './runner.controller';

@ApiTags('execution')
@ApiBearerAuth()
@Controller()
export class ExecutionController {
  private readonly publicApiUrl: string;
  private readonly runnerImage: string;
  private readonly apiPort: number;
  private readonly registryHost?: string;

  constructor(
    private readonly pools: PoolsService,
    private readonly jobs: JobsService,
    private readonly pipelines: PipelinesService,
    private readonly access: AccessService,
    private readonly authz: AuthorizationService,
    private readonly resolver: ScopeResolverService,
    @Inject(ConfigService) config: AppConfig,
  ) {
    // Runners reach the API through the web app's URL (/api is proxied) — the address teams already know.
    this.publicApiUrl = `${config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '')}/api/v1`;
    this.runnerImage = config.get('RUNNER_IMAGE', { infer: true });
    this.registryHost = config.get('REGISTRY_HOST', { infer: true });
    this.apiPort = config.get('PORT', { infer: true });
  }

  // ---- pools & runners

  /** Latest runner agent version shipped with this platform (UI flags outdated runners). */
  @Get('runner-agent')
  runnerAgent() {
    return { latestVersion: RUNNER_AGENT_VERSION, image: this.runnerImage };
  }

  @Get('organizations/:organizationId/runner-pools')
  @RequirePermission('organization:read')
  listPools(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    return this.pools.list(user, chain);
  }

  @Post('organizations/:organizationId/runner-pools')
  @RequirePermission('organization:read')
  createPool(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreatePoolDto) {
    return this.pools.create(user, chain, dto);
  }

  @Post('runner-pools/:poolId/registration-tokens')
  registrationToken(@CurrentUser() user: AuthenticatedUser, @Param('poolId', ParseUUIDPipe) poolId: string) {
    return this.pools.createRegistrationToken(user, poolId, this.publicApiUrl, this.runnerImage, this.apiPort, this.registryHost);
  }

  @Delete('runner-pools/:poolId')
  @HttpCode(204)
  async deletePool(@CurrentUser() user: AuthenticatedUser, @Param('poolId', ParseUUIDPipe) poolId: string) {
    await this.pools.delete(user, poolId);
  }

  @Delete('runners/:runnerId')
  @HttpCode(204)
  async removeRunner(@CurrentUser() user: AuthenticatedUser, @Param('runnerId', ParseUUIDPipe) runnerId: string) {
    await this.pools.removeRunner(user, runnerId);
  }

  /** Pools a project's jobs can run on (own + inherited). */
  @Get('projects/:projectId/runner-pools')
  @RequirePermission('project:read')
  projectPools(@Scope() chain: ScopeChain) {
    return this.pools.listForChain(chain);
  }

  // ---- pipelines

  @Get('pipeline-templates')
  templates() {
    return PIPELINE_TEMPLATES;
  }

  @Post('services/:serviceId/pipelines')
  @RequirePermission('job:create')
  createPipeline(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreatePipelineDto) {
    return this.pipelines.create(user, chain, dto);
  }

  @Get('projects/:projectId/pipelines')
  @RequirePermission('job:read')
  projectPipelines(@Scope() chain: ScopeChain, @Query('limit') limit?: string) {
    return this.pipelines.listForProject(chain.projectId!, Math.min(Number(limit) || 30, 100));
  }

  @Get('pipelines/:pipelineId')
  async pipeline(@CurrentUser() user: AuthenticatedUser, @Param('pipelineId', ParseUUIDPipe) pipelineId: string) {
    const pipeline = await this.pipelines.get(pipelineId);
    await this.assertJob(user, pipeline.projectId, 'job:read');
    // platform jobs (policy_eval) run on the worker, not a runner: tell the UI whether that worker is alive
    return { ...pipeline, platformWorkerSeenAt: await this.jobs.platformWorkerSeenAt() };
  }

  @Post('pipelines/:pipelineId/cancel')
  async cancelPipeline(@CurrentUser() user: AuthenticatedUser, @Param('pipelineId', ParseUUIDPipe) pipelineId: string) {
    const pipeline = await this.pipelines.get(pipelineId);
    await this.assertJob(user, pipeline.projectId, 'job:cancel');
    return this.pipelines.cancel(user, pipelineId);
  }

  @Post('jobs/:jobId/retry')
  async retry(@CurrentUser() user: AuthenticatedUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    const job = await this.jobs.get(jobId);
    await this.assertJob(user, job.projectId, 'job:create');
    await this.pipelines.retryJob(user, job);
    return this.jobs.get(jobId);
  }

  // ---- jobs

  @Post('services/:serviceId/jobs')
  @RequirePermission('job:create')
  createJob(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, chain, dto);
  }

  /** Queued / running jobs of the organization, visible ones only (header activity). */
  @Get('organizations/:organizationId/jobs/active')
  @RequirePermission('job:read')
  async activeJobs(@CurrentUser() user: AuthenticatedUser, @Scope() chain: ScopeChain) {
    const rows = await this.jobs.activeForOrganization(chain.organizationId);
    const ctx = await this.access.forUser(user.id);
    if (this.authz.hasPermission(ctx, 'job:read', chain)) return rows;
    const visible = new Map<string, boolean>();
    const out = [];
    for (const r of rows) {
      if (!r.projectId) continue;
      if (!visible.has(r.projectId)) {
        const pc = await this.resolver.resolveChain({ projectId: r.projectId }).catch(() => null);
        visible.set(r.projectId, !!pc && this.authz.can(ctx, 'job:read', pc));
      }
      if (visible.get(r.projectId)) out.push(r);
    }
    return out;
  }

  @Get('projects/:projectId/jobs')
  @RequirePermission('job:read')
  projectJobs(@Scope() chain: ScopeChain, @Query('limit') limit?: string) {
    return this.jobs.listForProject(chain.projectId!, Math.min(Number(limit) || 50, 200));
  }

  @Get('jobs/:jobId')
  async job(@CurrentUser() user: AuthenticatedUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    const job = await this.jobs.get(jobId);
    await this.assertJob(user, job.projectId, 'job:read');
    return { ...job, platformWorkerSeenAt: await this.jobs.platformWorkerSeenAt() };
  }

  @Get('jobs/:jobId/logs')
  async jobLogs(@CurrentUser() user: AuthenticatedUser, @Param('jobId', ParseUUIDPipe) jobId: string, @Query('after') after?: string) {
    const job = await this.jobs.get(jobId);
    await this.assertJob(user, job.projectId, 'job:read');
    return this.jobs.logs(job.id, after === undefined ? -1 : Number(after));
  }

  @Post('jobs/:jobId/cancel')
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    const job = await this.jobs.get(jobId);
    await this.assertJob(user, job.projectId, 'job:cancel');
    return this.jobs.cancel(user, job);
  }

  private async assertJob(user: AuthenticatedUser, projectId: string, permission: 'job:read' | 'job:cancel' | 'job:create') {
    const chain = await this.resolver.resolveChain({ projectId });
    const ctx = await this.access.forUser(user.id);
    this.authz.assert(ctx, permission, chain);
  }
}
