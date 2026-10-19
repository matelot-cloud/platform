/**
 * One log line shape for api, worker and runner (docs/observability.md, "Logs"):
 *   {"time":"2026-10-19T10:00:00.000Z","level":"info","component":"api","cell":"globex","msg":"…",
 *    "context":"JobsService","trace_id":"…","span_id":"…","request_id":"…", …fields}
 * trace_id / span_id come from the active span (empty without one); request_id from the request context
 * (x-request-id); `context` is Nest's logger context (the class), which the per-module levels match on.
 * Redaction: ONE list (REDACTED_KEYS) applied to every logger, tested by log-schema.spec.ts.
 */
import { trace } from '@opentelemetry/api';
import type { LoggerOptions } from 'pino';
import { currentRequestContext } from '../common/request-context';

/** Keys whose values never reach a log line, at any depth (pino redact paths are built from them). */
export const REDACTED_KEYS = ['authorization', 'cookie', 'set-cookie', 'password', 'secret', 'token', 'accessToken', 'refreshToken', 'idToken', 'privateKey', 'clientSecret', 'webhookSecret', 'apiKey', 'api_key', 'credentials', 'registrationToken', 'runnerToken', 'seedPassword', 'smtpPassword', 'encryptionKey'];

export const REDACT_CENSOR = '[Redacted]';

/** pino redact paths: the keys at the top, under req.headers, and nested up to three levels (pino needs explicit paths). */
export function redactPaths(keys: string[] = REDACTED_KEYS): string[] {
  const paths: string[] = [];
  for (const k of keys) {
    const key = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `["${k}"]`;
    paths.push(key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`, `req.headers.${key}`, `res.headers.${key}`);
  }
  return paths;
}

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type Level = (typeof LEVELS)[number];
const LEVEL_VALUE: Record<Level, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };

/** `info,jobs=debug,integrations.github=trace` → default + per-module levels. */
export function parseLogLevel(value: string | undefined): { level: Level; modules: Map<string, Level> } {
  const parts = (value ?? 'info').split(',').map((s) => s.trim()).filter(Boolean);
  const level = (LEVELS as readonly string[]).includes(parts[0] ?? '') ? (parts[0] as Level) : 'info';
  const modules = new Map<string, Level>();
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const mod = p.slice(0, i).trim().toLowerCase();
    const lvl = p.slice(i + 1).trim().toLowerCase();
    if ((LEVELS as readonly string[]).includes(lvl)) modules.set(mod, lvl as Level);
  }
  return { level, modules };
}

/** The level a context ("JobsService", "integrations.github") logs at: the most specific module prefix wins. */
export function levelFor(context: string | undefined, parsed: { level: Level; modules: Map<string, Level> }): Level {
  if (!context || !parsed.modules.size) return parsed.level;
  const ctx = context.toLowerCase().replace(/service$|controller$/, '');
  let best: { len: number; level: Level } | null = null;
  for (const [mod, level] of parsed.modules) {
    if (ctx === mod || ctx.startsWith(mod) || context.toLowerCase().startsWith(mod)) if (!best || mod.length > best.len) best = { len: mod.length, level };
  }
  return best?.level ?? parsed.level;
}

export interface LogSchemaOptions {
  component: 'api' | 'worker';
  cell?: string;
  logLevel?: string;
  pretty?: boolean;
}

/** pino options implementing the schema; spread into nestjs-pino's `pinoHttp`. */
export function logSchema(options: LogSchemaOptions): LoggerOptions {
  const parsed = parseLogLevel(options.logLevel);
  const minimum = [parsed.level, ...parsed.modules.values()].reduce((a, b) => (LEVEL_VALUE[b] < LEVEL_VALUE[a] ? b : a));
  return {
    level: minimum,   // the lowest level any module asks for; logMethod filters per context below
    messageKey: 'msg',
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    base: { component: options.component, ...(options.cell ? { cell: options.cell } : {}) },
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: redactPaths(), censor: REDACT_CENSOR },
    mixin() {
      const span = trace.getActiveSpan()?.spanContext();
      const req = currentRequestContext();
      return { ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}), ...(req ? { request_id: req.requestId } : {}) };
    },
    hooks: {
      logMethod(args, method, level) {
        // nestjs-pino logs `{ context }` as the first argument; a module set to a higher level drops the line
        const first = args[0] as { context?: string } | undefined;
        const ctx = first && typeof first === 'object' ? first.context : undefined;
        if (parsed.modules.size && level < LEVEL_VALUE[levelFor(ctx, parsed)]) return;
        method.apply(this, args as Parameters<typeof method>);
      },
    },
    ...(options.pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  };
}
