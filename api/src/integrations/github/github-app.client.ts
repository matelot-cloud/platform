import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, createPrivateKey, KeyObject, sign, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../../config/env';

export interface GithubRepository {
  id: number;
  full_name: string;
  default_branch: string;
  visibility?: string;
  private: boolean;
  archived: boolean;
  html_url: string;
  clone_url?: string;
  ssh_url?: string;
}

export interface GithubInstallationAccount {
  login: string;
  type: string;
}

export interface GithubAppConfig {
  appId: string;
  slug?: string;
  privateKey: KeyObject;
  webhookSecret?: string;
  apiUrl: string;
  webUrl: string;
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** Builds the GitHub App JWT (RS256, 10 min) used to mint installation tokens. */
export function createAppJwt(appId: string, privateKey: KeyObject, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // GitHub allows at most 10 min; with iat backdated 60 s the window is 9 min, and we keep a 2 min margin for host clock
  // drift (WSL2 drifts after sleep: "'exp' is too far in the future").
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 420, iss: appId }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

/** Verifies `X-Hub-Signature-256` over the raw request body. */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function loadGithubAppConfig(config: AppConfig): GithubAppConfig | undefined {
  const appId = config.get('GITHUB_APP_ID', { infer: true });
  const raw = config.get('GITHUB_APP_PRIVATE_KEY', { infer: true });
  const base64 = config.get('GITHUB_APP_PRIVATE_KEY_BASE64', { infer: true });
  if (!appId || (!raw && !base64)) return undefined;
  const pem = raw ? raw.replace(/\\n/g, '\n') : Buffer.from(base64!, 'base64').toString('utf8');
  return {
    appId,
    slug: config.get('GITHUB_APP_SLUG', { infer: true }),
    privateKey: createPrivateKey(pem),
    webhookSecret: config.get('GITHUB_APP_WEBHOOK_SECRET', { infer: true }),
    apiUrl: config.get('GITHUB_API_URL', { infer: true }).replace(/\/$/, ''),
    webUrl: config.get('GITHUB_URL', { infer: true }).replace(/\/$/, ''),
  };
}

/** Builds an app config from credentials a team registered itself (own GitHub App). */
export function githubAppConfigFrom(settings: Record<string, unknown>, privateKeyPem: string, webhookSecret?: string): GithubAppConfig {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'));
  } catch {
    throw new Error('The private key is not a valid PEM file (download it from the GitHub App settings and paste it whole)');
  }
  return {
    appId: String(settings.appId),
    slug: settings.slug ? String(settings.slug) : undefined,
    privateKey,
    webhookSecret,
    apiUrl: String(settings.apiUrl ?? 'https://api.github.com').replace(/\/$/, ''),
    webUrl: String(settings.webUrl ?? 'https://github.com').replace(/\/$/, ''),
  };
}

/**
 * Thin GitHub App client: app JWT → installation tokens (cached) → REST calls. No SDK, no surprises.
 * Works with the platform-wide App from configuration (`config`) or with an App a team registered
 * on its own connection (pass its config explicitly).
 */
@Injectable()
export class GithubAppClient {
  private readonly logger = new Logger(GithubAppClient.name);
  readonly config?: GithubAppConfig;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(@Inject(ConfigService) config: AppConfig) {
    this.config = loadGithubAppConfig(config);
    if (!this.config) this.logger.log('No platform-wide GitHub App configured; teams can register their own on a connection');
  }

  get available(): boolean {
    return !!this.config;
  }

  private require(cfg?: GithubAppConfig): GithubAppConfig {
    const resolved = cfg ?? this.config;
    if (!resolved) throw new ServiceUnavailableException('No GitHub App available for this connection');
    return resolved;
  }

