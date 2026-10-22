import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AppConfig } from '../config/env';
import { DATABASE, Database } from '../database/database.module';
import { backupReports, type BackupReport } from '../database/schema';

export interface BackupReportInput {
  status: 'succeeded' | 'failed';
  step?: string;
  startedAt?: number;          // unix seconds
  archive?: string;
  bytes?: number;
  destination?: string;
  error?: string;
}

const KEEP_DAYS = 180;

/**
 * Backup runs as the backup job reports them (deploy/helm/secops-cell/files/backup-report.sh, the Compose backup
 * service): stored, audited, and the source of matelot_backup_last_success_timestamp_seconds / _last_failure_… /
 * _last_duration_seconds (WorkerGauges) — the same gauges on Helm and on Compose.
 */
@Injectable()
export class BackupReportsService {
  private readonly token: string | undefined;
  constructor(@Inject(DATABASE) private readonly db: Database, private readonly audit: AuditService, @Inject(ConfigService) config: AppConfig) {
    this.token = config.get('BACKUP_REPORT_TOKEN', { infer: true }) || undefined;
  }

  /** `Authorization: Bearer <BACKUP_REPORT_TOKEN>`, compared in constant time; no token configured = no reports accepted. */
  isTokenValid(header: string | undefined): boolean {
    if (!this.token) return false;
    const given = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async record(input: BackupReportInput): Promise<BackupReport> {
    const clip = (v: string | undefined, n: number) => (v ? v.replace(/[\r\n]+/g, ' ').slice(0, n) : null);
    const [row] = await this.db.insert(backupReports).values({
      status: input.status,
      step: clip(input.step, 20),
      startedAt: input.startedAt && Number.isFinite(input.startedAt) ? new Date(input.startedAt * 1000) : null,
      archive: clip(input.archive?.split('/').pop(), 200),
      bytes: typeof input.bytes === 'number' && Number.isFinite(input.bytes) ? Math.max(0, Math.round(input.bytes)) : null,
      destination: clip(input.destination, 200),
      error: clip(input.error, 1000),
    }).returning();
    await this.db.delete(backupReports).where(lt(backupReports.finishedAt, sql`now() - make_interval(days => ${KEEP_DAYS})`));
    await this.audit.record({ organizationId: null, actor: { type: 'SYSTEM', label: 'backup' }, action: `backup.${row.status}`, resourceType: 'backup', resourceId: row.id, after: { archive: row.archive, bytes: row.bytes, destination: row.destination, step: row.step }, reason: row.error ?? undefined });
    return row;
  }

  /** The newest successful and failed runs (for the gauges and, later, Settings → Backups). */
  async latest(): Promise<{ success: BackupReport | null; failure: BackupReport | null }> {
    const pick = async (status: 'succeeded' | 'failed') => (await this.db.select().from(backupReports).where(and(eq(backupReports.status, status))).orderBy(desc(backupReports.finishedAt)).limit(1))[0] ?? null;
    return { success: await pick('succeeded'), failure: await pick('failed') };
  }
}
