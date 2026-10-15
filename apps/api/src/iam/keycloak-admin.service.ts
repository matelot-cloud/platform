import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env';

export interface KeycloakUser { id: string; username: string; email?: string; enabled: boolean; firstName?: string; lastName?: string; requiredActions?: string[] }

/**
 * The cell's Keycloak, through its admin REST API, for what the platform does on people's behalf: create a user,
 * enable / disable (and end their sessions), set a temporary or final password, delete. Uses the bootstrap admin of the
 * master realm; the realm comes from KEYCLOAK_ISSUER. Not available (available = false) when the cell uses an external
 * Keycloak / IdP without admin credentials — callers then fall back to "the user appears at first sign-in".
 */
@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private readonly base?: string;
  private readonly username?: string;
  private readonly password?: string;
  readonly realm: string;
  private token?: { value: string; until: number };

  constructor(@Inject(ConfigService) config: AppConfig) {
    this.base = config.get('KEYCLOAK_ADMIN_URL', { infer: true })?.replace(/\/+$/, '');
    this.username = config.get('KC_BOOTSTRAP_ADMIN_USERNAME', { infer: true });
    this.password = config.get('KC_BOOTSTRAP_ADMIN_PASSWORD', { infer: true });
    this.realm = decodeURIComponent(new URL(config.get('KEYCLOAK_ISSUER', { infer: true })).pathname.split('/').filter(Boolean).pop() ?? 'platform');
  }

  get available(): boolean {
    return !!(this.base && this.username && this.password);
  }

  private async adminToken(): Promise<string> {
    if (!this.available) throw new ServiceUnavailableException('User administration needs the Keycloak admin API (KEYCLOAK_ADMIN_URL and the bootstrap admin) — not configured on this cell');
    if (this.token && this.token.until > Date.now()) return this.token.value;
    let r: Response;
    try {
      r = await fetch(`${this.base}/realms/master/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: this.username!, password: this.password! }) });
    } catch (e) {
      throw new ServiceUnavailableException(`Keycloak at ${this.base} is not reachable: ${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message}`);
    }
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new ServiceUnavailableException(`Keycloak admin login failed (${r.status})`);
    this.token = { value: body.access_token, until: Date.now() + Math.max(10, (body.expires_in ?? 60) - 15) * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.adminToken();
    const r = await fetch(`${this.base}/admin/realms/${encodeURIComponent(this.realm)}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401) this.token = undefined;
    return r;
  }

  private async fail(r: Response, what: string): Promise<never> {
    const text = await r.text().catch(() => '');
    let message = text;
    try { const j = JSON.parse(text) as { errorMessage?: string; error_description?: string; error?: string }; message = j.errorMessage ?? j.error_description ?? j.error ?? text; } catch { /* plain text */ }
    if (r.status === 400) throw new BadRequestException(`${what}: ${message || 'rejected by Keycloak'}`);
    this.logger.warn(`${what}: HTTP ${r.status} ${message}`);
    throw new ServiceUnavailableException(`${what}: Keycloak answered ${r.status}${message ? ` (${message})` : ''}`);
  }

  async findByEmail(email: string): Promise<KeycloakUser | null> {
    const r = await this.call('GET', `/users?email=${encodeURIComponent(email)}&exact=true`);
    if (!r.ok) return this.fail(r, 'find user');
    const rows = (await r.json()) as KeycloakUser[];
    return rows.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }

  /** Creates the user (username = e-mail) or returns the existing one; `created` tells which. */
  async ensureUser(input: { email: string; firstName?: string; lastName?: string }): Promise<{ id: string; created: boolean }> {
    const existing = await this.findByEmail(input.email);
    if (existing) return { id: existing.id, created: false };
    const r = await this.call('POST', '/users', { username: input.email, email: input.email, enabled: true, emailVerified: true, ...(input.firstName ? { firstName: input.firstName } : {}), ...(input.lastName ? { lastName: input.lastName } : {}) });
    if (r.status === 409) { const again = await this.findByEmail(input.email); if (again) return { id: again.id, created: false }; }
    if (!r.ok) return this.fail(r, 'create user');
    const id = r.headers.get('location')?.split('/').pop() ?? (await this.findByEmail(input.email))?.id;
    if (!id) throw new ServiceUnavailableException('create user: Keycloak did not return the new id');
    return { id, created: true };
  }

  async setPassword(id: string, password: string, temporary: boolean): Promise<void> {
    const r = await this.call('PUT', `/users/${id}/reset-password`, { type: 'password', value: password, temporary });
    if (!r.ok) return this.fail(r, 'set password');
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const r = await this.call('PUT', `/users/${id}`, { enabled });
    if (!r.ok) return this.fail(r, enabled ? 'enable user' : 'disable user');
    if (!enabled) await this.call('POST', `/users/${id}/logout`).catch(() => undefined);   // end their sessions now
  }

  async deleteUser(id: string): Promise<void> {
    const r = await this.call('DELETE', `/users/${id}`);
    if (!r.ok && r.status !== 404) return this.fail(r, 'delete user');
  }
}
