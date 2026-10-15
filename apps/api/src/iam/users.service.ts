import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AuditActor, SYSTEM_ACTOR } from '../audit/audit.types';
import type { KeycloakClaims } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../database/errors';
import { User, users } from '../database/schema';

const LOGIN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * The name to show for a user, or null: Keycloak's `name` (first + last) when it is set; `preferred_username` only when
 * it is a real handle — not the e-mail address, which is what seeded and invited users have as their username. With
 * null the UI shows the e-mail and derives the initials from it (never a placeholder such as "Cell Admin").
 */
export function displayNameFromClaims(claims: Pick<KeycloakClaims, 'name' | 'preferred_username'>, email: string): string | null {
  const name = claims.name?.trim();
  if (name) return name;
  const handle = claims.preferred_username?.trim();
  if (handle && handle.toLowerCase() !== email && !handle.includes('@')) return handle;
  return null;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Just-in-time provisioning: the first request carrying a valid Keycloak token creates the
   * platform user. Users invited by email before their first login are linked by email.
   */
  async provisionFromClaims(claims: KeycloakClaims): Promise<User> {
    const email = claims.email ? normalizeEmail(claims.email) : undefined;
    if (!email) throw new UnauthorizedException('Access token does not contain an email claim');
    const displayName = displayNameFromClaims(claims, email);

    const [byExternalId] = await this.db.select().from(users).where(eq(users.externalId, claims.sub)).limit(1);
    if (byExternalId) return this.touch(byExternalId, displayName);

    const [byEmail] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (byEmail) {
      if (byEmail.externalId && byEmail.externalId !== claims.sub) {
        throw new UnauthorizedException('This email is already linked to a different identity');
      }
      const [linked] = await this.db
        .update(users)
        .set({ externalId: claims.sub, displayName: byEmail.displayName ?? displayName, lastLoginAt: new Date() })
        .where(eq(users.id, byEmail.id))
        .returning();
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'user.linked',
        resourceType: 'user',
        resourceId: linked.id,
        after: { email, externalId: claims.sub },
      });
      return linked;
    }

    try {
      const [created] = await this.db
        .insert(users)
        .values({ externalId: claims.sub, email, displayName, lastLoginAt: new Date() })
        .returning();
      await this.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'user.provisioned',
        resourceType: 'user',
        resourceId: created.id,
        after: { email, externalId: claims.sub },
      });
      return created;
    } catch (error) {
      // Two first requests racing: the other one won, use its row.
      if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error;
      const [raced] = await this.db.select().from(users).where(eq(users.externalId, claims.sub)).limit(1);
      if (!raced) throw error;
      return raced;
    }
  }

  async findById(id: string): Promise<User | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  /** Used when granting a membership to someone who has not logged in yet. */
  async findOrCreateByEmail(email: string, actor: AuditActor): Promise<User> {
    const normalized = normalizeEmail(email);
    const [existing] = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    if (existing) return existing;

    const [created] = await this.db.insert(users).values({ email: normalized }).onConflictDoNothing().returning();
    if (created) {
      await this.audit.record({
        actor,
        action: 'user.invited',
        resourceType: 'user',
        resourceId: created.id,
        after: { email: normalized },
      });
      return created;
    }
    const [raced] = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    return raced;
  }

  private async touch(user: User, displayName: string | null): Promise<User> {
    const stale = !user.lastLoginAt || Date.now() - user.lastLoginAt.getTime() > LOGIN_TOUCH_INTERVAL_MS;
    // a display name that is just the e-mail (stored by older versions from preferred_username) is cleared
    const emailAsName = !!user.displayName && user.displayName.trim().toLowerCase() === user.email;
    const nameChanged = (displayName !== null && displayName !== user.displayName) || emailAsName;
    if (!stale && !nameChanged) return user;
    const [updated] = await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), displayName: displayName ?? (emailAsName ? null : user.displayName) })
      .where(eq(users.id, user.id))
      .returning();
    return updated;
  }
}
