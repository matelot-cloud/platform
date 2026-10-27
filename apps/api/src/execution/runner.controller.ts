import { CorrelationService } from '../vulnerabilities/correlation.service';
import { getMetrics } from '../telemetry/metrics';
import { context as otelContext, SpanKind } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { contextFromTraceparent, tracer } from '../telemetry/spans';
import { queuedAt } from '../telemetry/pipeline-telemetry';
import type { Job } from '../database/schema';

/** The one span a successful claim leaves: in the pipeline's trace, under the job's span (never under the poll's). It
 *  covers the job's time in the queue — from when it became claimable (jobs.queued_at) to the hand-out — so it never
 *  starts before its parent, whose start is the job's creation; this runner's own long-poll wait (which may have begun
 *  long before the job existed) is only the attribute `matelot.claim.waited_ms`. */
function emitClaimSpan(job: Job, principal: RunnerPrincipal, pollStartedMs: number, polls: number): void {
  if (!job.traceParent) return;
  const span = tracer().startSpan('claim', {
    kind: SpanKind.INTERNAL, startTime: queuedAt(job),
    attributes: { 'matelot.job.id': job.id, 'matelot.job.kind': job.type, 'matelot.pipeline.id': job.pipelineId ?? '', 'matelot.runner.name': principal.runner.name, 'matelot.pool': principal.pool.slug, 'matelot.claim.polls': polls, 'matelot.claim.waited_ms': Date.now() - pollStartedMs, 'matelot.claim.result': 'job' },
  }, contextFromTraceparent(job.traceParent));
  span.end();
}
import { BadRequestException, Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, Res, UnauthorizedException, forwardRef } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { Public } from '../auth/public.decorator';
import { DATABASE, Database } from '../database/database.module';
import { runners } from '../database/schema';
import { AppendLogsDto, ClaimDto, CompleteJobDto, HeartbeatDto, RegisterRunnerDto } from './dto/execution.dto';
import { JobsService } from './jobs.service';
import { CodeFindingInput, CodeFindingsService } from '../vulnerabilities/code-findings.service';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env';

/** Version of the runner agent shipped with this platform build (apps/runner). */
export const RUNNER_AGENT_VERSION = '0.3.3';
import { SbomService } from '../sbom/sbom.service';
import { PoolsService } from './pools.service';
import { CurrentRunner, RunnerAuth, RunnerPrincipal } from './runner-auth';

