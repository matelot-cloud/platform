import { isTlsCode, normalizeCellUrl, readCredentials, resolveCellUrl, unreachableDetail } from './login';
export { isTlsCode, unreachableDetail } from './login';
import { signatureHeader } from './signing';

export interface Config {
  url: string;
  keyId: string;
  secret: string;
  /** Personal access token (spt_…): acts as the user instead of a CI token. */
  token?: string;
  /** token came from ~/.config/matelot/credentials.json (refreshable) */
  fromLogin?: boolean;
  /** no credentials at all: public endpoints only (`matelot invite …`, the link is the credential) */
  anonymous?: boolean;
}

export function configFromEnv(env = process.env): Config {
  const pick = (k: string) => env[`MATELOT_${k}`] ?? env[`SECOPS_${k}`];
  // the cell: MATELOT_URL (set from --url by index.ts), else the current cell of `matelot login` / `matelot use`
  const url = normalizeCellUrl(pick('URL') || resolveCellUrl(undefined, env) || '');
  // A personal access token (SECOPS_TOKEN=spt_…) replaces the CI token pair.
  const token = pick('TOKEN') ?? '';
  if (token) {
    if (!url) throw new Error('Missing MATELOT_URL (or SECOPS_URL)');
    return { url, keyId: '', secret: '', token };
  }
  const keyId = pick('KEY_ID') ?? '';
  const secret = pick('SECRET') ?? '';
  // No env credentials: use what `matelot login` stored (refreshed lazily by index.ts before the first request)
  if (!keyId && !secret) {
    const stored = url ? readCredentials(url) : null;
    if (stored?.accessToken) return { url: url || stored.url, keyId: '', secret: '', token: stored.accessToken, fromLogin: true };
    if (!url) throw new Error('no cell selected — run `matelot login --url https://…` (or `matelot use <url>` for a stored login, or set MATELOT_URL)');
  }
  const missing = [!url && 'MATELOT_URL', !keyId && 'MATELOT_KEY_ID', !secret && 'MATELOT_SECRET'].filter(Boolean);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} (CI: create a CI token in the project's Settings; as yourself: run \`matelot login --url https://…\` or set MATELOT_TOKEN to a personal access token; SECOPS_* names still work)`);
  return { url, keyId, secret };
}

export class CliError extends Error {
  /** 429 only: seconds the platform asked to wait. */
  retryAfterSeconds?: number;
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

/**
 * Over the platform's rate limit (429) the request was refused before anything ran, so it is safe to repeat — also for
 * writes. Waits for Retry-After (at most 60 s, at most 3 times; progress on stderr) and gives up with the API's message.
 */
export async function request<T = unknown>(config: Config, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<T>(config, method, path, body, timeoutMs);
    } catch (error) {
      const wait = error instanceof CliError && error.status === 429 ? error.retryAfterSeconds : undefined;
      if (wait === undefined || wait > 60 || attempt >= 3) throw error;
      process.stderr.write(`rate limited by the platform; retrying in ${wait} s\n`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function requestOnce<T = unknown>(config: Config, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`${config.url}${path}`, {
        method,
        headers: { ...(config.anonymous ? {} : { Authorization: config.token ? `Bearer ${config.token}` : signatureHeader(config.keyId, config.secret, method, path, raw) }), 'Content-Type': 'application/json', 'User-Agent': `secops-cli/${VERSION}` },
        body: raw.length ? raw : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new CliError(`cannot reach ${config.url}: ${unreachableDetail(error)}. Is MATELOT_URL correct and the platform running / reachable from this runner?`);
    }
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!response.ok) {
      const message = (parsed as { message?: string | string[] })?.message;
      const err = new CliError(`${response.status} ${Array.isArray(message) ? message.join('; ') : (message ?? text.slice(0, 200))}`, response.status, (parsed as { code?: string })?.code);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0) err.retryAfterSeconds = retryAfter;
      throw err;
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

export const VERSION = '2.23.2';
