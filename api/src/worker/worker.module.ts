import { UsageService } from '../usage/usage.service';
import { IdentityModule } from '../identity/identity.module';
import { PersonalTokensModule } from '../auth/personal-tokens/personal-tokens.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../common/crypto.module';
import { AppConfig, validateEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { GithubAppClient } from '../integrations/github/github-app.client';
import { GithubSyncService } from '../integrations/github/github-sync.service';
import { SourceSyncService } from '../integrations/source-sync.service';
import { JobsService } from '../execution/jobs.service';
import { AutomationService } from '../execution/automation.service';
import { PipelinesService } from '../execution/pipelines.service';
import { PoolsService } from '../execution/pools.service';
import { InventoryService } from '../inventory/inventory.service';
import { RegistryService } from '../registry/registry.service';
import { SbomService } from '../sbom/sbom.service';
import { ADVISORY_SOURCE, HttpAdvisorySource } from '../vulnerabilities/advisory-source';
import { CorrelationService } from '../vulnerabilities/correlation.service';
import { SnapshotsService } from '../vulnerabilities/snapshots.service';
import { PoliciesService } from '../policies/policies.service';
import { ExceptionsService } from '../policies/exceptions.service';
import { RemediationService } from '../remediation/remediation.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RiskService } from '../risk/risk.service';
import { RbacModule } from '../rbac/rbac.module';
import { WorkerService } from './worker.service';

/** The worker process: consumes the job queues. Same code base and image as the API, different entrypoint. */
@Module({
  imports: [IdentityModule, NotificationsModule, PersonalTokensModule, 
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env', '../../.env'] }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          transport: config.get('NODE_ENV', { infer: true }) === 'production' ? undefined : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
    DatabaseModule,
    CryptoModule,
    AuditModule,
    RbacModule,
  ],
  providers: [GithubAppClient, GithubSyncService, SourceSyncService, PoolsService, PipelinesService, AutomationService, InventoryService, SbomService, RegistryService, JobsService, CorrelationService, SnapshotsService, PoliciesService, ExceptionsService, RemediationService, RiskService, UsageService, { provide: ADVISORY_SOURCE, useClass: HttpAdvisorySource }, WorkerService],
})
export class WorkerModule {}
