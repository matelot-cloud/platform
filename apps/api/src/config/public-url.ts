import type { ConfigService } from '@nestjs/config';
import type { Env } from './env';

/**
 * The URL under which clients reach this API: what the OAuth/OIDC metadata, the registry token realm, runner
 * registration commands and keyless identity tokens advertise. In a cell the API sits behind a proxy (Caddy, the
 * ingress), so the listen address is never the right answer: API_PUBLIC_URL when set, else WEB_BASE_URL (the cell's
 * public URL, under which /api is routed to this API), else the dev fallback http://localhost:<PORT>.
 */
export function publicApiBase(config: Pick<ConfigService<Env, true>, 'get'>): string {
  const explicit = config.get('API_PUBLIC_URL', { infer: true });
  const web = config.get('WEB_BASE_URL', { infer: true });
  return (explicit ?? web ?? `http://localhost:${config.get('PORT', { infer: true })}`).replace(/\/$/, '');
}

/** Pure form for tests and tools: same precedence, plain values. */
export function resolvePublicApiBase(env: { API_PUBLIC_URL?: string; WEB_BASE_URL?: string; PORT?: number | string }): string {
  return (env.API_PUBLIC_URL ?? env.WEB_BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, '');
}
