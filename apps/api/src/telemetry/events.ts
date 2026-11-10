/**
 * Audit and security events for SIEMs (docs/observability.md, "Audit and security events"): every audit entry and
 * every security-relevant refusal is emitted twice, with the same attributes —
 *
 *   1. a line on stdout through the process logger (`component`, `cell`, `trace_id` … of the log schema plus the
 *      attributes below, `event.name` = `matelot.audit` / `matelot.security`) — the primary: Alloy / Fluent Bit /
 *      the collector's filelog receiver ship it like any other line;
 *   2. an OpenTelemetry log record with the same `event.name` and attributes, through the OTel logs API — exported
 *      when the preload started a logs exporter (OTEL_LOGS_EXPORTER=otlp, observability.otlp.logs on Helm,
 *      MATELOT_OTLP_LOGS=1 on Compose), a no-op otherwise.
 *
 * The attribute names are the contract: AUDIT_ATTRIBUTES and SECURITY_ATTRIBUTES are pinned by events.spec.ts and
 * documented field by field — a rename is a breaking change for every customer's SIEM rules. `before` / `after`
 * travel as redacted JSON (REDACTED_KEYS of the log schema, at any depth), clipped at 4 KiB; ids are the cell's own
 * (never names or e-mails beyond the actor's label, which the audit trail already stores).
 */
import { Logger } from '@nestjs/common';
import { SeverityNumber, logs, type AnyValueMap } from '@opentelemetry/api-logs';
import { currentRequestContext, type RequestContextData } from '../common/request-context';
import type { AuditEntry } from '../audit/audit.types';
import { REDACTED_KEYS, REDACT_CENSOR } from './log-schema';

export const AUDIT_EVENT = 'matelot.audit';
export const SECURITY_EVENT = 'matelot.security';
export const EVENTS_SCOPE = 'matelot.events';

/** Attributes of a `matelot.audit` record (plus the resource: service.name, matelot.cell, matelot.component, …). */
export const AUDIT_ATTRIBUTES = [
  'event.name',                  // "matelot.audit"
  'matelot.audit.action',        // dotted verb: project.created, member.role_changed, gate.fail, backup.succeeded …
  'matelot.audit.resource.type', // project, integration, policy, gate_evaluation, user, token …
  'matelot.audit.resource.id',
  'matelot.audit.reason',        // the reason the actor gave, when the API asked for one
  'matelot.audit.before',        // JSON, redacted, ≤ 4 KiB — absent when the action has no previous state
  'matelot.audit.after',         // JSON, redacted, ≤ 4 KiB
  'matelot.actor.type',          // USER | SYSTEM | TOKEN | RUNNER (the audit trail's actor types)
  'matelot.actor.id',
  'matelot.actor.label',         // the e-mail / token name / runner name the audit trail shows
  'matelot.organization.id',
  'matelot.request.id',          // x-request-id of the request that caused it, when there is one
  'client.address',              // the caller's IP as the API saw it (behind the ingress: X-Forwarded-For)
  'user_agent.original',
] as const;

/** Attributes of a `matelot.security` record. */
export const SECURITY_ATTRIBUTES = [
  'event.name',                  // "matelot.security"
  'matelot.security.kind',       // SecurityKind below
  'matelot.security.reason',     // the refusal's own message (never a credential)
  'matelot.auth.method',         // how the caller tried to authenticate: jwt | api_token | personal_token | runner | anonymous
  'http.request.method',
  'http.route',                  // the route template (never the raw path)
  'http.response.status_code',
  'matelot.actor.type',          // when the caller was identified before the refusal (a 403)
  'matelot.actor.id',
  'matelot.actor.label',
  'matelot.organization.id',
  'matelot.project.id',          // gate.failed: the project the gate protects
  'matelot.service.id',          // gate.failed
  'matelot.gate.violations',     // gate.failed: "<policy>: <message>" lines, ≤ 4 KiB
  'matelot.request.id',
  'client.address',
  'user_agent.original',
] as const;

export const SECURITY_KINDS = [
  'auth.failed',          // 401: no valid credential (bad or expired JWT, unknown personal token, bad registry / webhook auth)
  'token.rejected',       // 401 on a signed CI token: bad signature, revoked or expired token, replayed nonce
  'account.disabled',     // 401: a disabled account presented a valid token
  'access.denied',        // 403: authenticated, lacks the permission (or the token's scope stops at it)
  'rate_limit.exceeded',  // 429
  'gate.failed',          // a policy gate blocked a pipeline stage / deployment
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

const MAX_JSON = 4096;
type Attrs = Record<string, string | number | boolean>;

/** The audit trail's `before` / `after` as JSON for a record: REDACTED_KEYS censored at any depth, clipped at 4 KiB. */
export function redactedJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const keys = new Set(REDACTED_KEYS.map((k) => k.toLowerCase()));
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return '[Truncated]';
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, keys.has(k.toLowerCase()) ? REDACT_CENSOR : walk(x, depth + 1)]));
    return v;
  };
  let json: string;
  try { json = JSON.stringify(walk(value, 0)); } catch { return '[Unserializable]'; }
  if (json === undefined) return undefined;
  return json.length > MAX_JSON ? json.slice(0, MAX_JSON - 1) + '…' : json;
}

