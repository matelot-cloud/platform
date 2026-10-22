import { drizzle } from 'drizzle-orm/node-postgres';
import { desc, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from '../database/schema';
import { BackupReportsService } from './backup-reports.service';
import { BackupReportsController } from './backup-reports.controller';
import { Metrics } from '../telemetry/metrics';
import { WorkerGauges } from '../telemetry/worker-gauges';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('backup reports (database): the backup job reports each run; the gauges come from the rows', () => {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const TOKEN = 'b'.repeat(48);
  const audited: string[] = [];
  const config = { get: (k: string) => (k === 'BACKUP_REPORT_TOKEN' ? TOKEN : undefined) };
  const service = new BackupReportsService(db as never, { record: async (e: { action: string }) => { audited.push(e.action); } } as never, config as never);
  const controller = new BackupReportsController(service);
  const ids: string[] = [];
  afterAll(async () => { for (const id of ids) await db.delete(schema.backupReports).where(eq(schema.backupReports.id, id)); await pool.end(); });

  it('rejects a missing or wrong token; no token configured accepts nothing', async () => {
    await expect(controller.report(undefined, { status: 'succeeded' })).rejects.toThrow(/Invalid backup report token/);
    await expect(controller.report('Bearer nope', { status: 'succeeded' })).rejects.toThrow(/Invalid backup report token/);
    const unconfigured = new BackupReportsService(db as never, { record: async () => undefined } as never, { get: () => undefined } as never);
    expect(unconfigured.isTokenValid(`Bearer ${TOKEN}`)).toBe(false);
  });

  it('stores runs (file name only, no path), audits them, and the worker gauges show the newest success / failure / duration', async () => {
    const started = Math.floor(Date.now() / 1000) - 42;
    const ok = await controller.report(`Bearer ${TOKEN}`, { status: 'succeeded', step: 'dump', startedAt: started, archive: '/backups/acme-20261022T020000Z.tar.gz', bytes: 123456, destination: 'pvc' });
    ids.push(ok.id);
    const bad = await controller.report(`Bearer ${TOKEN}`, { status: 'failed', step: 'upload', startedAt: started, destination: 's3://b/cells/acme', error: 'upload failed: AccessDenied\nline two' });
    ids.push(bad.id);
    const [row] = await db.select().from(schema.backupReports).where(eq(schema.backupReports.id, ok.id));
    expect(row!.archive).toBe('acme-20261022T020000Z.tar.gz');
    expect(row!.bytes).toBe(123456);
    const [failed] = await db.select().from(schema.backupReports).where(eq(schema.backupReports.id, bad.id));
    expect(failed!.error).toBe('upload failed: AccessDenied line two');
    expect(audited).toEqual(['backup.succeeded', 'backup.failed']);

    const metrics = new Metrics({ env: { APP_VERSION: 't', MATELOT_COMPONENT: 'worker' } as NodeJS.ProcessEnv });
    const gauges = new WorkerGauges(db as never, metrics);
    await gauges.refresh();
    const page = (await metrics.render('text/plain')).body;
    const newestOk = (await db.select().from(schema.backupReports).where(eq(schema.backupReports.status, 'succeeded')).orderBy(desc(schema.backupReports.finishedAt)).limit(1))[0]!;
    expect(page).toContain(`matelot_backup_last_success_timestamp_seconds ${Math.floor(newestOk.finishedAt.getTime() / 1000)}`);
    expect(page).toMatch(/^matelot_backup_last_failure_timestamp_seconds \d+$/m);
    expect(page).toMatch(/^matelot_backup_last_duration_seconds 4[0-9](\.\d+)?$/m);
    await metrics.close();
  });
});
