import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { userActor } from '../audit/audit.types';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { DATABASE, Database } from '../database/database.module';
import { memberships, users } from '../database/schema';
import { UpdateUserAdminDto } from './dto/admin.dto';

/** Cell administration: only platform admins. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  assertAdmin(user: AuthenticatedUser): void {
    if (user.platformRole !== 'admin') throw new ForbiddenException('Cell administrators only');
  }

  async listUsers(actor: AuthenticatedUser) {
    this.assertAdmin(actor);
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        platformRole: users.platformRole,
        disabledAt: users.disabledAt,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        membershipCount: count(memberships.id),
      })
      .from(users)
      .leftJoin(memberships, eq(memberships.userId, users.id))
      .groupBy(users.id)
      .orderBy(asc(users.email));
    return rows;
  }

  async updateUser(actor: AuthenticatedUser, userId: string, dto: UpdateUserAdminDto) {
    this.assertAdmin(actor);
    const [before] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!before) throw new NotFoundException('User not found');

    const changes: Partial<typeof users.$inferInsert> = {};
    if (dto.platformRole && dto.platformRole !== before.platformRole) {
      if (before.id === actor.id && dto.platformRole !== 'admin') throw new ConflictException('You cannot remove your own administrator role');
      if (before.platformRole === 'admin' && dto.platformRole !== 'admin' && (await this.adminCount()) <= 1) throw new ConflictException('The cell must keep at least one administrator');
      changes.platformRole = dto.platformRole;
    }
    if (dto.enabled !== undefined) {
      if (!dto.enabled && before.id === actor.id) throw new ConflictException('You cannot disable your own account');
      changes.disabledAt = dto.enabled ? null : (before.disabledAt ?? new Date());
    }
    if (!Object.keys(changes).length) return this.publicView(before);

    const [after] = await this.db.update(users).set(changes).where(eq(users.id, userId)).returning();
    await this.audit.record({
      actor: userActor(actor),
      action: changes.platformRole ? 'user.platform_role_changed' : dto.enabled ? 'user.enabled' : 'user.disabled',
      resourceType: 'user',
      resourceId: userId,
      before: this.publicView(before),
      after: this.publicView(after),
      reason: dto.reason,
    });
    return this.publicView(after);
  }

  private async adminCount(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users).where(eq(users.platformRole, 'admin'));
    return Number(row?.n ?? 0);
  }

  private publicView(u: typeof users.$inferSelect) {
    return { id: u.id, email: u.email, displayName: u.displayName, platformRole: u.platformRole, disabledAt: u.disabledAt, lastLoginAt: u.lastLoginAt };
  }
}
