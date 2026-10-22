import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BackupReportsController } from './backup-reports.controller';
import { BackupReportsService } from './backup-reports.service';

@Module({ imports: [AuditModule], controllers: [BackupReportsController], providers: [BackupReportsService], exports: [BackupReportsService] })
export class BackupsModule {}
