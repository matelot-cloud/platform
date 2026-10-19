import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { SLUG_REGEX } from './slug';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Default level, then per-module overrides: `info,jobs=debug,integrations.github=trace` (telemetry/log-schema.ts). */
  LOG_LEVEL: z.string().regex(/^(trace|debug|info|warn|error|fatal|silent)(,[A-Za-z0-9_.-]+=(trace|debug|info|warn|error|fatal|silent))*$/, 'LOG_LEVEL: <level>[,<module>=<level>…]').default('info'),

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
  /** Licence key (M13). Accepted and ignored until entitlements ship: every cell runs as the Free tier. Set from the
   *  chart / compose .env or later through Settings → License. */
  MATELOT_LICENSE: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Runner image offered in the registration commands (published releases, or a locally built tag). */
  RUNNER_IMAGE: z.string().default('ghcr.io/matelot-cloud/runner:latest'),
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
  /** Where the API itself reaches the built-in registry (http://registry:5000 in Compose, the Service in the chart): the
   *  public REGISTRY_HOST is a Caddy/ingress name — inside the api container `localhost:5000` is the api. */
  REGISTRY_INTERNAL_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
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
  /** Keycloak admin API (user administration, invites, password resets): the bundled Keycloak's in-cluster address
   *  (http://<release>-keycloak:8080 in the chart, http://keycloak:8080/auth in Compose) and its bootstrap admin. Unset =
   *  users come only from the identity provider (create / reset / invite links are unavailable, the rest works). */
  KEYCLOAK_ADMIN_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  KC_BOOTSTRAP_ADMIN_USERNAME: z.preprocess(emptyToUndefined, z.string().optional()),
  KC_BOOTSTRAP_ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Longest life of a service-account token, in days (GitLab: access tokens max 365). */
  SERVICE_ACCOUNT_TOKEN_MAX_DAYS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(3650).default(365)),
  /** Comma-separated capability names to turn off (features/features.ts); also read directly by featureEnabled(). */
  MATELOT_FEATURES_DISABLED: z.preprocess(emptyToUndefined, z.string().optional()),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  GITHUB_URL: z.string().url().default('https://github.com'),

  // Observability (docs/observability.md). The OTEL_* variables are read by the SDK itself (tracing preload); these
  // are ours. Metrics: a Prometheus / OpenMetrics page on its own port, never on the ingress.
  MATELOT_METRICS_ENABLED: z.preprocess((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1' || v === true), z.boolean().default(true)),
  MATELOT_METRICS_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(9464)),
  /** Tracing is decided by the preload (MATELOT_TRACING_ENABLED, else an OTLP endpoint); listed here so it is documented and validated. */
  MATELOT_TRACING_ENABLED: z.preprocess(emptyToUndefined, z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional()),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  OTEL_EXPORTER_OTLP_HEADERS: z.preprocess(emptyToUndefined, z.string().optional()),
  OTEL_EXPORTER_OTLP_PROTOCOL: z.preprocess(emptyToUndefined, z.enum(['grpc', 'http/protobuf', 'http/json']).optional()),
  OTEL_TRACES_SAMPLER: z.preprocess(emptyToUndefined, z.enum(['always_on', 'always_off', 'traceidratio', 'parentbased_always_on', 'parentbased_always_off', 'parentbased_traceidratio']).optional()),
  OTEL_TRACES_SAMPLER_ARG: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1).optional()),
  OTEL_METRICS_EXPORTER: z.preprocess(emptyToUndefined, z.string().regex(/^(prometheus|otlp|none)(,(prometheus|otlp|none))*$/).optional()),
  /** `deployment.environment` on every signal. */
  DEPLOYMENT_ENVIRONMENT: z.string().default('production'),
  APP_VERSION: z.preprocess(emptyToUndefined, z.string().optional()),
  APP_COMMIT: z.preprocess(emptyToUndefined, z.string().optional()),
  APP_BUILT_AT: z.preprocess(emptyToUndefined, z.string().optional()),
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
