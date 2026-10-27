import { Injectable } from '@nestjs/common';
import { SpanKind, type Attributes } from '@opentelemetry/api';
import type { Job, Pipeline } from '../database/schema';
import { newSpanId, newTraceId, parseTraceparent, traceparent } from './ids';
import { getMetrics, Metrics } from './metrics';
import { emitCompletedSpan } from './spans';

/**
 * One trace per pipeline (docs/observability.md): ids are fixed when the pipeline is created — a trace id, a root span
 * id for the pipeline, a span id per job — and stored on the rows (`pipelines.trace_parent`, `jobs.trace_parent`).
 * The runner gets its job's traceparent in the claim response and parents its own spans under it; every API call it
 * makes carries the header, so the server side of a job lands in the same trace. The pipeline's and the jobs' own
 * spans are emitted when they END (terminal status), with their pinned ids, from whichever process finished them —
 * nothing lives in memory across requests or replicas. Metrics are recorded at the same points, exemplars pointing
 * at the pipeline's trace.
 */
/** When the job last became claimable (jobs.queued_at), never before its creation (rows older than the column). */
export function queuedAt(job: Pick<Job, 'createdAt' | 'queuedAt'>): Date {
  return job.queuedAt && job.queuedAt.getTime() >= job.createdAt.getTime() ? job.queuedAt : job.createdAt;
}

@Injectable()
export class PipelineTelemetry {
  constructor(private readonly metrics: Metrics) {}

  /** Ids for a new pipeline: the root traceparent and a fresh job traceparent per call of `job()`. */
  newTrace(): { pipeline: string; job: () => string } {
    const traceId = newTraceId();
    return { pipeline: traceparent(traceId, newSpanId()), job: () => traceparent(traceId, newSpanId()) };
  }

  /** A fresh span id in the pipeline's trace (a retried job gets a new one so the two attempts are two spans). */
  jobTraceparentFor(pipelineTraceparent: string | null | undefined): string | null {
    const p = parseTraceparent(pipelineTraceparent);
    return p ? traceparent(p.traceId, newSpanId()) : null;
  }

  /** A job reached a terminal status (succeeded, failed, cancelled, timed_out, skipped). */
  jobFinished(job: Job, pipeline: Pick<Pipeline, 'traceParent' | 'number'> | null, runnerName: string | null): void {
    const finishedAt = job.finishedAt ?? new Date();
    const started = job.startedAt ?? job.assignedAt ?? null;
    const status = job.status;
    if (status === 'pending' || status === 'queued' || status === 'assigned' || status === 'running') return;
    this.metrics.counterAdd(this.metrics.pipelineJobs, 1, { kind: job.type, status });
    const ids = parseTraceparent(job.traceParent);
    const exemplar = ids ? { traceId: ids.traceId, spanId: ids.spanId } : null;
    if (started && status !== 'skipped') {
      this.metrics.pipelineJobDuration.record(Math.max(0, (finishedAt.getTime() - started.getTime()) / 1000), { kind: job.type }, exemplar);
      this.metrics.pipelineJobQueueWait.record(Math.max(0, (started.getTime() - queuedAt(job).getTime()) / 1000), { kind: job.type }, exemplar);
    }
    if (!ids) return;
    const attributes: Attributes = { 'matelot.job.id': job.id, 'matelot.job.kind': job.type, 'matelot.job.name': job.name ?? '', 'matelot.job.stage': job.stage ?? '', 'matelot.job.status': status, 'matelot.job.attempts': job.attempts, 'matelot.pipeline.id': job.pipelineId ?? '', 'matelot.project.id': job.projectId, 'matelot.organization.id': job.organizationId };
    if (job.serviceId) attributes['matelot.service.id'] = job.serviceId;
    if (job.exitCode !== null && job.exitCode !== undefined) attributes['matelot.job.exit_code'] = job.exitCode;
    if (runnerName) attributes['matelot.runner.name'] = runnerName;
    if (pipeline?.number) attributes['matelot.pipeline.number'] = pipeline.number;
    const events = [];
    if (job.queuedAt && job.queuedAt.getTime() > job.createdAt.getTime()) events.push({ name: 'queued', time: job.queuedAt });   // a later stage: queued when the stage opened
    if (job.assignedAt) events.push({ name: 'claimed', time: job.assignedAt });
    if (job.startedAt) events.push({ name: 'started', time: job.startedAt });
    // a skipped job (an earlier stage failed) is a span too, so the pipeline trace shows every job of the template
    emitCompletedSpan({ name: `job ${job.type}`, traceId: ids.traceId, spanId: ids.spanId, parentTraceparent: pipeline?.traceParent, startTime: job.createdAt, endTime: finishedAt, attributes, events, error: status === 'succeeded' || status === 'skipped' ? null : job.error ?? status, kind: SpanKind.INTERNAL });
  }

  /** The pipeline reached a terminal status. */
  pipelineFinished(pipeline: Pipeline): void {
    const finishedAt = pipeline.finishedAt ?? new Date();
    const ids = parseTraceparent(pipeline.traceParent);
    this.metrics.counterAdd(this.metrics.pipelines, 1, { status: pipeline.status, trigger: pipeline.trigger });
    this.metrics.pipelineDuration.record(Math.max(0, (finishedAt.getTime() - pipeline.createdAt.getTime()) / 1000), { status: pipeline.status }, ids ? { traceId: ids.traceId, spanId: ids.spanId } : null);
    if (!ids) return;
    const attributes: Attributes = { 'matelot.pipeline.id': pipeline.id, 'matelot.pipeline.number': pipeline.number, 'matelot.pipeline.name': pipeline.name, 'matelot.pipeline.status': pipeline.status, 'matelot.pipeline.trigger': pipeline.trigger, 'matelot.project.id': pipeline.projectId, 'matelot.organization.id': pipeline.organizationId };
    if (pipeline.serviceId) attributes['matelot.service.id'] = pipeline.serviceId;
    if (pipeline.ref) attributes['matelot.pipeline.ref'] = pipeline.ref;
    if (pipeline.commitSha) attributes['matelot.pipeline.commit'] = pipeline.commitSha;
    emitCompletedSpan({ name: `pipeline ${pipeline.name}`, traceId: ids.traceId, spanId: ids.spanId, startTime: pipeline.createdAt, endTime: finishedAt, attributes, events: pipeline.startedAt ? [{ name: 'started', time: pipeline.startedAt }] : [], error: pipeline.status === 'succeeded' ? null : pipeline.status, kind: SpanKind.SERVER });
  }
}

let fallback: PipelineTelemetry | null = null;
/** Outside Nest's injection (specs that build services with Object.create): the process-wide instance. */
export function pipelineTelemetry(): PipelineTelemetry {
  return (fallback ??= new PipelineTelemetry(getMetrics()));
}