function requestAttrs(ctx: RequestContextData | undefined): Attrs {
  const out: Attrs = {};
  if (ctx?.requestId) out['matelot.request.id'] = ctx.requestId;
  if (ctx?.ip) out['client.address'] = ctx.ip;
  if (ctx?.userAgent) out['user_agent.original'] = ctx.userAgent.slice(0, 256);
  return out;
}

/** Pure: the attributes of an audit record. */
export function auditAttributes(entry: AuditEntry, ctx: RequestContextData | undefined = currentRequestContext()): Attrs {
  const out: Attrs = { 'event.name': AUDIT_EVENT, 'matelot.audit.action': entry.action, 'matelot.audit.resource.type': entry.resourceType, 'matelot.audit.resource.id': entry.resourceId, 'matelot.actor.type': entry.actor.type };
  if (entry.actor.id) out['matelot.actor.id'] = entry.actor.id;
  if (entry.actor.label) out['matelot.actor.label'] = entry.actor.label;
  if (entry.organizationId) out['matelot.organization.id'] = entry.organizationId;
  if (entry.reason) out['matelot.audit.reason'] = entry.reason;
  const before = redactedJson(entry.before); if (before !== undefined) out['matelot.audit.before'] = before;
  const after = redactedJson(entry.after); if (after !== undefined) out['matelot.audit.after'] = after;
  return { ...out, ...requestAttrs(ctx) };
}

export interface SecurityDetails {
  reason?: string;
  authMethod?: 'jwt' | 'api_token' | 'personal_token' | 'runner' | 'anonymous';
  method?: string;
  route?: string;
  status?: number;
  actor?: { type: string; id?: string | null; label?: string | null };
  organizationId?: string | null;
  projectId?: string | null;
  serviceId?: string | null;
  violations?: string[];
}

/** Pure: the attributes of a security record. */
export function securityAttributes(kind: SecurityKind, d: SecurityDetails, ctx: RequestContextData | undefined = currentRequestContext()): Attrs {
  const out: Attrs = { 'event.name': SECURITY_EVENT, 'matelot.security.kind': kind };
  if (d.reason) out['matelot.security.reason'] = d.reason.slice(0, 512);
  if (d.authMethod) out['matelot.auth.method'] = d.authMethod;
  if (d.method) out['http.request.method'] = d.method;
  if (d.route) out['http.route'] = d.route;
  if (d.status) out['http.response.status_code'] = d.status;
  if (d.actor) { out['matelot.actor.type'] = d.actor.type; if (d.actor.id) out['matelot.actor.id'] = d.actor.id; if (d.actor.label) out['matelot.actor.label'] = d.actor.label; }
  if (d.organizationId) out['matelot.organization.id'] = d.organizationId;
  if (d.projectId) out['matelot.project.id'] = d.projectId;
  if (d.serviceId) out['matelot.service.id'] = d.serviceId;
  if (d.violations?.length) { const v = d.violations.join('\n'); out['matelot.gate.violations'] = v.length > MAX_JSON ? v.slice(0, MAX_JSON - 1) + '…' : v; }
  return { ...out, ...requestAttrs(ctx) };
}

/** One emitter per process: the stdout line and the OTel record. */
export class Events {
  private readonly logger = new Logger('events');
  private readonly counts = { audit: 0, security: 0 };

  audit(entry: AuditEntry, ctx?: RequestContextData): void {
    const attrs = auditAttributes(entry, ctx);
    this.counts.audit++;
    this.logger.log({ ...attrs, msg: `audit ${entry.action} ${entry.resourceType} ${entry.resourceId}` });
    logs.getLogger(EVENTS_SCOPE).emit({ severityNumber: SeverityNumber.INFO, severityText: 'INFO', body: `${entry.action} ${entry.resourceType} ${entry.resourceId}`, attributes: attrs as AnyValueMap });
  }

  security(kind: SecurityKind, details: SecurityDetails, ctx?: RequestContextData): void {
    const attrs = securityAttributes(kind, details, ctx);
    this.counts.security++;
    this.logger.warn({ ...attrs, msg: `security ${kind}${details.reason ? `: ${details.reason}` : ''}` });
    logs.getLogger(EVENTS_SCOPE).emit({ severityNumber: SeverityNumber.WARN, severityText: 'WARN', body: `${kind}${details.reason ? `: ${details.reason}` : ''}`, attributes: attrs as AnyValueMap });
  }

  /** How many of each this process emitted (Settings → Observability shows it). */
  emitted(): { audit: number; security: number } { return { ...this.counts }; }
}

let instance: Events | null = null;
export function getEvents(): Events {
  if (!instance) instance = new Events();
  return instance;
}
export function setEventsForTests(e: Events | null): void { instance = e; }

/** The security kind of a refused request, from its status and the guard's message. */
export function classifyRefusal(status: number, message: string | undefined, authMethod: SecurityDetails['authMethod']): SecurityKind | null {
  if (status === 429) return 'rate_limit.exceeded';
  if (status === 403) return 'access.denied';
  if (status !== 401) return null;
  if (/disabled/i.test(message ?? '')) return 'account.disabled';
  if (authMethod === 'api_token' || /signature|nonce|replayed/i.test(message ?? '')) return 'token.rejected';
  return 'auth.failed';
}
