import { IdentityModule } from './identity/identity.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { UsageModule } from './usage/usage.module';
import { RateLimitInterceptor } from './common/rate-limit/rate-limit.interceptor';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { logSchema } from './telemetry/log-schema';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CryptoModule } from './common/crypto.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { JobsModule } from './jobs/jobs.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AppConfig, validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { IamModule } from './iam/iam.module';
import { MetaModule } from './meta/meta.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { EnvironmentsModule } from './environments/environments.module';
import { ExecutionModule } from './execution/execution.module';
import { InventoryModule } from './inventory/inventory.module';
import { OverviewModule } from './overview/overview.module';
import { PersonalTokenGuard } from './auth/personal-tokens/personal-token.guard';
import { PersonalTokensController } from './auth/personal-tokens/personal-tokens.controller';
import { OauthModule } from './oauth/oauth.module';
import { PersonalTokensModule } from './auth/personal-tokens/personal-tokens.module';
import { VulnerabilitiesModule } from './vulnerabilities/vulnerabilities.module';
import { PoliciesModule } from './policies/policies.module';
import { RemediationModule } from './remediation/remediation.module';
import { CraModule } from './cra/cra.module';
import { McpModule } from './mcp/mcp.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RiskModule } from './risk/risk.module';
import { RegistryModule } from './registry/registry.module';
import { SbomModule } from './sbom/sbom.module';
import { TokensModule } from './tokens/tokens.module';
import { ApiTokenGuard } from './tokens/api-token.guard';
import { ProjectsModule } from './projects/projects.module';
import { ServicesModule } from './services/services.module';
import { PermissionGuard } from './rbac/permission.guard';
import { RbacModule } from './rbac/rbac.module';
import { TeamsModule } from './teams/teams.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [IdentityModule, 
    OauthModule,
    PersonalTokensModule,
    McpModule,
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv, envFilePath: ['.env', '../../.env'] }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: AppConfig) => {
        const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
        return {
          pinoHttp: {
            ...logSchema({ component: 'api', cell: config.get('BOOTSTRAP_ORG_SLUG', { infer: true }), logLevel: config.get('LOG_LEVEL', { infer: true }), pretty: !isProduction }),
            genReqId: (req) => {
              const header = req.headers['x-request-id'];
              return (Array.isArray(header) ? header[0] : header) ?? randomUUID();
            },
            autoLogging: { ignore: (req) => (req.url ?? '').includes('/health/') },
          },
        };
      },
    }),
    DatabaseModule,
    TelemetryModule,
    CryptoModule,
    JobsModule,
    RbacModule,
    AuditModule,
    IamModule,
    AuthModule,
    HealthModule,
    MetaModule,
    OrganizationsModule,
    WorkspacesModule,
    TeamsModule,
    ProjectsModule,
    ServicesModule,
    EnvironmentsModule,
    IntegrationsModule,
    ExecutionModule,
    InventoryModule,
    TokensModule,
    SbomModule,
    RegistryModule,
    OverviewModule,
    VulnerabilitiesModule,
    PoliciesModule,
    RemediationModule,
    CraModule,
    NotificationsModule,
    RiskModule,
    AdminModule,
    UsageModule,
  ],
  controllers: [PersonalTokensController],
  providers: [
    // Order matters: authenticate first, then authorize.
    { provide: APP_GUARD, useClass: ApiTokenGuard },
    { provide: APP_GUARD, useClass: PersonalTokenGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // after the guards: the caller (user, CI token, runner) is known
    RateLimitInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: RateLimitInterceptor },
  ],
})
export class AppModule {}
