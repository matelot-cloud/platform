import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { AlwaysOnSampler, SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { isPolledPath, MatelotSampler } from './sampler';

describe('sampler: polled routes never start a trace of their own', () => {
  const s = new MatelotSampler(new AlwaysOnSampler());
  const id = '2c1b3e7a-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
  const root = (method: string, path: string, kind = SpanKind.SERVER, ctx = ROOT_CONTEXT) => s.shouldSample(ctx, 'a'.repeat(32), `${method} ${path}`, kind, { 'http.request.method': method, 'url.path': path }, []).decision;

  it('matches the pipeline, job and correlation polls', () => {
    expect(isPolledPath(`/api/v1/pipelines/${id}`)).toBe(true);
    expect(isPolledPath(`/api/v1/pipelines/${id}/jobs`)).toBe(true);
    expect(isPolledPath(`/api/v1/jobs/${id}/logs`)).toBe(true);
    expect(isPolledPath(`/api/v1/services/${id}/correlation/jobs/${id}`)).toBe(true);
    expect(isPolledPath('/api/v1/pipelines')).toBe(false);
    expect(isPolledPath(`/api/v1/services/${id}/pipelines`)).toBe(false);
  });

  it('drops a GET poll without a parent, keeps everything else', () => {
    expect(root('GET', `/api/v1/pipelines/${id}`)).toBe(SamplingDecision.NOT_RECORD);
    expect(root('GET', `/api/v1/pipelines/${id}/jobs`)).toBe(SamplingDecision.NOT_RECORD);
    expect(root('POST', `/api/v1/pipelines/${id}`)).toBe(SamplingDecision.RECORD_AND_SAMPLED);         // a cancel is not a poll
    expect(root('GET', `/api/v1/services/${id}/pipelines`)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(root('GET', `/api/v1/pipelines/${id}`, SpanKind.CLIENT)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    // inside a sampled trace (a traced caller polling), the poll is recorded as its child
    const parent = trace.setSpanContext(ROOT_CONTEXT, { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 1, isRemote: true });
    expect(root('GET', `/api/v1/pipelines/${id}`, SpanKind.SERVER, parent)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });
});
