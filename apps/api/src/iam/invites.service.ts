import { BadRequestException, GoneException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuditActor, SYSTEM_ACTOR } from '../audit/audit.types';
import { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { userInvites, users } from '../database/schema';
import { sendMail, SmtpConfig } from '../notifications/smtp';
import { KeycloakAdminService } from './keycloak-admin.service';

export type InvitePurpose = 'invite' | 'reset';
export interface IssuedLink {
  /** The link, returned only when it was NOT e-mailed (copy it to the person yourself; it is shown once). */
  setupLink: string | null;
  emailed: boolean;
  expiresAt: Date;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const LINK_DAYS = 7;
const MIN_PASSWORD = 12;

/**
 * One-time setup links: an invite (a new user sets their first password) or a reset (an existing user sets a new one).
 * Our own links rather than Keycloak's action e-mails, so they also work without SMTP — then the person who invited
 * copies the link once. Only the SHA-256 is stored; using a link sets the Keycloak password, clears the temporary flag
 * and makes every older link of that user invalid.
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ConfigService) private readonly config: AppConfig,
    private readonly keycloak: KeycloakAdminService,
    private readonly audit: AuditService,
  ) {}

  smtp(): SmtpConfig | null {
    const host = this.config.get('SMTP_HOST', { infer: true });
    if (!host) return null;
    return { host, port: this.config.get('SMTP_PORT', { infer: true }) ?? 587, user: this.config.get('SMTP_USER', { infer: true }), password: this.config.get('SMTP_PASSWORD', { infer: true }), from: this.config.get('SMTP_FROM', { infer: true }) ?? `Matelot <no-reply@${host}>`, secure: this.config.get('SMTP_SECURE', { infer: true }) ?? false };
  }

  private webBase(): string {
    return this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  async issue(userId: string, purpose: InvitePurpose, actor: AuditActor, context?: { invitedTo?: string; organizationId?: string | null }): Promise<IssuedLink> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (user.kind !== 'human') throw new BadRequestException('Service accounts have no password: create a token for them');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + LINK_DAYS * 86400_000);
    // an older unused link of the same user stops working: only the newest one is valid
    await this.db.update(userInvites).set({ usedAt: new Date() }).where(and(eq(userInvites.userId, userId), isNull(userInvites.usedAt)));
    const [row] = await this.db.insert(userInvites).values({ userId, purpose, tokenHash: hash(token), expiresAt, createdById: actor.type === 'USER' ? actor.id : null }).returning();
    const link = `${this.webBase()}/invite/${token}`;
    let emailed = false;
    const smtp = this.smtp();
    if (smtp) {
      const subject = purpose === 'invite' ? 'You have been invited to Matelot' : 'Set a new Matelot password';
      const lines = purpose === 'invite'
        ? `${actor.label ?? 'An administrator'} invited you to Matelot${context?.invitedTo ? ` (${context.invitedTo})` : ''}.\n\nSet your password and sign in:\n${link}\n\nThe link works once and expires on ${expiresAt.toUTCString()}.`
        : `${actor.label ?? 'An administrator'} reset your Matelot password.\n\nChoose a new one:\n${link}\n\nThe link works once and expires on ${expiresAt.toUTCString()}.`;
      try {
        await sendMail(smtp, [user.email], subject, lines);
        emailed = true;
      } catch (e) {
        this.logger.warn(`setup link for ${user.email} not e-mailed (${(e as Error).message}); returning it to the caller`);
      }
    }
    await this.audit.record({ organizationId: context?.organizationId ?? null, actor, action: purpose === 'invite' ? 'user.invite_link_issued' : 'user.reset_link_issued', resourceType: 'user', resourceId: userId, after: { email: user.email, linkId: row!.id, emailed, expiresAt } });
    return { setupLink: emailed ? null : link, emailed, expiresAt };
  }

  private async find(token: string) {
    const [row] = await this.db.select({ invite: userInvites, email: users.email, disabledAt: users.disabledAt, externalId: users.externalId }).from(userInvites).innerJoin(users, eq(userInvites.userId, users.id)).where(eq(userInvites.tokenHash, hash(token))).limit(1);
    if (!row) throw new NotFoundException('This link is not valid');
    if (row.invite.usedAt) throw new GoneException('This link was already used or replaced by a newer one');
    if (row.invite.expiresAt.getTime() < Date.now()) throw new GoneException('This link has expired — ask for a new one');
    if (row.disabledAt) throw new GoneException('This account is disabled');
    return row;
  }

  /** Public: what the setup page shows before asking for a password. */
  async describe(token: string) {
    const row = await this.find(token);
    return { email: row.email, purpose: row.invite.purpose as InvitePurpose, expiresAt: row.invite.expiresAt, minLength: MIN_PASSWORD };
  }

  /** Public: sets the password in Keycloak (final, not temporary) and burns the link. */
  async complete(token: string, password: string) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new BadRequestException(`The password needs at least ${MIN_PASSWORD} characters`);
    const row = await this.find(token);
    const kcId = row.externalId ?? (await this.keycloak.ensureUser({ email: row.email })).id;
    await this.keycloak.setPassword(kcId, password, false);
    await this.keycloak.setEnabled(kcId, true);
    await this.db.update(userInvites).set({ usedAt: new Date() }).where(eq(userInvites.id, row.invite.id));
    if (!row.externalId) await this.db.update(users).set({ externalId: kcId }).where(eq(users.id, row.invite.userId));
    await this.audit.record({ actor: { ...SYSTEM_ACTOR, label: row.email }, action: 'user.password_set', resourceType: 'user', resourceId: row.invite.userId, after: { via: row.invite.purpose } });
    return { email: row.email, signInUrl: `${this.webBase()}/` };
  }
}
