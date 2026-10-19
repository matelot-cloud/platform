import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import pino from 'pino';
import { Writable } from 'node:stream';
import { runWithRequestContext } from '../common/request-context';
import { levelFor, logSchema, parseLogLevel, REDACTED_KEYS, REDACT_CENSOR } from './log-schema';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l)); cb(); } });
  return { lines, stream };
}

describe('log schema', () => {
  beforeAll(() => { context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()); });

  it('every known secret key is redacted at the top level and nested, whatever the surrounding object', () => {
    const { lines, stream } = capture();
    const log = pino(logSchema({ component: 'api', cell: 'globex', logLevel: 'info' }), stream);
    const secrets: Record<string, unknown> = {};
    for (const k of REDACTED_KEYS) secrets[k] = `value-of-${k}`;
    log.info({ ...secrets, nested: { ...secrets, deeper: { ...secrets } }, req: { headers: { authorization: 'Bearer x', cookie: 'a=b' } }, keep: 'visible' }, 'with secrets');
    const line = lines[0];
    const text = JSON.stringify(line);
    for (const k of REDACTED_KEYS) expect(text).not.toContain(`value-of-${k}`);
    expect(text).not.toContain('Bearer x');
    expect(line.keep).toBe('visible');
    expect(line.password).toBe(REDACT_CENSOR);
    expect((line.nested as { deeper: { token: string } }).deeper.token).toBe(REDACT_CENSOR);
    expect(line.component).toBe('api');
    expect(line.cell).toBe('globex');
    expect(line.level).toBe('info');
    expect(line.msg).toBe('with secrets');
    expect(typeof line.time).toBe('string');
  });

  it('carries trace_id / span_id of the active span and request_id of the request context', () => {
    const { lines, stream } = capture();
    const log = pino(logSchema({ component: 'worker', logLevel: 'info' }), stream);
    const span = trace.wrapSpanContext({ traceId: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', spanId: '0102030405060708', traceFlags: 1, isRemote: false });
    context.with(trace.setSpan(context.active(), span), () => runWithRequestContext({ requestId: 'req-1' }, () => log.info('inside')));
    log.info('outside');
    expect(lines[0]).toMatchObject({ trace_id: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf', span_id: '0102030405060708', request_id: 'req-1', msg: 'inside' });
    expect(lines[1].trace_id).toBeUndefined();
    expect(lines[1].request_id).toBeUndefined();
  });

  it('LOG_LEVEL per module: `info,jobs=debug,integrations.github=trace`', () => {
    const parsed = parseLogLevel('info,jobs=debug,integrations.github=trace');
    expect(parsed.level).toBe('info');
    expect(levelFor('JobsService', parsed)).toBe('debug');
    expect(levelFor('IntegrationsService', parsed)).toBe('info');
    expect(levelFor('integrations.github', parsed)).toBe('trace');
    expect(levelFor('AuditService', parsed)).toBe('info');
    expect(levelFor(undefined, parsed)).toBe('info');
    expect(parseLogLevel('bogus').level).toBe('info');
    const { lines, stream } = capture();
    const log = pino(logSchema({ component: 'api', logLevel: 'warn,jobs=debug' }), stream);
    log.debug({ context: 'JobsService' }, 'jobs debug');        // module raised to debug: kept
    log.info({ context: 'AuditService' }, 'audit info');        // default warn: dropped
    log.warn({ context: 'AuditService' }, 'audit warn');
    log.info('no context');                                     // default warn: dropped
    expect(lines.map((l) => l.msg)).toEqual(['jobs debug', 'audit warn']);
  });
});
