import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { userIdOrNull } from '../auth/authenticated-user';
import { CryptoService } from '../common/crypto.service';
import { DATABASE, Database } from '../database/database.module';
import { NOTIFICATION_EVENTS, NotificationChannel, NotificationEvent, notificationChannels } from '../database/schema';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/env';
import { sendMail, SmtpConfig } from './smtp';
import { ScopeResolverService } from '../rbac/scope-resolver.service';
import { ScopeChain, scopeParamsFor } from '../rbac/scope.types';

export interface Notification { event: NotificationEvent; organizationId: string; projectId?: string | null; title: string; text: string; url?: string; severity?: 'info' | 'warning' | 'critical'; /** dedupe key: the same key is not re-sent within `dedupeHours` */ key?: string; dedupeHours?: number; fields?: Record<string, string | number | null | undefined> }

/** Slack incoming webhooks and generic JSON webhooks; events are dispatched by the platform where things happen. */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly resolver: ScopeResolverService,
  ) {}

  /** SMTP settings of the cell (null when e-mail is not configured). */
  smtp(): SmtpConfig | null {
    const host = this.config.get('SMTP_HOST', { infer: true });
    if (!host) return null;
    return { host, port: this.config.get('SMTP_PORT', { infer: true }) ?? 587, user: this.config.get('SMTP_USER', { infer: true }), password: this.config.get('SMTP_PASSWORD', { infer: true }), from: this.config.get('SMTP_FROM', { infer: true }) ?? `Matelot <no-reply@${host}>`, secure: this.config.get('SMTP_SECURE', { infer: true }) ?? false };
  }

  private url(c: NotificationChannel) { return this.crypto.decrypt(Buffer.from(c.urlEncrypted, 'base64')); }
  private masked(c: NotificationChannel) { const u = this.url(c); if (c.kind === 'email') return u.replace(/^mailto:/, ''); try { const p = new URL(u); return `${p.origin}${p.pathname.slice(0, 12)}…`; } catch { return `${u.slice(0, 20)}…`; } }
  private validateTarget(kind: string, url: string) {
    if (kind === 'email') { const list = url.replace(/^mailto:/, '').split(',').map((x) => x.trim()).filter(Boolean); if (!list.length || list.some((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))) throw new BadRequestException('email channels need one or more valid addresses (comma-separated)'); if (!this.smtp()) throw new BadRequestException('E-mail is not configured on this cell (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM)'); return `mailto:${list.join(',')}`; }
    if (!/^https:\/\//.test(url)) throw new BadRequestException('url must be https://');
    if (kind === 'teams' && !/webhook\.office\.com|logic\.azure\.com|powerautomate|azure-api\.net/i.test(url)) return url;
    return url;
  }

  async list(organizationId: string, chain?: ScopeChain) {
    const rows = await this.db.select().from(notificationChannels).where(eq(notificationChannels.organizationId, organizationId)).orderBy(desc(notificationChannels.createdAt));
    const refs = chain ? new Set(chain.refs.map((r) => `${r.type}:${r.id}`)) : null;
    const here = chain ? `${chain.target.type}:${chain.target.id}` : null;
    return rows
      .filter((c) => !refs || c.scopeType === 'ORGANIZATION' || refs.has(`${c.scopeType}:${c.scopeId}`))
      .map(({ urlEncrypted: _u, state: _s, ...c }) => ({ ...c, url: this.masked({ ...c, urlEncrypted: _u, state: _s }), inherited: !!here && `${c.scopeType}:${c.scopeId ?? organizationId}` !== here && !(c.scopeType === 'ORGANIZATION' && chain?.target.type === 'ORGANIZATION') }));
  }

  async create(user: AuthenticatedUser, chain: ScopeChain, input: { name: string; kind: 'slack' | 'webhook' | 'teams' | 'email'; url: string; events?: string[]; projectId?: string | null }) {
    const organizationId = chain.organizationId;
    const scopeType = input.projectId ? 'PROJECT' : chain.target.type;
    const scopeId = input.projectId ?? (chain.target.type === 'ORGANIZATION' ? null : chain.target.id);
    const target = this.validateTarget(input.kind, input.url);
    const events = (input.events?.length ? input.events : [...NOTIFICATION_EVENTS]).filter((e): e is NotificationEvent => (NOTIFICATION_EVENTS as readonly string[]).includes(e));
    const [row] = await this.db.insert(notificationChannels).values({ organizationId, name: input.name.trim(), kind: input.kind, urlEncrypted: this.crypto.encrypt(target).toString('base64'), events, projectId: scopeType === 'PROJECT' ? scopeId : null, scopeType, scopeId, createdById: userIdOrNull(user) }).returning();
    await this.audit.record({ organizationId, actor: userActor(user), action: 'notification_channel.created', resourceType: 'notification_channel', resourceId: row.id, after: { name: row.name, kind: row.kind, events, scope: `${row.scopeType}:${row.scopeId ?? organizationId}` } });
    const { urlEncrypted: _u, state: _s, ...rest } = row;
    return { ...rest, url: this.masked(row) };
  }

  async update(user: AuthenticatedUser, id: string, patch: { name?: string; url?: string; events?: string[]; enabled?: boolean; projectId?: string | null }) {
    const [before] = await this.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).limit(1);
    if (!before) throw new NotFoundException('Channel not found');
    const set: Partial<typeof notificationChannels.$inferInsert> = {};
    if (patch.name) set.name = patch.name.trim();
    if (patch.url) set.urlEncrypted = this.crypto.encrypt(this.validateTarget(before.kind, patch.url)).toString('base64');
    if (patch.events) set.events = patch.events.filter((e) => (NOTIFICATION_EVENTS as readonly string[]).includes(e));
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.projectId !== undefined) set.projectId = patch.projectId;
    const [row] = await this.db.update(notificationChannels).set(set).where(eq(notificationChannels.id, id)).returning();
    await this.audit.record({ organizationId: before.organizationId, actor: userActor(user), action: 'notification_channel.updated', resourceType: 'notification_channel', resourceId: id, after: { ...patch, url: patch.url ? '(changed)' : undefined } });
    const { urlEncrypted: _u, state: _s, ...rest } = row;
    return { ...rest, url: this.masked(row) };
  }

  async remove(user: AuthenticatedUser, id: string) {
    const [row] = await this.db.delete(notificationChannels).where(eq(notificationChannels.id, id)).returning();
    if (!row) throw new NotFoundException('Channel not found');
    await this.audit.record({ organizationId: row.organizationId, actor: userActor(user), action: 'notification_channel.deleted', resourceType: 'notification_channel', resourceId: id, before: { name: row.name } });
    return { deleted: true };
  }

  /** True when the stored (encrypted) destination equals the given one — lets configuration-as-code stay idempotent. */
  async hasSameTarget(id: string, kind: string, url: string): Promise<boolean> {
    const c = await this.byId(id);
    let target = url;
    try { target = this.validateTarget(kind, url); } catch { return false; }
    return this.url(c) === target;
  }

  async byId(id: string) {
    const [row] = await this.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).limit(1);
    if (!row) throw new NotFoundException('Channel not found');
    return row;
  }

  /** Sends a test message to one channel. */
  async test(user: AuthenticatedUser, id: string) {
    const c = await this.byId(id);
    await this.deliver(c, { event: 'gate.fail', organizationId: c.organizationId, title: 'Matelot test notification', text: `Channel "${c.name}" is connected. Sent by ${user.email}.`, severity: 'info' }, true);
    return { sent: true };
  }

  /** Dispatches a notification to every matching channel of the organization (never throws). */
  async notify(n: Notification): Promise<number> {
    let sent = 0;
    try {
      const channels = await this.db.select().from(notificationChannels).where(and(eq(notificationChannels.organizationId, n.organizationId), eq(notificationChannels.enabled, true)));
      const refs = n.projectId ? new Set((await this.resolver.resolveChain({ projectId: n.projectId }).catch(() => null))?.refs.map((r) => `${r.type}:${r.id}`) ?? []) : null;
      for (const c of channels) {
        if (!c.events.includes(n.event)) continue;
        // scoped channel: only events whose project sits under the channel's scope (organization-level events reach organization channels only)
        if (c.scopeType !== 'ORGANIZATION' && (!refs || !refs.has(`${c.scopeType}:${c.scopeId}`))) continue;
        if (n.key) {
          const last = c.state[n.key];
          if (last && Date.now() - new Date(last).getTime() < (n.dedupeHours ?? 24) * 3600_000) continue;
        }
        await this.deliver(c, n);
        sent++;
      }
    } catch (e) {
      this.logger.warn(`notify ${n.event} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return sent;
  }

  private async deliver(c: NotificationChannel, n: Notification, isTest = false) {
    const url = this.url(c);
    const icon = n.severity === 'critical' ? '🔴' : n.severity === 'warning' ? '🟠' : '🔵';
    const fields = Object.entries(n.fields ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (c.kind === 'email') {
      const smtp = this.smtp();
      if (!smtp) { await this.db.update(notificationChannels).set({ lastError: 'SMTP not configured on this cell' }).where(eq(notificationChannels.id, c.id)); if (isTest) throw new BadRequestException('SMTP not configured on this cell'); return; }
      const to = url.replace(/^mailto:/, '').split(',').map((x) => x.trim()).filter(Boolean);
      const lines = [n.text, '', ...fields.map(([k, v]) => `${k}: ${v}`), ...(n.url ? ['', n.url] : [])].join('\n');
      const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222"><p style="font-size:16px"><strong>${icon} ${escapeHtml(n.title)}</strong></p><pre style="white-space:pre-wrap;font:inherit">${escapeHtml(n.text)}</pre>${fields.length ? `<table style="border-collapse:collapse">${fields.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</table>` : ''}${n.url ? `<p><a href="${n.url}">Open in Matelot</a></p>` : ''}<p style="color:#888;font-size:12px">Matelot · ${n.event}</p></div>`;
      try {
        await sendMail(smtp, to, `[Matelot] ${n.title}`, lines, html);
        await this.db.update(notificationChannels).set({ lastSentAt: new Date(), lastError: null, ...(n.key && !isTest ? { state: { ...c.state, [n.key]: new Date().toISOString() } } : {}) }).where(eq(notificationChannels.id, c.id));
        if (!isTest) await this.audit.record({ organizationId: c.organizationId, actor: SYSTEM_ACTOR, action: 'notification.sent', resourceType: 'notification_channel', resourceId: c.id, after: { event: n.event, title: n.title, to: to.length } });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await this.db.update(notificationChannels).set({ lastError: message }).where(eq(notificationChannels.id, c.id));
        if (isTest) throw new BadRequestException(`E-mail failed: ${message}`);
        this.logger.warn(`channel ${c.name}: ${message}`);
      }
      return;
    }
    const body = c.kind === 'slack'
      ? { text: `${icon} *${n.title}*\n${n.text}${n.url ? `\n<${n.url}|Open in Matelot>` : ''}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${icon} *${n.title}*\n${n.text}` } }, ...(fields.length ? [{ type: 'section', fields: fields.slice(0, 10).map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` })) }] : []), ...(n.url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in Matelot' }, url: n.url }] }] : [])] }
      : c.kind === 'teams'
      ? { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', msteams: { width: 'Full' }, body: [{ type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `${icon} ${n.title}`, wrap: true }, { type: 'TextBlock', text: n.text, wrap: true }, ...(fields.length ? [{ type: 'FactSet', facts: fields.slice(0, 10).map(([k, v]) => ({ title: k, value: String(v) })) }] : [])], actions: n.url ? [{ type: 'Action.OpenUrl', title: 'Open in Matelot', url: n.url }] : [] } }] }
      : { source: 'matelot', event: n.event, severity: n.severity ?? 'info', title: n.title, text: n.text, url: n.url ?? null, fields: Object.fromEntries(fields), organizationId: n.organizationId, projectId: n.projectId ?? null, sentAt: new Date().toISOString() };
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'matelot-notifications' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
      await this.db.update(notificationChannels).set({ lastSentAt: new Date(), lastError: null, ...(n.key && !isTest ? { state: { ...c.state, [n.key]: new Date().toISOString() } } : {}) }).where(eq(notificationChannels.id, c.id));
      if (!isTest) await this.audit.record({ organizationId: c.organizationId, actor: SYSTEM_ACTOR, action: 'notification.sent', resourceType: 'notification_channel', resourceId: c.id, after: { event: n.event, title: n.title } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await this.db.update(notificationChannels).set({ lastError: message }).where(eq(notificationChannels.id, c.id));
      if (isTest) throw new BadRequestException(`Delivery failed: ${message}`);
      this.logger.warn(`channel ${c.name}: ${message}`);
    }
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
