import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { SLUG_REGEX } from './slug';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // Per-caller request limits per minute (0 = unlimited for that class); RATE_LIMIT_ENABLED=false turns them off.
  RATE_LIMIT_ENABLED: z.preprocess((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1' || v === true), z.boolean().optional()),
  RATE_LIMIT_READ_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  RATE_LIMIT_WRITE_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  RATE_LIMIT_RUNNER_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  // failed authentication (401) per client IP per minute, every path (registry token, webhooks) included
  RATE_LIMIT_AUTH_FAILURES_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),

  KEYCLOAK_ISSUER: z.string().url('KEYCLOAK_ISSUER must be the realm URL, e.g. https://auth.example.com/realms/platform'),
  KEYCLOAK_JWKS_URI: z.preprocess(emptyToUndefined, z.string().url().optional()),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('platform-api'),

  BOOTSTRAP_ORG_SLUG: z.preprocess(emptyToUndefined, z.string().regex(SLUG_REGEX).optional()),
  BOOTSTRAP_ORG_NAME: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  BOOTSTRAP_ADMIN_EMAILS: z.string().default(''),

  CORS_ORIGINS: z.string().default(''),
  /** Runner image offered in the registration commands (published releases, or a locally built tag). */
  RUNNER_IMAGE: z.string().default('ghcr.io/matelot-io/runner:latest'),
  // Shared secret of the cell's managed runners (Helm chart): they register into the "Managed" pool with it. Unset = no managed runners.
  MANAGED_RUNNER_SECRET: z.preprocess(emptyToUndefined, z.string().min(32, 'MANAGED_RUNNER_SECRET must be at least 32 characters').optional()),

  /** Public URL of the web app (where the GitHub App setup flow returns the browser). */
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
  /** Public URL of this API as seen by OAuth clients / MCP connectors (issuer). Defaults to http://localhost:PORT. */
  API_PUBLIC_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  /** 32-byte key (hex) that encrypts integration credentials at rest. `openssl rand -hex 32`. */
  CELL_ENCRYPTION_KEY: z.preprocess(emptyToUndefined, z.string().regex(/^[0-9a-fA-F]{64}$/, 'CELL_ENCRYPTION_KEY must be 64 hex characters').optional()),

  // Built-in container registry (Docker Distribution in the cell, token auth delegated to this API)
  REGISTRY_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  REGISTRY_TOKEN_KEY_PATH: z.preprocess(emptyToUndefined, z.string().optional()),
  REGISTRY_ISSUER: z.string().default('secops-cell'),
  REGISTRY_SERVICE: z.string().default('secops-registry'),
  /** Shared secret the registry sends with push notifications. */
  REGISTRY_EVENTS_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),

  // GitHub App (all optional: without them the GitHub integration reports itself unavailable)
  GITHUB_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_SLUG: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_PRIVATE_KEY_BASE64: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_APP_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Outbound e-mail for notification channels of kind "email". */
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_FROM: z.preprocess(emptyToUndefined, z.string().optional()),
  /** true = implicit TLS (465); false = STARTTLS (587) */
  SMTP_SECURE: z.preprocess(emptyToUndefined, z.coerce.boolean().optional()),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_URL: z.string().url().default('https://github.com'),
});

export type Env = z.infer<typeof envSchema>;
/** Typed ConfigService: `config.get('DATABASE_URL', { infer: true })` is a string, never undefined. */
export type AppConfig = ConfigService<Env, true>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}

/** Splits comma-separated env values ("a@x.com, b@x.com") into a trimmed, lower-cased list. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
