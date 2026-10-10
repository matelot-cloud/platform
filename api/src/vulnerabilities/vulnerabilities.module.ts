import { Module } from '@nestjs/common';
import { RiskModule } from '../risk/risk.module';
import { ADVISORY_SOURCE, HttpAdvisorySource } from './advisory-source';
import { CodeFindingsService } from './code-findings.service';
import { CorrelationService } from './correlation.service';
import { FindingsService } from './findings.service';
import { SnapshotsService } from './snapshots.service';
import { VulnerabilitiesController } from './vulnerabilities.controller';

@Module({
  imports: [RiskModule],
  controllers: [VulnerabilitiesController],
  providers: [FindingsService, CodeFindingsService, CorrelationService, SnapshotsService, { provide: ADVISORY_SOURCE, useClass: HttpAdvisorySource }],
  exports: [FindingsService, CodeFindingsService, CorrelationService, SnapshotsService, ADVISORY_SOURCE],
})
export class VulnerabilitiesModule {}