/** The runner ↔ cell protocol (see docs/runner-protocol.md). Authenticated by runner tokens. */
@ApiExcludeController()
@Controller('runner')
@Public()
export class RunnerController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pools: PoolsService,
    private readonly jobs: JobsService,
    private readonly sbom: SbomService,
    private readonly codeFindings: CodeFindingsService,
    @Inject(forwardRef(() => CorrelationService)) private readonly correlation: CorrelationService,
    @Inject(ConfigService) config: AppConfig,
  ) {
    this.registryHost = config.get('REGISTRY_HOST', { infer: true });
  }

  private readonly registryHost?: string;

  @Post('register')
  async register(@Body() dto: RegisterRunnerDto) {
    const result = await this.pools.register(dto);
    return { ...result, config: this.runnerConfig(dto.metadata) };
  }

  @Post('heartbeat')
  @RunnerAuth()
  async heartbeat(@CurrentRunner() principal: RunnerPrincipal, @Body() dto: HeartbeatDto) {
    const status = dto.status ?? (principal.runner.currentJobId ? 'busy' : 'online');
    const version = typeof dto.metadata?.version === 'string' ? dto.metadata.version : undefined;
    await this.db.update(runners).set({ status, lastHeartbeatAt: new Date(), ...(dto.tags ? { tags: dto.tags } : {}), ...(dto.metadata ? { metadata: { ...principal.runner.metadata, ...dto.metadata } } : {}), ...(version ? { version } : {}) }).where(eq(runners.id, principal.runner.id));
    return { ok: true, status, config: this.runnerConfig(dto.metadata ?? principal.runner.metadata) };
  }

  /**
   * Configuration the cell pushes to runners (no env needed on the runner side):
   * registry host aliases for containerised runners of a local cell, the latest agent version.
   */
  private runnerConfig(metadata: Record<string, unknown> | null | undefined): { registryHostAliases: Record<string, string>; latestVersion: string } {
    const aliases: Record<string, string> = {};
    const registryHost = this.registryHost;
    const inContainer = !!metadata && (metadata.container === true || metadata.inCluster === true);
    if (registryHost && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(registryHost) && inContainer) {
      const port = registryHost.split(':')[1] ?? '5000';
      aliases[registryHost] = `host.docker.internal:${port}`;
    }
    return { registryHostAliases: aliases, latestVersion: RUNNER_AGENT_VERSION };
  }

  /** Long poll: returns 200 with a job, or 204 when nothing matched within waitSeconds. */
  /**
   * Long-poll claim. A runner that goes away while its claim is open (container stopped, SIGTERM, network cut) must never
   * be handed a job: the loop stops as soon as the connection closes, and a job assigned in the same instant — or whose
   * response could not be delivered (connection closed before the response finished) — goes straight back to the queue.
   */
  @Post('jobs/claim')
  @RunnerAuth()
  async claim(@CurrentRunner() principal: RunnerPrincipal, @Body() dto: ClaimDto, @Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    const deadline = started + Math.min(dto.waitSeconds ?? 20, 25) * 1000;
    let gone = false;
    let polls = 0;
    const onClose = () => { gone = true; };
    res.once('close', onClose);
    // Tracing: a runner polls every 20 s whether or not there is work, so the poll's own span is dropped by the trimming
    // rules and the loop runs with instrumentation suppressed (no query spans) — an empty poll leaves nothing. A poll
    // that hands out a job leaves ONE span, `claim`, in the pipeline's trace under the job's span (how long the job
    // waited, how many polls), so the pipeline trace shows the claim without a root of its own per poll.
    try {
      return await otelContext.with(suppressTracing(otelContext.active()), async () => {
        for (;;) {
          if (gone) return;
          polls++;
          const job = await this.jobs.claim(principal);
          if (job) {
            if (gone) {
              getMetrics().counterAdd(getMetrics().runnerClaims, 1, { result: 'disconnected' });
              await this.jobs.unclaim(job.id, principal.runner.id, `runner ${principal.runner.name} disconnected while claiming; back in the queue`);
              return;
            }
            // delivered or not: if the connection closes before the response is fully written, hand the job back
            res.once('close', () => {
              if (!res.writableFinished) void this.jobs.unclaim(job.id, principal.runner.id, `runner ${principal.runner.name} went away before receiving the job; back in the queue`);
            });
            emitClaimSpan(job, principal, started, polls);
            return job;
          }
          if (Date.now() >= deadline) {
            getMetrics().counterAdd(getMetrics().runnerClaims, 1, { result: 'empty' });
            res.status(204);
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      });
    } finally {
      res.off('close', onClose);
    }
  }

  @Post('jobs/:jobId/start')
  @RunnerAuth()
  start(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.start(principal, jobId);
  }

  @Post('jobs/:jobId/heartbeat')
  @RunnerAuth()
  jobHeartbeat(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.jobHeartbeat(principal, jobId);
  }

  @Post('jobs/:jobId/logs')
  @RunnerAuth()
  @HttpCode(202)
  logs(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string, @Body() dto: AppendLogsDto) {
    return this.jobs.appendLogs(principal, jobId, dto);
  }

  @Post('jobs/:jobId/credentials')
  @RunnerAuth()
  credentials(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.credentials(principal, jobId);
  }

  @Post('jobs/:jobId/registry-credentials')
  @RunnerAuth()
  registryCredentials(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.jobs.registryCredentials(principal, jobId);
  }

  /** A job produced an SBOM: store it against the job's service (and release / image when resolvable). */
  /** Secrets / IaC scan results of a job (evidence already redacted by the runner; re-redacted here). */
  @Post('jobs/:jobId/code-findings')
  @RunnerAuth()
  async jobCodeFindings(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: { kind: 'secret' | 'iac' | 'sast'; ref: string; findings: CodeFindingInput[] }) {
    const job = await this.jobs.ownedJobOf(principal, jobId);
    if (!job.serviceId) throw new BadRequestException('job has no service');
    if (!['secret', 'iac', 'sast'].includes(body.kind)) throw new BadRequestException('kind must be secret, iac or sast');
    return this.codeFindings.ingest({ organizationId: job.organizationId, serviceId: job.serviceId, jobId, kind: body.kind, ref: String(body.ref ?? '').slice(0, 200), findings: Array.isArray(body.findings) ? body.findings : [] });
  }

  /** The `sca` pipeline job: correlate the service's SBOMs now and report what the pipeline's SBOM carries. */
  @Post('jobs/:jobId/correlate')
  @RunnerAuth()
  async jobCorrelate(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string) {
    const job = await this.jobs.ownedJobOf(principal, jobId);
    if (!job.serviceId) throw new BadRequestException('job has no service');
    const run = await this.correlation.wait(this.correlation.request({ serviceId: job.serviceId }), 10 * 60_000);
    if (run.status === 'failed') throw new BadRequestException(`correlation failed: ${run.error}`);
    // the SBOM produced by this pipeline (same pipeline id), else the newest source SBOM of the service
    const sbom = await this.sbom.latestForPipeline(job.serviceId, job.pipelineId);
    const summary = sbom ? await this.sbom.findingSummary(sbom.id) : null;
    return { result: run.result, sbomId: sbom?.id ?? null, components: sbom?.componentCount ?? null, findings: summary };
  }

  @Post('jobs/:jobId/sbom')
  @RunnerAuth()
  async jobSbom(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: { target: 'source' | 'image'; targetRef: string; version?: string; imageRef?: string; document: Record<string, unknown> }) {
    const job = await this.jobs.ownedJobOf(principal, jobId);
    if (!job.serviceId) throw new UnauthorizedException('Job has no service');
    return this.sbom.ingest({ organizationId: job.organizationId, serviceId: job.serviceId, source: 'runner', target: body.target, targetRef: body.targetRef, document: body.document, releaseVersion: body.version ?? null, imageRef: body.imageRef ?? null, repositoryId: job.repositoryId, jobId: job.id });
  }

  @Post('jobs/:jobId/complete')
  @RunnerAuth()
  complete(@CurrentRunner() principal: RunnerPrincipal, @Param('jobId', ParseUUIDPipe) jobId: string, @Body() dto: CompleteJobDto) {
    return this.jobs.complete(principal, jobId, dto);
  }
}
