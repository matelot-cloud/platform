import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { AlwaysOffSampler, AlwaysOnSampler, ParentBasedSampler, SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { getRatio, isPolledPath, MatelotSampler, POLL_ATTRIBUTE } from './sampler';

const id = '2c1b3e7a-0a1b-4c2d-8e3f-4a5b6c7d8e9f';
// trace ids spread over the ratio sampler's range: TraceIdRatioBasedSampler keeps the ids whose low 8 bytes fall under ratio × 2^64
const traceIdAt = (fraction: number) => '0'.repeat(16) + Math.floor(fraction * 0xffffffff).toString(16).padStart(8, '0') + '0'.repeat(8);
type Decide = (method: string, path: string, o?: { kind?: SpanKind; ctx?: typeof ROOT_CONTEXT; poll?: boolean; traceId?: string }) => SamplingDecision;
const decider = (s: MatelotSampler): Decide => (method, path, o = {}) => s.shouldSample(o.ctx ?? ROOT_CONTEXT, o.traceId ?? traceIdAt(0.5), `${method} ${path}`, o.kind ?? SpanKind.SERVER, { 'http.request.method': method, 'url.path': path, ...(o.poll ? { [POLL_ATTRIBUTE]: true } : {}) }, []).decision;
const sampledParent = trace.setSpanContext(ROOT_CONTEXT, { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 1, isRemote: true });
const unsampledParent = trace.setSpanContext(ROOT_CONTEXT, { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 0, isRemote: true });

describe('sampler: polls never start a trace, other GETs by ratio, mutations and children follow the parent', () => {
  const s = new MatelotSampler(new ParentBasedSampler({ root: new AlwaysOnSampler() }), 0.1);
  const root = decider(s);

  it('matches the pipeline, job and correlation polls', () => {
    expect(isPolledPath(`/api/v1/pipelines/${id}`)).toBe(true);
    expect(isPolledPath(`/api/v1/pipelines/${id}/jobs`)).toBe(true);
    expect(isPolledPath(`/api/v1/jobs/${id}/logs`)).toBe(true);
    expect(isPolledPath(`/api/v1/services/${id}/correlation/jobs/${id}`)).toBe(true);
    expect(isPolledPath('/api/v1/pipelines')).toBe(false);
    expect(isPolledPath(`/api/v1/services/${id}/pipelines`)).toBe(false);
  });

  it('a GET with x-matelot-poll (the web app\'s refetches, the CLI\'s waits) is never a root, whatever the route', () => {
    for (const path of ['/api/v1/me', `/api/v1/organizations/${id}/jobs/active`, `/api/v1/organizations/${id}/audit-events`, `/api/v1/projects/${id}`]) {
      expect(root('GET', path, { poll: true, traceId: traceIdAt(0.01) })).toBe(SamplingDecision.NOT_RECORD);   // an id the ratio would keep
    }
    expect(root('GET', `/api/v1/pipelines/${id}`, { traceId: traceIdAt(0.01) })).toBe(SamplingDecision.NOT_RECORD);   // a polled route, no header (older clients)
    expect(root('GET', `/api/v1/pipelines/${id}/jobs`)).toBe(SamplingDecision.NOT_RECORD);
  });

  it('other parentless GETs: one in ten trace ids (MATELOT_TRACES_GET_RATIO)', () => {
    expect(root('GET', '/api/v1/me', { traceId: traceIdAt(0.05) })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(root('GET', '/api/v1/me', { traceId: traceIdAt(0.5) })).toBe(SamplingDecision.NOT_RECORD);
    expect(root('GET', '/api/v1/me', { traceId: traceIdAt(0.95) })).toBe(SamplingDecision.NOT_RECORD);
    const kept = Array.from({ length: 1000 }, (_, i) => root('GET', `/api/v1/projects/${id}`, { traceId: traceIdAt(i / 1000) })).filter((d) => d === SamplingDecision.RECORD_AND_SAMPLED).length;
    expect(kept).toBeGreaterThanOrEqual(90); expect(kept).toBeLessThanOrEqual(110);
    const all = new MatelotSampler(new AlwaysOnSampler(), 1);
    expect(decider(all)('GET', '/api/v1/me', { traceId: traceIdAt(0.95) })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decider(all)('GET', '/api/v1/me', { poll: true })).toBe(SamplingDecision.NOT_RECORD);   // ratio 1 still drops polls
  });

  it('mutations are always recorded; a poll of a mutation is still a mutation', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(root(method, `/api/v1/pipelines/${id}`, { traceId: traceIdAt(0.95) })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
      expect(root(method, `/api/v1/pipelines/${id}`, { poll: true, traceId: traceIdAt(0.95) })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    }
    expect(root('GET', `/api/v1/pipelines/${id}`, { kind: SpanKind.CLIENT })).toBe(SamplingDecision.RECORD_AND_SAMPLED);   // not a server root
  });

  it('with a parent the parent decides: sampled → recorded (even a poll), unsampled → dropped (the CLI\'s traceparent)', () => {
    expect(root('GET', `/api/v1/pipelines/${id}`, { ctx: sampledParent, poll: true })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(root('GET', '/api/v1/me', { ctx: sampledParent, traceId: traceIdAt(0.95) })).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(root('GET', '/api/v1/me', { ctx: unsampledParent, traceId: traceIdAt(0.01) })).toBe(SamplingDecision.NOT_RECORD);
    expect(root('POST', '/api/v1/projects', { ctx: unsampledParent })).toBe(SamplingDecision.NOT_RECORD);
  });

  it('a stricter base sampler still wins (always_off records nothing)', () => {
    const off = decider(new MatelotSampler(new ParentBasedSampler({ root: new AlwaysOffSampler() }), 1));
    expect(off('GET', '/api/v1/me', { traceId: traceIdAt(0.01) })).toBe(SamplingDecision.NOT_RECORD);
    expect(off('POST', '/api/v1/projects')).toBe(SamplingDecision.NOT_RECORD);
  });

  it('MATELOT_TRACES_GET_RATIO: 0 … 1, default 0.1', () => {
    expect(getRatio({} as NodeJS.ProcessEnv)).toBe(0.1);
    expect(getRatio({ MATELOT_TRACES_GET_RATIO: '' } as NodeJS.ProcessEnv)).toBe(0.1);
    expect(getRatio({ MATELOT_TRACES_GET_RATIO: '0.25' } as NodeJS.ProcessEnv)).toBe(0.25);
    expect(getRatio({ MATELOT_TRACES_GET_RATIO: '7' } as NodeJS.ProcessEnv)).toBe(1);
    expect(getRatio({ MATELOT_TRACES_GET_RATIO: 'all' } as NodeJS.ProcessEnv)).toBe(0.1);
  });
});
