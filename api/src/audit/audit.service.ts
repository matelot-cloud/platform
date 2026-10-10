import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { currentRequestContext } from '../common/request-context';
import { DATABASE, Database } from '../database/database.module';
import { auditEvents } from '../database/schema';
import { AuditEntry } from './audit.types';

@Injectable()
export class AuditService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(entry: AuditEntry): Promise<void> {
    const ctx = currentRequestContext();
    await this.db.insert(auditEvents).values({
      organizationId: entry.organizationId ?? null,
      actorType: entry.actor.type,
      actorId: entry.actor.id ?? null,
      actorLabel: entry.actor.label ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      requestId: ctx?.requestId ?? null,
      ipAddress: ctx?.ip ?? null,
    });
  }

  listForOrganization(organizationId: string, limit = 50, before?: Date) {
    return this.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.organizationId, organizationId), before ? lt(auditEvents.createdAt, before) : undefined))
      .orderBy(desc(auditEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }
}
