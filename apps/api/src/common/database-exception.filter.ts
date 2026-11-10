import { ArgumentsHost, Catch, ConflictException, HttpException } from '@nestjs/common';
import { AbstractHttpAdapter, BaseExceptionFilter } from '@nestjs/core';
import { PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../database/errors';
import { TOKEN_PREFIX } from '../auth/personal-tokens/personal-tokens.service';
import { classifyRefusal, getEvents, type SecurityDetails } from '../telemetry/events';
import { SIGNATURE_SCHEME } from '../tokens/signing';
import type { RateLimitInterceptor } from './rate-limit/rate-limit.interceptor';

/**
 * Turns Postgres constraint violations into 409s, and counts failed authentication (401) / refused authorization (403)
 * against the rate limits — a 429 replaces them once over the limit. Everything else falls through to Nest's defaults.
 * Every 401 / 403 / 429 that leaves here is also a `matelot.security` event (telemetry/events.ts) — the gate's own
 * refusal excepted (`code: gate_rejected`), which PoliciesService reports as `gate.failed` with the violations.
 */
@Catch()
export class DatabaseExceptionFilter extends BaseExceptionFilter {
  constructor(adapter?: AbstractHttpAdapter, private readonly limiter?: Pick<RateLimitInterceptor, 'onAuthFailure'>) {
    super(adapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const code = pgErrorCode(exception);
    if (code === PG_UNIQUE_VIOLATION) {
      return super.catch(new ConflictException('A record with the same unique value already exists'), host);
    }
    if (code === PG_FOREIGN_KEY_VIOLATION) {
      return super.catch(new ConflictException('The referenced record does not exist or is still in use'), host);
    }
    const status = exception instanceof HttpException ? exception.getStatus() : 0;
    if (this.limiter && host.getType() === 'http' && (status === 401 || status === 403)) {
      const http = host.switchToHttp();
      void this.limiter.onAuthFailure(http.getRequest(), http.getResponse(), status)
        .then((replacement) => { this.securityEvent(replacement ?? exception, host); super.catch(replacement ?? exception, host); })
        .catch(() => { this.securityEvent(exception, host); super.catch(exception, host); });
      return;
    }
    if (host.getType() === 'http' && (status === 401 || status === 403 || status === 429)) this.securityEvent(exception, host);
    return super.catch(exception, host);
  }

  /** The refusal as a `matelot.security` record: kind from status + message, route template, the caller when known. */
  private securityEvent(exception: unknown, host: ArgumentsHost): void {
    try {
      if (!(exception instanceof HttpException)) return;
      const status = exception.getStatus();
      const res = exception.getResponse();
      const body = typeof res === 'object' && res ? (res as { message?: unknown; code?: unknown }) : {};
      if (body.code === 'gate_rejected') return;
      const message = typeof body.message === 'string' ? body.message : Array.isArray(body.message) ? body.message.join('; ') : exception.message;
      const req = host.switchToHttp().getRequest<RefusedRequest>();
      const authMethod = authMethodOf(req);
      const kind = classifyRefusal(status, message, authMethod);
      if (!kind) return;
      const details: SecurityDetails = { reason: message, authMethod, method: req.method, route: req.route?.path ?? req.baseUrl ?? undefined, status };
      if (req.user?.id) details.actor = req.user.token ? { type: 'TOKEN', id: req.user.token.id, label: req.user.token.name } : { type: 'USER', id: req.user.id, label: req.user.email };
      if (req.user?.token?.scopeType === 'organization') details.organizationId = req.user.token.scopeId;
      getEvents().security(kind, details);
    } catch { /* an event must never turn a refusal into a 500 */ }
  }
}

interface RefusedRequest {
  method: string;
  baseUrl?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
  user?: { id?: string; email?: string; token?: { id: string; name: string; scopeType: string; scopeId: string } };
  runner?: unknown;
}

/** How the caller tried to authenticate, from what the guards left on the request and the Authorization scheme. */
export function authMethodOf(req: Pick<RefusedRequest, 'headers' | 'user' | 'runner'>): SecurityDetails['authMethod'] {
  if (req.runner) return 'runner';
  if (req.user?.token) return 'api_token';
  const auth = String(req.headers['authorization'] ?? '');
  if (auth.startsWith(`${SIGNATURE_SCHEME} `)) return 'api_token';          // signed CI token (tokens/signing.ts)
  if (auth.startsWith(`Bearer ${TOKEN_PREFIX}`)) return 'personal_token';   // spt_… (auth/personal-tokens)
  if (auth.startsWith('Bearer rt_')) return 'runner';                       // runner token (execution/runner-auth.ts)
  if (/^Bearer\s+\S/.test(auth)) return 'jwt';
  return 'anonymous';
}
