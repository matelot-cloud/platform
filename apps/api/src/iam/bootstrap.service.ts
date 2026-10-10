import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { AppConfig, parseList } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { memberships, organizations, User, users } from '../database/schema';

/**
 * Tenant-cell bootstrap. Each client deployment is configured (Helm values -> env) with a
 * root organization and the emails that should administer it. No manual seeding step.
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);
  private readonly checked = new Set<string>();
  private readonly orgSlug?: string;
  private readonly orgName?: string;
  private readonly adminEmails: string[];

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(ConfigService) config: AppConfig,
  ) {
    this.orgSlug = config.get('BOOTSTRAP_ORG_SLUG', { infer: true });
    this.orgName = config.get('BOOTSTRAP_ORG_NAME', { infer: true });
    this.adminEmails = parseList(config.get('BOOTSTRAP_ADMIN_EMAILS', { infer: true }));
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.orgSlug) {
      this.logger.warn('BOOTSTRAP_ORG_SLUG not set: no root organization will be created');
      return;
    }
    const [existing] = await this.db.select().from(organizations).where(eq(organizations.slug, this.orgSlug)).limit(1);
    if (existing) return;

    const [created] = await this.db
      .insert(organizations)
      .values({ slug: this.orgSlug, name: this.orgName ?? this.orgSlug })
      .onConflictDoNothing()
      .returning();
    if (!created) return;

    await this.audit.record({
      organizationId: created.id,
      actor: SYSTEM_ACTOR,
      action: 'organization.bootstrapped',
      resourceType: 'organization',
      resourceId: created.id,
      after: created,
      reason: 'Tenant cell bootstrap (BOOTSTRAP_ORG_SLUG)',
    });
    this.logger.log(`Created root organization "${created.slug}"`);
  }

  /** Called on every authenticated request; cheap after the first check per user. Returns the (possibly promoted) user. */
  async promoteBootstrapAdminIfEligible(user: User): Promise<User> {
    if (this.checked.has(user.id)) return user;
    if (!this.adminEmails.includes(user.email)) {
      this.checked.add(user.id);
      return user;
    }
    if (user.platformRole !== 'admin') {
      const [promoted] = await this.db.update(users).set({ platformRole: 'admin' }).where(eq(users.id, user.id)).returning();
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'user.platform_role_changed',
        resourceType: 'user',
        resourceId: user.id,
        before: { platformRole: user.platformRole },
        after: { platformRole: 'admin' },
        reason: 'Bootstrap administrator (BOOTSTRAP_ADMIN_EMAILS)',
      });
      user = promoted;
    }
    await this.grantRootOrgAdmin(user);
    this.checked.add(user.id);
    return user;
  }

  /** The root organization keeps an explicit owner so ownership is visible in memberships, not only via admin bypass. */
  private async grantRootOrgAdmin(user: User): Promise<void> {
    if (!this.orgSlug) return;

    const [org] = await this.db.select().from(organizations).where(eq(organizations.slug, this.orgSlug)).limit(1);
    if (!org) return;

    const [granted] = await this.db
      .insert(memberships)
      .values({ userId: user.id, scopeType: 'ORGANIZATION', scopeId: org.id, role: 'ORG_ADMIN' })
      .onConflictDoNothing()
      .returning();

    if (granted) {
      await this.audit.record({
        organizationId: org.id,
        actor: SYSTEM_ACTOR,
        action: 'membership.granted',
        resourceType: 'membership',
        resourceId: granted.id,
        after: { email: user.email, role: 'ORG_ADMIN', scopeType: 'ORGANIZATION', scopeId: org.id },
        reason: 'Bootstrap administrator (BOOTSTRAP_ADMIN_EMAILS)',
      });
      this.logger.log(`Granted ORG_ADMIN on "${org.slug}" to bootstrap admin ${user.email}`);
    }
  }
}
