/**
 * The audit / security event schema is a contract with customers' SIEM rules (docs/observability.md, "Audit and
 * security events"): this spec pins the event names, every attribute name and the redaction, through the real OTel
 * logs SDK (an InMemoryLogRecordExporter) and the stdout line.
 */
import { Logger } from '@nestjs/common';
import { logs } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { authMethodOf } from '../common/database-exception.filter';
import { AUDIT_ATTRIBUTES, AUDIT_EVENT, Events, SECURITY_ATTRIBUTES, SECURITY_EVENT, SECURITY_KINDS, auditAttributes, classifyRefusal, redactedJson, securityAttributes } from './events';

const ctx = { requestId: 'req-1', ip: '10.0.0.7', userAgent: 'matelot-cli/2.25.0' };
const entry = { organizationId: 'org-1', actor: { type: 'USER' as const, id: 'u-1', label: 'alice@acme.local' }, action: 'project.updated', resourceType: 'project', resourceId: 'p-1', reason: 'rename', before: { name: 'a', webhookSecret: 'whs_123' }, after: { name: 'b', nested: { token: 'tok', ok: 1 } } };

describe('events: the SIEM schema', () => {
  it('audit attributes: exactly the documented names, redacted JSON for before / after', () => {
    const a = auditAttributes(entry, ctx);
    expect(Object.keys(a).sort()).toEqual([...AUDIT_ATTRIBUTES].sort());
    expect(a['event.name']).toBe(AUDIT_EVENT);
    expect(a['matelot.audit.action']).toBe('project.updated');
    expect(a['matelot.actor.label']).toBe('alice@acme.local');
    expect(a['matelot.request.id']).toBe('req-1');
    expect(a['client.address']).toBe('10.0.0.7');
    expect(JSON.parse(String(a['matelot.audit.before']))).toEqual({ name: 'a', webhookSecret: '[Redacted]' });
    expect(JSON.parse(String(a['matelot.audit.after']))).toEqual({ name: 'b', nested: { token: '[Redacted]', ok: 1 } });
    expect(a['matelot.audit.before']).not.toContain('whs_123');
  });

  it('audit attributes: optional ones are absent, never null or empty', () => {
    const a = auditAttributes({ actor: { type: 'SYSTEM', label: 'platform' }, action: 'backup.succeeded', resourceType: 'backup', resourceId: 'cell' }, undefined);
    expect(Object.keys(a).sort()).toEqual(['event.name', 'matelot.actor.label', 'matelot.actor.type', 'matelot.audit.action', 'matelot.audit.resource.id', 'matelot.audit.resource.type']);
  });

  it('redactedJson: any depth, any case, clipped at 4 KiB', () => {
    expect(redactedJson({ a: { b: { Password: 'x', apiKey: 'y' } }, list: [{ secret: 'z' }] })).toBe('{"a":{"b":{"Password":"[Redacted]","apiKey":"[Redacted]"}},"list":[{"secret":"[Redacted]"}]}');
    expect(redactedJson(undefined)).toBeUndefined();
    expect(redactedJson({ big: 'x'.repeat(10000) })!.length).toBe(4096);
    expect(redactedJson({ big: 'x'.repeat(10000) })!.endsWith('…')).toBe(true);
  });

  it('security attributes: exactly the documented names and kinds', () => {
    const a = securityAttributes('gate.failed', { reason: 'blocked', organizationId: 'org-1', projectId: 'p-1', serviceId: 's-1', violations: ['Block critical: 2 critical findings'], actor: { type: 'SYSTEM', label: 'platform' }, authMethod: 'api_token', method: 'POST', route: '/api/v1/services/:serviceId/gate', status: 403 }, ctx);
    expect(Object.keys(a).sort()).toEqual([...SECURITY_ATTRIBUTES].filter((k) => k !== 'matelot.actor.id').sort());
    expect(a['event.name']).toBe(SECURITY_EVENT);
    expect(a['matelot.security.kind']).toBe('gate.failed');
    expect(a['matelot.gate.violations']).toBe('Block critical: 2 critical findings');
    expect(SECURITY_KINDS).toEqual(['auth.failed', 'token.rejected', 'account.disabled', 'access.denied', 'rate_limit.exceeded', 'gate.failed']);
  });

  it('classifyRefusal: status + message → kind; nothing for other statuses', () => {
    expect(classifyRefusal(401, 'Unauthorized', 'jwt')).toBe('auth.failed');
    expect(classifyRefusal(401, 'Invalid signature: expired', 'api_token')).toBe('token.rejected');
    expect(classifyRefusal(401, 'Replayed request (nonce already used)', 'anonymous')).toBe('token.rejected');
    expect(classifyRefusal(401, 'This account is disabled', 'jwt')).toBe('account.disabled');
    expect(classifyRefusal(403, 'Forbidden', 'jwt')).toBe('access.denied');
    expect(classifyRefusal(429, 'Rate limit exceeded', 'anonymous')).toBe('rate_limit.exceeded');
    expect(classifyRefusal(404, 'Not found', 'jwt')).toBeNull();
    expect(classifyRefusal(500, 'boom', 'jwt')).toBeNull();
  });

  it('authMethodOf: the Authorization scheme the guards accept', () => {
    const h = (authorization?: string) => ({ headers: { authorization } });
    expect(authMethodOf(h())).toBe('anonymous');
    expect(authMethodOf(h('Bearer eyJhbGciOi.x.y'))).toBe('jwt');
    expect(authMethodOf(h('Bearer spt_abc'))).toBe('personal_token');
    expect(authMethodOf(h('Bearer rt_abc'))).toBe('runner');
    expect(authMethodOf(h('SecOps-HMAC-SHA256 keyId=k,nonce=n,ts=1,sig=s'))).toBe('api_token');
    expect(authMethodOf({ ...h('Bearer x'), user: { id: 'u', token: { id: 't', name: 'ci', scopeType: 'project', scopeId: 'p' } } })).toBe('api_token');
    expect(authMethodOf({ ...h('Bearer x'), runner: {} })).toBe('runner');
  });

  it('emits one OTel log record per event with the attributes, INFO for audit and WARN for security', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
    const previous = logs.getLoggerProvider();
    logs.setGlobalLoggerProvider(provider);
    const lines: unknown[] = [];
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => { lines.push(m); });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => { lines.push(m); });
    try {
      const events = new Events();
      events.audit(entry, ctx);
      events.security('access.denied', { reason: 'Forbidden', authMethod: 'jwt', method: 'DELETE', route: '/api/v1/projects/:projectId', status: 403, actor: { type: 'USER', id: 'u-1', label: 'alice@acme.local' } }, ctx);
      await provider.forceFlush();
      const records = exporter.getFinishedLogRecords();
      expect(records).toHaveLength(2);
      expect(records[0].instrumentationScope.name).toBe('matelot.events');
      expect(records[0].severityText).toBe('INFO');
      expect(records[0].attributes['event.name']).toBe(AUDIT_EVENT);
      expect(records[0].attributes).toEqual(auditAttributes(entry, ctx));
      expect(records[1].severityText).toBe('WARN');
      expect(records[1].attributes['event.name']).toBe(SECURITY_EVENT);
      expect(records[1].attributes['http.route']).toBe('/api/v1/projects/:projectId');
      expect(records[1].body).toBe('access.denied: Forbidden');
      // the stdout line carries the same attributes (as pino fields) so a log shipper is enough without OTLP
      expect(lines).toHaveLength(2);
      expect((lines[0] as Record<string, unknown>)['event.name']).toBe(AUDIT_EVENT);
      expect((lines[0] as Record<string, unknown>)['matelot.audit.before']).not.toContain('whs_123');
      expect((lines[1] as Record<string, unknown>)['matelot.security.kind']).toBe('access.denied');
      expect(events.emitted()).toEqual({ audit: 1, security: 1 });
    } finally {
      log.mockRestore(); warn.mockRestore();
      logs.setGlobalLoggerProvider(previous);
      await provider.shutdown();
    }
  });

  it('without a provider the OTel side is a no-op and the stdout line still goes out', () => {
    logs.disable();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      expect(() => new Events().audit(entry, ctx)).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
});