  installUrl(state: string, cfg?: GithubAppConfig): string {
    const resolved = this.require(cfg);
    if (!resolved.slug) throw new ServiceUnavailableException('The GitHub App has no slug configured');
    return `${resolved.webUrl}/apps/${resolved.slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  verifySignature(rawBody: Buffer, signature: string | undefined, cfg?: GithubAppConfig): boolean {
    const resolved = this.require(cfg);
    if (!resolved.webhookSecret) return false;
    return verifyWebhookSignature(resolved.webhookSecret, rawBody, signature);
  }

  /** Verifies app credentials: GET /app with the app JWT. Returns the app's display name. */
  async probeApp(cfg: GithubAppConfig): Promise<{ name: string; slug: string; htmlUrl: string }> {
    const response = await fetch(`${cfg.apiUrl}/app`, { headers: { Authorization: `Bearer ${createAppJwt(cfg.appId, cfg.privateKey)}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub rejected the App credentials: ${response.status} ${(await response.text()).slice(0, 120)}`);
    const app = (await response.json()) as { name: string; slug: string; html_url: string };
    return { name: app.name, slug: app.slug, htmlUrl: app.html_url };
  }

  /** Installations of an App (App JWT). Used to bind an already-installed App without the browser round-trip. */
  async listInstallations(cfg: GithubAppConfig): Promise<{ id: number; account: GithubInstallationAccount; permissions: Record<string, string>; targetType: string }[]> {
    const response = await fetch(`${cfg.apiUrl}/app/installations?per_page=100`, { headers: { Authorization: `Bearer ${createAppJwt(cfg.appId, cfg.privateKey)}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub /app/installations failed: ${response.status} ${(await response.text()).slice(0, 120)}`);
    const rows = (await response.json()) as { id: number; account: GithubInstallationAccount; permissions: Record<string, string>; target_type: string }[];
    return rows.map((r) => ({ id: r.id, account: r.account, permissions: r.permissions ?? {}, targetType: r.target_type }));
  }

  /** Granted permissions of one installation (App JWT); GitHub only applies newly requested permissions once the org accepts them. */
  async installationPermissions(installationId: string, cfg?: GithubAppConfig): Promise<{ permissions: Record<string, string>; targetType: string; account: GithubInstallationAccount } | null> {
    const resolved = this.require(cfg);
    const response = await fetch(`${resolved.apiUrl}/app/installations/${installationId}`, { headers: { Authorization: `Bearer ${createAppJwt(resolved.appId, resolved.privateKey)}`, Accept: 'application/vnd.github+json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub installation lookup failed: ${response.status}`);
    const r = (await response.json()) as { permissions: Record<string, string>; target_type: string; account: GithubInstallationAccount };
    return { permissions: r.permissions ?? {}, targetType: r.target_type, account: r.account };
  }

  async installationToken(installationId: string, cfgOverride?: GithubAppConfig): Promise<string> {
    const cacheKey = `${cfgOverride?.appId ?? 'platform'}:${installationId}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) return cached.token;
    const cfg = this.require(cfgOverride);
    const response = await fetch(`${cfg.apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${createAppJwt(cfg.appId, cfg.privateKey)}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub installation token failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { token: string; expires_at: string };
    this.tokens.set(cacheKey, { token: body.token, expiresAt: new Date(body.expires_at).getTime() });
    return body.token;
  }

  private async get<T>(installationId: string, path: string, cfgOverride?: GithubAppConfig): Promise<{ status: number; body: T | null }> {
    const cfg = this.require(cfgOverride);
    const token = await this.installationToken(installationId, cfgOverride);
    const response = await fetch(`${cfg.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (response.status === 404 || response.status === 403) return { status: response.status, body: null };
    if (!response.ok) throw new Error(`GitHub GET ${path} failed: ${response.status} ${await response.text()}`);
    return { status: response.status, body: (await response.json()) as T };
  }

  async installation(installationId: string, cfgOverride?: GithubAppConfig): Promise<{ account: GithubInstallationAccount } | null> {
    const cfg = this.require(cfgOverride);
    const response = await fetch(`${cfg.apiUrl}/app/installations/${installationId}`, {
      headers: { Authorization: `Bearer ${createAppJwt(cfg.appId, cfg.privateKey)}`, Accept: 'application/vnd.github+json' },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub installation lookup failed: ${response.status}`);
    return (await response.json()) as { account: GithubInstallationAccount };
  }

  async listInstallationRepositories(installationId: string, cfg?: GithubAppConfig): Promise<GithubRepository[]> {
    const all: GithubRepository[] = [];
    for (let page = 1; page <= 50; page++) {
      const { body } = await this.get<{ total_count: number; repositories: GithubRepository[] }>(installationId, `/installation/repositories?per_page=100&page=${page}`, cfg);
      if (!body) break;
      all.push(...body.repositories);
      if (body.repositories.length < 100) break;
    }
    return all;
  }

  async repository(installationId: string, fullName: string, cfg?: GithubAppConfig): Promise<GithubRepository | null> {
    return (await this.get<GithubRepository>(installationId, `/repos/${fullName}`, cfg)).body;
  }

  async languages(installationId: string, fullName: string, cfg?: GithubAppConfig): Promise<Record<string, number>> {
    return (await this.get<Record<string, number>>(installationId, `/repos/${fullName}/languages`, cfg)).body ?? {};
  }

  /** Null when the branch has no protection (404) or the app lacks the Administration permission (403). */
  async branchProtection(installationId: string, fullName: string, branch: string, cfg?: GithubAppConfig): Promise<Record<string, unknown> | null> {
    return (await this.get<Record<string, unknown>>(installationId, `/repos/${fullName}/branches/${encodeURIComponent(branch)}/protection`, cfg)).body;
  }
}
